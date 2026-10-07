import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, test } from "vitest"
import Hub from "@server/core/hub"
import Gate from "@server/core/hub-gate"
import { TheLink } from "@the-link/core"
import { type RequestOutcome, unwrap } from "@libs/request-outcome"
import Assistant from "@server/core/assistant/assistant"
import type { AssistantTool } from "@server/core/assistant/assistant"
import assistantTools from "@server/core/assistant/tools"
import connectionTools from "@server/core/assistant/connection-tools"

const homes: string[] = []

const servers: Server[] = []

afterAll(function () {

    for (const server of servers) server.close()

    for (const directory of homes) {

        try { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
        catch { }
    }
})

function open(): Hub {

    const directory = mkdtempSync(join(tmpdir(), "seraph-conn-wire-"))

    homes.push(directory)

    const icons = { system: join(directory, "logo.png"), defaultProgram: join(directory, "icon.png") }

    return Hub.open(directory, icons)
}

function connect(hub: Hub) {

    const client = new TheLink()

    const gate = Gate.open(hub)

    client.$outbound.forwardTo(async function (event, ...values) {

        const [responseUuid, ...rest] = values as [string | null, ...unknown[]]

        gate.receive(String(event), typeof responseUuid === "string" ? responseUuid : null, ...rest)

        return []
    })

    gate.$outbound.forwardTo(async function (event, ...values) {

        await client.$inbound.publish(event, ...values)
    })

    function ask<Result>(event: string, ...values: unknown[]): Promise<Result> {

        const responseUuid = randomUUID()

        const reply = client.$inbound.waitFirst<RequestOutcome<unknown>>(responseUuid)

        client.$outbound.publish(event, responseUuid, ...values)

        return reply.then(outcome => unwrap(outcome) as Result)
    }

    return { client, gate, ask }
}

function captureTokens(connection: ReturnType<typeof connect>) {

    const tokens: string[] = []

    const stop = connection.client.$inbound.subscribe("/session/signed-in", value => {

        if (typeof value === "string") tokens.push(value)
    })

    return { tokens, stop }
}

async function bootstrapAdmin(connection: ReturnType<typeof connect>) {

    const { tokens, stop } = captureTokens(connection)

    const signedUp = await connection.ask<{ signedUp: true }>("/owner/sign-up", "root", "root-password-1")

    assert.deepEqual(signedUp, { signedUp: true })

    stop()

    assert.equal(tokens.length, 1, "the bootstrap connection received one session token")

    return tokens[0]!
}

/** A scripted model endpoint: first turn(s) issue tool calls, then answer in text. */
async function scriptModel(script: { deltas: Array<{ text?: string, toolCalls?: Array<{ id: string, name: string, arguments: string }> }> }[]) {

    let call = 0

    const server = createServer((request, response) => {

        let body = ""

        request.on("data", chunk => { body += chunk })

        request.on("end", function () {

            const step = script[call++] ?? { deltas: [] }

            const lines = step.deltas.map(function (delta) {

                const wire: Record<string, unknown> = {}

                if (delta.text) wire.content = delta.text

                if (delta.toolCalls) wire.tool_calls = delta.toolCalls.map(toolCall => ({

                    id: toolCall.id,

                    type: "function",

                    function: { name: toolCall.name, arguments: toolCall.arguments }
                }))

                return `data: ${JSON.stringify({ choices: [{ delta: wire }] })}\n`
            })

            response.writeHead(200, { "content-type": "text/event-stream" })

            response.end(lines.join("") + "data: [DONE]\n\n")
        })
    })

    servers.push(server)

    await new Promise((resolve: (value: unknown) => void) => server.listen(0, "127.0.0.1", resolve as () => void))

    const address = server.address()

    const port = typeof address === "object" && address ? address.port : 0

    return `http://127.0.0.1:${port}/v1`
}

/** A scripted JSON API the api_call tool points at; records everything it receives. */
async function scriptApi() {

    const seen: { path: string, method: string, auth: string | null, query: string, body: string }[] = []

    const server = createServer((request, response) => {

        let body = ""

        request.on("data", chunk => { body += chunk })

        request.on("end", () => {

            seen.push({
                path: request.url ?? "",
                method: request.method ?? "",
                auth: request.headers.authorization ?? null,
                query: new URL(request.url ?? "/", "http://x").search,
                body
            })

            response.writeHead(200, { "content-type": "application/json" })

            response.end(JSON.stringify({ ok: true, saw: request.headers.authorization ?? null }))
        })
    })

    servers.push(server)

    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve as () => void))

    const port = (server.address() as { port: number }).port

    return { seen, url: `http://127.0.0.1:${port}` }
}

