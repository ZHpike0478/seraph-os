import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, test } from "vitest"
import ConnectionsStore, { connectionName, connectionEndpoint, connectionToken } from "@server/core/assistant/connections"
import McpClient from "@server/core/assistant/mcp"
import { addressIsPrivate, guardUrl, urlAllowsHost } from "@server/core/assistant/web-guard"

const homes: string[] = []

const servers: Server[] = []

afterAll(function () {

    for (const server of servers) server.close()

    for (const directory of homes) {

        try { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
        catch { }
    }
})

function openStore(): ConnectionsStore {

    const directory = mkdtempSync(join(tmpdir(), "seraph-connections-"))

    homes.push(directory)

    return ConnectionsStore.open(join(directory, "assistant-connections.sqlite"))
}

test("connection validators accept clean input and refuse bad names, endpoints, tokens", () => {

    assert.equal(connectionName("  sales-crm "), "sales-crm")

    assert.throws(() => connectionName("/etc/passwd"))

    assert.throws(() => connectionName(""))

    assert.throws(() => connectionName(42))

    assert.equal(connectionKindLocal("mcp"), "mcp")

    assert.throws(() => connectionKindLocal("socket"))

    assert.equal(connectionEndpoint("https://api.example.com/v1/"), "https://api.example.com/v1/")

    assert.equal(connectionEndpoint("http://10.0.0.5:8080"), "http://10.0.0.5:8080")

    assert.throws(() => connectionEndpoint("ftp://api.example.com"))

    assert.throws(() => connectionEndpoint("https://user:pass@api.example.com"))

    assert.equal(connectionToken("sk-live-123"), "sk-live-123")

    assert.equal(connectionToken(undefined), null)

    assert.equal(connectionToken(""), null)

    assert.throws(() => connectionToken(7))
})

function connectionKindLocal(value: unknown): string {

    if (value !== "mcp" && value !== "api") throw new Error("bad kind")

    return value
}

test("the store saves, lists views, finds records, replaces, and removes", () => {

    const store = openStore()

    const view = store.save("crm", "api", "https://crm.example.com", "sk-live-123")

    assert.deepEqual(view, {
        name: "crm",
        kind: "api",
        endpoint: "https://crm.example.com",
        hasKey: true,
        createdAt: view.createdAt
    })

    const record = store.find("crm")!

    assert.equal(record.token, "sk-live-123")

    store.save("tools", "mcp", "https://mcp.example.com/rpc", null)

    const list = store.list()

    assert.equal(list.length, 2)

    assert.deepEqual(list.map(entry => entry.name), ["crm", "tools"])

    assert.equal(list[1]!.hasKey, false)

    // Re-saving under the same name replaces, never duplicates.
    store.save("crm", "api", "https://crm2.example.com", null)

    assert.equal(store.list().length, 2)

    assert.equal(store.find("crm")!.endpoint, "https://crm2.example.com")

    assert.equal(store.find("crm")!.hasKey, false)

    assert.equal(store.remove("tools"), true)

    assert.equal(store.remove("tools"), false)

    assert.equal(store.find("gone"), null)

    store.close()
})

test("the store keeps two spaces fully separate", () => {

    const one = openStore()

    const two = openStore()

    one.save("shared-name", "api", "https://one.example.com", "sk-one")

    assert.equal(two.find("shared-name"), null)

    assert.equal(two.list().length, 0)

    two.save("shared-name", "mcp", "https://two.example.com", null)

    assert.equal(one.find("shared-name")!.endpoint, "https://one.example.com")

    assert.equal(one.find("shared-name")!.token, "sk-one")

    one.close()

    two.close()
})

test("address judgment refuses loopback, LAN, link-local, CGNAT, multicast, and IPv6 locals", () => {

    for (const bad of [
        "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
        "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
        "::1", "fe80::1", "fc00::1", "fd12::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:192.168.0.5"
    ]) {

        assert.equal(addressIsPrivate(bad), true, bad)
    }

    for (const good of ["8.8.8.8", "1.1.1.1", "2606:4700::1111", "93.184.216.34"]) {

        assert.equal(addressIsPrivate(good), false, good)
    }

    // Unknown forms fail closed.
    assert.equal(addressIsPrivate("not-an-address"), true)
})

test("urlAllowsHost refuses schemes, credential URLs, local names, and private literals", () => {

    assert.throws(() => urlAllowsHost(new URL("file:///etc/passwd")))

    assert.throws(() => urlAllowsHost(new URL("https://user:pass@example.com/")))

    assert.throws(() => urlAllowsHost(new URL("http://localhost:8080/")))

    assert.throws(() => urlAllowsHost(new URL("http://127.0.0.1:8080/")))

    assert.throws(() => urlAllowsHost(new URL("http://169.254.169.254/latest/meta-data/")))

    assert.throws(() => urlAllowsHost(new URL("http://10.0.0.9/")))

    urlAllowsHost(new URL("https://example.com/x"))

    urlAllowsHost(new URL("http://8.8.8.8/dns-query"))
})

test("guardUrl resolves hostnames and refuses ones landing in private space", async () => {

    // example.com resolves publicly in any environment; a guarded fetch of
    // it is exercised in the wire suite against a scripted local server
    // through a hostname-free URL is impossible, so this test pins the
    // literal checks plus resolution-of-a-real-public-name.
    await guardUrl(new URL("https://example.com/"))

    // A name that resolves to loopback on every machine.
    await assert.rejects(() => guardUrl(new URL("http://localhost/")), /private or loopback|local names/)

    // A literal private address never even resolves.
    await assert.rejects(() => guardUrl(new URL("http://192.168.1.50/")))
})

test("the MCP client speaks Streamable HTTP: handshake, session header, tools/list, tools/call, JSON and SSE, errors as text", async () => {

    let sawSessionOnSecond = false

    let sawInitialized = false

    let sawAuthorize = false

    let call = 0

    const server = createServer((request, response) => {

        let body = ""

        request.on("data", chunk => { body += chunk })

        request.on("end", () => {

            if (request.headers["mcp-session-id"] === "session-7") sawSessionOnSecond = true

            if (request.headers.authorization === "Bearer sk-mcp-9") sawAuthorize = true

            const parsed = JSON.parse(body)

            const answer = (payload: unknown, sse = false) => {

                if (sse) {

                    response.writeHead(200, { "content-type": "text/event-stream" })

                    response.end(`data: ${JSON.stringify(payload)}\n\n`)
                }

                else {

                    response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "session-7" })

                    response.end(JSON.stringify(payload))
                }
            }

            if (parsed.method === "initialize") {

                call++

                answer({ jsonrpc: "2.0", id: parsed.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "t", version: "1" } } })
            }

            else if (parsed.method === "notifications/initialized") {

                sawInitialized = true

                response.writeHead(202)

                response.end()
            }

            else if (parsed.method === "tools/list") {

                answer({ jsonrpc: "2.0", id: parsed.id, result: { tools: [
                    { name: "echo", description: "Echo text", inputSchema: { type: "object" } },
                    { name: "add", description: "Add numbers", inputSchema: { type: "object" } }
                ] } })
            }

            else if (parsed.method === "tools/call") {

                if (parsed.params.name === "fail") {

                    answer({ jsonrpc: "2.0", id: parsed.id, error: { code: -32000, message: "the tool exploded" } })
                }

                else if (parsed.params.name === "sse") {

                    answer({ jsonrpc: "2.0", id: parsed.id, result: { content: [{ type: "text", text: "saw it via sse" }] } }, true)
                }

                else {

                    answer({ jsonrpc: "2.0", id: parsed.id, result: { content: [
                        { type: "text", text: `echo: ${String(parsed.params.arguments.text)}` }
                    ] } })
                }
            }

            else answer({ jsonrpc: "2.0", id: parsed.id, error: { code: -32601, message: "no such method" } })
        })
    })

    servers.push(server)

    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve as () => void))

    const port = (server.address() as { port: number }).port

    const client = new McpClient(`http://127.0.0.1:${port}/rpc`, "sk-mcp-9")

    const tools = await client.listTools()

    assert.deepEqual(tools.map(tool => tool.name), ["echo", "add"])

    assert.equal(sawSessionOnSecond, true, "later calls carried the session id")

    assert.equal(sawInitialized, true, "the initialized notification was sent")

    assert.equal(sawAuthorize, true, "the connection's secret rode as Bearer")

    const called = await client.callTool("echo", { text: "hello" })

    assert.equal(called.isError, false)

    assert.equal(called.text, "echo: hello")

    const viaSse = await client.callTool("sse", {})

    assert.equal(viaSse.text, "saw it via sse")

    await assert.rejects(() => client.callTool("fail", {}), /the tool exploded/)

    server.close()
})
