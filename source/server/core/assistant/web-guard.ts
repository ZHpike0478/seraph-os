import { lookup } from "node:dns"
import { isIP } from "node:net"

/**
 * The outbound URL guard for web_fetch: the assistant may fetch public web
 * pages, never the hosting machine's own network positions - loopback, the
 * LAN, link-local addresses (including every cloud provider's instance
 * metadata service), or any non-web scheme. The guard checks the literal
 * host first, then resolves and checks every address, then re-validates at
 * every redirect hop.
 *
 * Known residual (deliberate): the classic DNS-rebinding TOCTOU window -
 * resolution here and the connection's own resolution are separate events,
 * so a hostile authoritative DNS server can still win. This guard covers
 * the model choosing a URL it should not; it is not a firewall.
 */

export interface FetchOutcome {

    status: number

    contentType: string

    /** The body as text when the content type is text-ish and small enough. */
    body: string | null

    truncated: boolean

    url: string

    bytes: number
}

const maximumBody = 512 * 1024

/** Whether a response content type is worth handing to a model as text. */
export function contentIsTextish(contentType: string): boolean {

    return contentType.startsWith("text/")
        || contentType === "application/json"
        || contentType.endsWith("+json")
        || contentType === "application/javascript"
        || contentType === "application/xml"
        || contentType === "application/x-yaml"
}

const maximumRedirects = 4

function privateIPv4(address: string): boolean {

    const octets = address.split(".").map(value => Number(value))

    if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return true

    const [a, b] = octets as [number, number, number, number]

    if (a === 0 || a === 10 || a === 127) return true

    if (a === 169 && b === 254) return true

    if (a === 172 && b >= 16 && b <= 31) return true

    if (a === 192 && b === 168) return true

    if (a === 100 && b >= 64 && b <= 127) return true

    if (a >= 224) return true

    return false
}

function privateIPv6(address: string): boolean {

    const low = address.toLowerCase()

    if (low === "::" || low === "::1") return true

    if (low.startsWith("fe80") || low.startsWith("fc") || low.startsWith("fd")) return true

    if (low.startsWith("ff")) return true

    // IPv4-mapped addresses (::ffff:a.b.c.d) judge by their IPv4 half.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low)

    if (mapped) return privateIPv4(mapped[1]!)

    return false
}

/** Judges one literal address; unknown forms fail closed. */
export function addressIsPrivate(address: string): boolean {

    const family = isIP(address)

    if (family === 4) return privateIPv4(address)

    if (family === 6) return privateIPv6(address)

    return true
}

/** Validates one URL's scheme and literal host; resolution is separate. */
export function urlAllowsHost(url: URL): void {

    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("web_fetch speaks http and https only")

    if (url.username || url.password) throw new Error("web_fetch does not fetch URLs carrying credentials")

    const host = url.hostname

    if (!host) throw new Error("web_fetch needs a host")

    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("web_fetch does not fetch local names")

    if (isIP(host)) {

        if (addressIsPrivate(host)) throw new Error("web_fetch does not fetch private or loopback addresses")
    }
}

/** Resolves one hostname and refuses when any address is private. */
export function resolvePublicHost(hostname: string): Promise<void> {

    return new Promise((resolve, reject) => {

        lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {

            if (error) return reject(new Error(`web_fetch could not resolve ${hostname}`))

            if (addresses.length === 0) return reject(new Error(`web_fetch could not resolve ${hostname}`))

            for (const entry of addresses) {

                if (addressIsPrivate(entry.address)) return reject(new Error("web_fetch does not fetch hosts resolving to private or loopback addresses"))
            }

            resolve()
        })
    })
}

/** The guard for one hop: scheme, literal host, then resolution. */
export async function guardUrl(url: URL): Promise<void> {

    urlAllowsHost(url)

    if (!isIP(url.hostname)) await resolvePublicHost(url.hostname)
}

/** Fetches one public URL with the full guard and a size cap. */
export async function guardedFetch(rawUrl: unknown): Promise<FetchOutcome> {

    if (typeof rawUrl !== "string" || !rawUrl.trim()) throw new Error("web_fetch needs a URL")

    let current: URL

    try { current = new URL(rawUrl.trim()) }
    catch { throw new Error("web_fetch needs a valid URL") }

    for (let hop = 0; hop <= maximumRedirects; hop++) {

        await guardUrl(current)

        const response = await fetch(current, {

            method: "GET",

            headers: { "accept": "text/plain, text/markdown, application/json;q=0.9, text/html;q=0.5" },

            redirect: "manual",

            signal: AbortSignal.timeout(60_000),

            // No credentials of any kind follow a model-chosen URL.
            credentials: "omit"
        })

        if (response.status >= 300 && response.status < 400) {

            const location = response.headers.get("location")

            await response.body?.cancel()

            if (!location) throw new Error(`The fetch answered ${response.status} without a location`)

            let next: URL

            try { next = new URL(location, current) }
            catch { throw new Error("The fetch redirect target is not a valid URL") }

            current = next

            if (hop === maximumRedirects) throw new Error("The fetch redirected too many times")

            continue
        }

        if (!response.ok) throw new Error(`The fetch answered ${response.status}`)

        const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim()

        const reader = response.body!.getReader()

        const chunks: Uint8Array[] = []

        let size = 0

        let truncated = false

        while (true) {

            const { done, value } = await reader.read()

            if (done) break

            size += value.byteLength

            if (size > maximumBody) {

                await reader.cancel()

                truncated = true

                break
            }

            chunks.push(value)
        }

        const textish = contentIsTextish(contentType)

        const kept = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)

        return {
            status: response.status,
            contentType,
            body: textish ? chunksToText(chunks) : null,
            truncated,
            url: current.toString(),
            bytes: kept
        }
    }

    throw new Error("The fetch redirected too many times")
}

function chunksToText(chunks: Uint8Array[]): string {

    return chunks.map(chunk => new TextDecoder().decode(chunk)).join("")
}