async function spaceWithModel(hub: Hub, name: string, modelUrl: string) {

    const space = await hub.space(name)

    space.assistantMemory.clearConversation()

    // Swap the space's model endpoint for the scripted one so its tools run
    // over the real route layer.
    const store = space.connections

    const tools: AssistantTool[] = [

        ...assistantTools(space as never),

        ...connectionTools(space as never, store)
    ]

    const assistant = Assistant.open(

        { baseUrl: modelUrl, apiKey: "sk-test", model: "test-model", embedModel: "test-embed" },

        space.assistantMemory,

        tools
    )!

    ;(space as unknown as { assistantInstance: Assistant | null }).assistantInstance = assistant

    return space
}

async function waitPending(space: Awaited<ReturnType<Hub["space"]>>) {

    const confirmManager = space.authManager.assistantConfirmManager

    for (let waited = 0; confirmManager.requests().length === 0 && waited < 5000; waited += 20) {

        await new Promise(resolve => setTimeout(resolve, 20))
    }

    return confirmManager.requests()
}

test("routes list, save, and remove with the session verified; secrets never echo", async () => {

    const hub = open()

    const admin = connect(hub)

    const token = await bootstrapAdmin(admin)

    const space = await hub.space("root")

    const saved = await admin.ask<{ saved: { name: string, hasKey: boolean, endpoint: string } }[]>("/auth/connections/save", token, "crm", "api", "https://crm.example.com", "sk-live-999")

    const savedView = saved[0]!.saved

    assert.equal(savedView.name, "crm")

    assert.equal(savedView.hasKey, true)

    const listed = (await admin.ask<{ name: string, hasKey: boolean }[][]>("/auth/connections/list", token))[0]!

    assert.equal(listed.length, 1)

    assert.equal(listed[0]!.name, "crm")

    assert.equal(listed[0]!.hasKey, true)

    const testedWrap = await admin.ask<{ view: { name: string, token?: string } }[]>("/auth/connections/test", token, "crm")

    const tested = testedWrap[0]!.view

    assert.equal(tested.name, "crm")

    assert.equal("token" in tested, false, "the tested view carries no secret field")

    assert.equal(JSON.stringify(testedWrap).includes("sk-live-999"), false, "no secret substring anywhere in the route answer")

    const removedWrap = await admin.ask<{ removed: boolean }[]>("/auth/connections/remove", token, "crm")

    assert.equal(removedWrap[0]!.removed, true)

    assert.equal(space.connections.list().length, 0)

    // Bogus session tokens refuse at the same routes.
    await assert.rejects(() => admin.ask("/auth/connections/list", "bogus-token"))

    space.close()
})

test("connections are per-space: another user's routes and tools never see them", async () => {

    const hub = open()

    const admin = connect(hub)

    const token = await bootstrapAdmin(admin)

    const space = await hub.space("root")

    await admin.ask("/auth/connections/save", token, "mine", "api", "https://mine.example.com", null)

    // A second space, reached through its own connection store and tools.
    const other = await hub.space("duo")

    const otherTools = connectionTools(other as never, other.connections)

    const list = await (otherTools.find(tool => tool.name === "connections_list")!).execute({})

    assert.equal((list as { connections: unknown[] }).connections.length, 0, "the other space's list is empty")

    let refusal = ""

    try { await (otherTools.find(tool => tool.name === "api_call")!).execute({ connection: "mine", path: "/x" }) }

    catch (exception) { refusal = (exception as Error).message }

    assert.match(refusal, /does not exist/)

    const routeListWrap = await admin.ask<{ name: string }[][]>("/auth/connections/list", token)

    assert.equal(routeListWrap[0]!.every(entry => entry.name === "mine"), true, "the admin's own route list carries only its own space's connection")

    space.close()

    other.close()
})

