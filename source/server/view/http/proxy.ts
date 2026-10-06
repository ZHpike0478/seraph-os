import { type ProxyOutcome, type ProxyRequest, type ProxyResponse, proxyMediaType } from "@server/core/protocol/proxy"
import { frame, unframe } from "@libs/framing"
import Hub from "@server/core/hub"
import { Hono } from "hono"

/** The authorized HTTP door for server-side System fetch, per account-space. */
export default function (hub: Hub) {

    const proxy = new Hono()

    proxy.post("/", async function (context) {

        const authorization = context.req.header("authorization")

        const space = await hub.spaceForTokenByHeader(authorization).catch(() => null)

        if (!space) return context.text("Unauthorized", 401)

        let request: Awaited<ReturnType<typeof unframe<ProxyRequest>>>

        try {

            request = await unframe<ProxyRequest>(context.req.raw.body)
        }

        catch (exception) {

            return context.text(exception instanceof Error ? exception.message : "The proxy request is invalid", 400)
        }

        let outcome: ProxyOutcome

        let responseBody: ReadableStream<Uint8Array> | null = null

        try {

            const metadata = request.metadata

            const response = await space.authManager.fetch(authorization, metadata.url, {

                body: metadata.body ? request.body : undefined,
                cache: metadata.cache,
                credentials: metadata.credentials,
                headers: metadata.headers,
                integrity: metadata.integrity,
                keepalive: metadata.keepalive,
                method: metadata.method,
                mode: metadata.mode,
                redirect: metadata.redirect,
                referrer: metadata.referrer,
                referrerPolicy: metadata.referrerPolicy,
                signal: context.req.raw.signal,
                ...metadata.body ? { duplex: "half" } : {}
            } as RequestInit & { duplex?: "half" })

            const responseMetadata: ProxyResponse = {

                body: response.body !== null,
                headers: responseHeaders(response.headers),
                redirected: response.redirected,
                status: response.status,
                statusText: response.statusText,
                type: response.type,
                url: response.url
            }

            outcome = { response: responseMetadata }

            responseBody = response.body
        }

        catch (exception) {

            outcome = { error: asError(exception) }

            if (outcome.error.name === "AbortError") outcome.error = { ...outcome.error, message: "The proxy request was aborted" }
        }

        const framed = frame(outcome, responseBody)

        return new Response(framed, {

            headers: {

                "cache-control": "no-store",

                "content-type": proxyMediaType
            },

            status: 200
        })
    })

    return proxy
}

function responseHeaders(headers: Headers): [string, string][] {

    const values = [...headers.entries()].filter(([name]) =>

        // A proxy answer never carries the transport's own hop-by-hop names,
        // and one cookie header per value survives through getSetCookie.
        !/^(transfer-encoding|content-encoding|content-length|connection|keep-alive)$/i.test(name)
    ) as [string, string][]

    const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie

    if (getSetCookie) for (const value of getSetCookie.call(headers)) values.push(["set-cookie", value])

    return values
}

function asError(exception: unknown): ProxyOutcome extends { error: infer E } ? E : never {

    return {

        message: exception instanceof Error ? exception.message : "The request failed",

        name: exception instanceof Error ? exception.name : "TypeError"
    } as never
}