test("api_call merges the saved endpoint and secret server-side; model params cannot smuggle credentials; GET carries no body", async () => {

    const hub = open()

    const admin = connect(hub)

    const token = await bootstrapAdmin(admin)

    const space = await hub.space("root")

    const api = await scriptApi()

    await admin.ask("/auth/connections/save", token, "crm", "api", `${api.url}/`, "sk-live-777")

    const tools = connectionTools(space as never, space.connections)

    const call = (tools.find(tool => tool.name === "api_call")!).execute as (a: Record<string, unknown>) => Promise<unknown>

    const answer = await call({ connection: "crm", path: "/v1/contacts", query: { limit: "5" } }) as { status: number, body: string }

    assert.equal(answer.status, 200)

    assert.equal(api.seen.length, 1)

    assert.equal(api.seen[0]!.path, "/v1/contacts?limit=5")

    assert.equal(api.seen[0]!.auth, "Bearer sk-live-777", "the saved secret rode server-side")

    assert.equal(api.seen[0]!.method, "GET")

    assert.equal(api.seen[0]!.body, "", "a GET carries no body")

    // A model trying to swap the credential is refused outright.
    await assert.rejects(() => call({ connection: "crm", path: "/v1/contacts", query: { authorization: "Bearer evil" } }), /not allowed/)

    await assert.rejects(() => call({ connection: "crm", path: "/v1/contacts", query: { api_key: "evil" } }), /not allowed/)

    // A connection without a secret sends no authorization at all.
    await admin.ask("/auth/connections/save", token, "plain", "api", `${api.url}/`, null)

    const answer2 = await call({ connection: "plain", path: "/ping" }) as { status: number }

    assert.equal(answer2.status, 200)

    assert.equal(api.seen[1]!.auth, null, "no secret, no authorization header")

    space.close()
})

test("mcp tools work through the assistant's catalog: list is read-only, call pauses until Allow, Deny calls nothing", async () => {

    const hub = open()

    const admin = connect(hub)

    const token = await bootstrapAdmin(admin)

    // A scripted MCP server recording every tools/call.
    const mcpCalls: string[] = []

    const mcp = createServer((request, response) => {

        let body = ""

        request.on("data", chunk => { body += chunk })

        request.on("end", () => {

            const parsed = JSON.parse(body)

            const reply = (payload: unknown) => {

                response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" })

                response.end(JSON.stringify(payload))
            }

            if (parsed.method === "initialize") reply({ jsonrpc: "2.0", id: parsed.id, result: { protocolVersion: "2025-06-18", capabilities: {} } })

            else if (parsed.method === "notifications/initialized") { response.writeHead(202); response.end() }

            else if (parsed.method === "tools/list") reply({ jsonrpc: "2.0", id: parsed.id, result: { tools: [{ name: "remote_echo", inputSchema: { type: "object" } }] } })

            else if (parsed.method === "tools/call") {

                mcpCalls.push(String(parsed.params?.name))

                reply({ jsonrpc: "2.0", id: parsed.id, result: { content: [{ type: "text", text: "remote did it" }] } })
            }

            else { response.writeHead(200, { "content-type": "application/json" }); response.end("{}") }
        })
    })

    servers.push(mcp)

    await new Promise(resolve => mcp.listen(0, "127.0.0.1", resolve as () => void))

    const mcpPort = (mcp.address() as { port: number }).port

    const space = await spaceWithModel(hub, "root", await scriptModel([

        // Turn 1: mcp_list_tools then mcp_call_tool in one round.
        { deltas: [{ toolCalls: [{ id: "c1", name: "mcp_list_tools", arguments: `{"connection":"bridge"}` }] }] },

        { deltas: [{ toolCalls: [{ id: "c2", name: "mcp_call_tool", arguments: `{"connection":"bridge","tool":"remote_echo","arguments":{"x":1}}` }] }] },

        // Turn 2 (after Allow) completes; a third answers after Deny of the next ask... simpler: answer now.
        { deltas: [{ text: "The remote tool said: " }, { text: "remote did it" }] }
    ]))

    await admin.ask("/auth/connections/save", token, "bridge", "mcp", `http://127.0.0.1:${mcpPort}/rpc`, null)

    const streamed: string[] = []

    const stop = admin.client.$inbound.subscribe("/auth/assistant/chunk", value => {

        if (typeof value === "string") streamed.push(value)
    })

    const turn = admin.ask<string[]>("/auth/assistant/turn", token, "use the bridge")

    const pending = await waitPending(space)

    assert.equal(pending.length, 1, "the mcp_call_tool ask is pending")

    assert.equal(pending[0]!.tool, "mcp_call_tool")

    assert.equal(mcpCalls.length, 0, "nothing reached the remote server before Allow")

    await admin.ask<boolean[]>("/auth/assistant-confirm/allow", token, pending[0]!.identity)

    await turn

    stop()

    assert.equal(mcpCalls.length, 1, "exactly one remote call happened, after Allow")

    assert.equal(mcpCalls[0], "remote_echo")

    space.close()
})

test("a denied mcp_call_tool never reaches the server and the model reads the refusal", async () => {

    const hub = open()

    const admin = connect(hub)

    const token = await bootstrapAdmin(admin)

    const mcpCalls: string[] = []

    const mcp = createServer((request, response) => {

        let body = ""

        request.on("data", chunk => { body += chunk })

        request.on("end", () => {

            const parsed = JSON.parse(body)

            const reply = (payload: unknown) => {

                response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-deny" })

                response.end(JSON.stringify(payload))
            }

            if (parsed.method === "initialize") reply({ jsonrpc: "2.0", id: parsed.id, result: { protocolVersion: "2025-06-18", capabilities: {} } })

            else if (parsed.method === "notifications/initialized") { response.writeHead(202); response.end() }

            else if (parsed.method === "tools/call") {

                mcpCalls.push(String(parsed.params?.name))

                reply({ jsonrpc: "2.0", id: parsed.id, result: { content: [{ type: "text", text: "should not happen" }] } })
            }

            else { response.writeHead(200, { "content-type": "application/json" }); response.end("{}") }
        })
    })

    servers.push(mcp)

    await new Promise(resolve => mcp.listen(0, "127.0.0.1", resolve as () => void))

    const mcpPort = (mcp.address() as { port: number }).port

    const space = await spaceWithModel(hub, "root", await scriptModel([

        { deltas: [{ toolCalls: [{ id: "d1", name: "mcp_call_tool", arguments: `{"connection":"bridge","tool":"danger"}` }] }] },

        { deltas: [{ text: "The user declined the remote call." }] }
    ]))

    await admin.ask("/auth/connections/save", token, "bridge", "mcp", `http://127.0.0.1:${mcpPort}/rpc`, null)

    const streamed: string[] = []

    const stop = admin.client.$inbound.subscribe("/auth/assistant/chunk", value => {

        if (typeof value === "string") streamed.push(value)
    })

    const turn = admin.ask<string[]>("/auth/assistant/turn", token, "call danger")

    const pending = await waitPending(space)

    await admin.ask<boolean[]>("/auth/assistant-confirm/deny", token, pending[0]!.identity)

    await turn

    stop()

    assert.equal(mcpCalls.length, 0, "a denied call never reached the server")

    assert.deepEqual(streamed, ["The user declined the remote call.", ""], "the model answered from the refusal (done sentinel included)")

    space.close()
})

test("web_fetch fetches a public page and refuses private ones, through the assistant catalog", async () => {

    const hub = open()

    const admin = connect(hub)

    await bootstrapAdmin(admin)

    const space = await hub.space("root")

    const tools = connectionTools(space as never, space.connections)

    const fetchTool = (tools.find(tool => tool.name === "web_fetch")!).execute as (a: Record<string, unknown>) => Promise<unknown>

    // The real statement: private literals refuse with the guard's words.
    let message = ""

    try { await fetchTool({ url: "http://127.0.0.1:9/" }) }
    catch (exception) { message = String((exception as Error).message) }

    assert.match(message, /loopback|private/)

    // A public URL through the full guard: resolved and fetched. example.com
    // is IANA-reserved but publicly resolvable; this is the one network call
    // in the suite and it asserts body + content type arrive.
    const answer = await fetchTool({ url: "https://example.com/" }) as { status: number, body: string | null, contentType: string }

    assert.equal(answer.status, 200)

    assert.equal(answer.contentType, "text/html")

    assert.ok((answer.body ?? "").includes("example"), "the body arrived")

    space.close()
})

test("with no model configured the space has no assistant and nothing connectivity-shaped exists", async () => {

    const hub = open()

    const admin = connect(hub)

    const token = await bootstrapAdmin(admin)

    const space = await hub.space("fresh")

    assert.equal(space.assistant, null, "no assistant without an endpoint")

    // The routes still answer (manage connections before a model exists),
    // so the dialog-to-be can work without a model configured.
    const views = (await admin.ask<{ name: string }[][]>("/auth/connections/list", token))[0]!

    assert.deepEqual(views, [])

    space.close()
})
