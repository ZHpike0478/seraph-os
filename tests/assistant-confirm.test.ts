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

    const directory = mkdtempSync(join(tmpdir(), "seraph-confirm-"))

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

    /** One correlated request: the payload is the unwrapped route value; a bound relay answers with the results array. */
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
async function scriptEndpoint(script: { deltas: Array<{ text?: string, toolCalls?: Array<{ id: string, name: string, arguments: string }> }> }[]) {

    let call = 0

    const bodies: string[] = []

    const server = createServer((request, response) => {

        let body = ""

        request.on("data", chunk => { body += chunk })

        request.on("end", function () {

            bodies.push(body)

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

    return {

        url: `http://127.0.0.1:${port}/v1`,

        bodies,

        stop: () => server.close()
    }
}

function openSpaceAssistant(endpointUrl: string, tools: AssistantTool[], memory: import("@server/core/assistant/memory").default) {

    return Assistant.open({ baseUrl: endpointUrl, apiKey: "test-key", embedModel: "test-embed", model: "test-model" }, memory, tools)!
}

/** Mounts the scripted assistant as the space's own, so its streaming route drives it. */
function mountSpaceAssistant(space: Awaited<ReturnType<Hub["space"]>>, assistant: Assistant) {

    (space as unknown as { assistantInstance: Assistant | null }).assistantInstance = assistant
}

async function waitPending(space: Awaited<ReturnType<Hub["space"]>>) {

    const confirmManager = space.authManager.assistantConfirmManager

    for (let waited = 0; confirmManager.requests().length === 0 && waited < 5000; waited += 20) {

        await new Promise(resolve => setTimeout(resolve, 20))
    }

    return confirmManager.requests()
}
test("a files_write ask pauses, then Allow writes the file and the turn answers", async () => {

    const hub = open()

    const admin = connect(hub)

    const adminToken = await bootstrapAdmin(admin)

    const space = await hub.space("root")

    space.assistantMemory.clearConversation()

    const tools = assistantTools(space)

    const endpoint = await scriptEndpoint([

        {

            deltas: [

                { toolCalls: [{ id: "call-1", name: "files_write", arguments: "" }] },

                { toolCalls: [{ id: "call-1", name: "", arguments: `{"path":["notes","hello.txt"],"content":"hello seraph"}` }] }
            ]
        },

        { deltas: [{ text: "The file " }, { text: "is written." }] }
    ])

    const assistant = openSpaceAssistant(endpoint.url, tools, space.assistantMemory)

    mountSpaceAssistant(space, assistant)

    // The turn runs through the space's own streaming route, exactly as a chat window asks.
    const streamed: string[] = []

    const stop = admin.client.$inbound.subscribe("/auth/assistant/chunk", value => {

        if (typeof value === "string") streamed.push(value)
    })

    const turn = admin.ask<string[]>("/auth/assistant/turn", adminToken, "write hello.txt please")

    const pending = await waitPending(space)

    assert.equal(pending.length, 1, "the write ask is pending")

    assert.equal(pending[0]!.tool, "files_write")

    assert.match(pending[0]!.summary, /notes\/hello\.txt/)

    assert.ok(pending[0]!.createdAt.getTime())

    assert.equal(space.home.stat(["notes", "hello.txt"]), null, "no file before Allow")

    await admin.ask<boolean[]>("/auth/assistant-confirm/allow", adminToken, pending[0]!.identity)

    const reply = (await turn)[0]!

    stop()

    assert.equal(reply, "The file is written.")

    assert.deepEqual(streamed, ["The file ", "is written.", ""], "the reply streamed to the connection")

    const written = space.home.stat(["notes", "hello.txt"])

    assert.ok(written && written.kind === "file", "the file exists after Allow")

    assert.equal(endpoint.bodies.length, 2)

    const second = JSON.parse(endpoint.bodies[1]!)

    const toolMessage = second.messages.find((message: { role: string }) => message.role === "tool")

    assert.match(toolMessage.content, /written/)

    assert.equal(space.authManager.assistantConfirmManager.requests().length, 0, "nothing stays pending after Allow")
})

test("Deny leaves nothing written and the model reads plain refusal", async () => {

    const hub = open()

    const admin = connect(hub)

    const adminToken = await bootstrapAdmin(admin)

    const space = await hub.space("root")

    space.assistantMemory.clearConversation()

    const tools = assistantTools(space)

    const endpoint = await scriptEndpoint([

        { deltas: [{ toolCalls: [{ id: "call-2", name: "files_write", arguments: `{"path":["notes","no.txt"],"content":"should not exist"}` }] }] },

        { deltas: [{ text: "I will not " }, { text: "write it." }] }
    ])

    const assistant = openSpaceAssistant(endpoint.url, tools, space.assistantMemory)

    mountSpaceAssistant(space, assistant)

    const turn = admin.ask<string[]>("/auth/assistant/turn", adminToken, "write it")

    const identity = (await waitPending(space))[0]!.identity

    await admin.ask<boolean[]>("/auth/assistant-confirm/deny", adminToken, identity)

    const reply = (await turn)[0]!

    assert.equal(reply, "I will not write it.")

    assert.equal(space.home.stat(["notes", "no.txt"]), null, "Deny means no write happened")

    const second = JSON.parse(endpoint.bodies[1]!)

    const toolMessage = second.messages.find((message: { role: string }) => message.role === "tool")

    assert.match(toolMessage.content, /did not confirm/)
})

test("an ask expiring without a decision never writes", async () => {

    const hub = open()

    const admin = connect(hub)

    await bootstrapAdmin(admin)

    const space = await hub.space("root")

    const confirmManager = space.authManager.assistantConfirmManager

    // A short configured timeout: the request call carries it directly.
    const deciding = confirmManager.request("files_write", "Write late.txt (5 bytes)", 60)

    const confirmed = await deciding

    assert.equal(confirmed, false, "an expired ask resolves refused")

    assert.equal(space.home.stat(["late.txt"]), null, "an expired ask never writes")

    assert.equal(confirmManager.requests().length, 0, "nothing stays pending")
})

test("desktop_set_theme asks, then Allow applies the theme", async () => {


    const hub = open()


    const admin = connect(hub)


    const adminToken = await bootstrapAdmin(admin)


    const space = await hub.space("root")


    space.assistantMemory.clearConversation()


    const tools = assistantTools(space)


    const before = space.appearanceManager.value


    const endpoint = await scriptEndpoint([


        { deltas: [{ toolCalls: [{ id: "call-4", name: "desktop_set_theme", arguments: "" }] }, { toolCalls: [{ id: "call-4", name: "", arguments: `{"theme":"light"}` }] }] },


        { deltas: [{ text: "Theme " }, { text: "requested." }] }
    ])


    const assistant = openSpaceAssistant(endpoint.url, tools, space.assistantMemory)


    mountSpaceAssistant(space, assistant)


    const preferences: unknown[] = []


    const stopPreferences = admin.client.$inbound.subscribe("/change-desktop-preferences", value => {


        preferences.push(value)
    })


    const turn = admin.ask<string[]>("/auth/assistant/turn", adminToken, "set the theme")


    const pending = await waitPending(space)


    assert.equal(pending.length, 1, "the theme ask is pending")


    assert.equal(pending[0]!.tool, "desktop_set_theme")


    assert.match(pending[0]!.summary, /Set desktop theme to light/)


    assert.equal(space.appearanceManager.value, before, "appearance unchanged before Allow")

    assert.deepEqual(preferences, [], "no preference reached the desktop before Allow")


    await admin.ask<boolean[]>("/auth/assistant-confirm/allow", adminToken, pending[0]!.identity)


    const reply = (await turn)[0]!


    assert.equal(reply, "Theme requested.")


    assert.deepEqual(preferences, [{ theme: "light" }], "the allowed theme reached the asking desktop")

    stopPreferences()

    void before
})


test("an invalid theme is refused without any confirmation", async () => {

    const hub = open()

    await hub.space("root")

    const space = await hub.space("root")

    const tool = assistantTools(space).find(candidate => candidate.name === "desktop_set_theme")!

    const result = await tool.execute({ theme: 42 })

    assert.deepEqual(result, { error: "The theme is light or dark" })

    assert.equal(space.authManager.assistantConfirmManager.requests().length, 0, "nothing asked")
})

test("read and memory tools run without any confirmation", async () => {

    const hub = open()

    const admin = connect(hub)

    const adminToken = await bootstrapAdmin(admin)

    const space = await hub.space("root")

    space.assistantMemory.clearConversation()

    space.assistantMemory.remember("reads never pause for a decision")

    const tools = assistantTools(space)

    const endpoint = await scriptEndpoint([

        {

            deltas: [

                { toolCalls: [{ id: "call-5", name: "memory_remember", arguments: `{"fact":"reads run freely"}` }] },

                { toolCalls: [{ id: "call-5b", name: "files_list", arguments: `{"path":[]}` }] }
            ]
        },

        { deltas: [{ text: "Reads run " }, { text: "freely." }] }
    ])

    const assistant = openSpaceAssistant(endpoint.url, tools, space.assistantMemory)

    mountSpaceAssistant(space, assistant)

    const reply = (await admin.ask<string[]>("/auth/assistant/turn", adminToken, "remember and list"))[0]!

    assert.equal(reply, "Reads run freely.")

    assert.equal(space.authManager.assistantConfirmManager.requests().length, 0, "zero confirmations pending after a read-only turn")
})

test("when the asking connection dies, its pending ask resolves false", async () => {


    const hub = open()


    const admin = connect(hub)


    const adminToken = await bootstrapAdmin(admin)


    const space = await hub.space("root")


    space.assistantMemory.clearConversation()


    const tools = assistantTools(space)


    const endpoint = await scriptEndpoint([


        { deltas: [{ toolCalls: [{ id: "call-6", name: "files_write", arguments: `{"path":["doomed.txt"],"content":"never"}` }] }] },


        { deltas: [{ text: "The user is gone;" }, { text: " nothing was written." }] }
    ])


    const assistant = openSpaceAssistant(endpoint.url, tools, space.assistantMemory)


    mountSpaceAssistant(space, assistant)


    const turn = admin.ask<string[]>("/auth/assistant/turn", adminToken, "write doomed.txt")


    const pending = await waitPending(space)


    assert.equal(pending.length, 1, "the ask is pending")


    // The client departs: the gate must release the boundary and the ask settles refused.
    await admin.gate.close()


    const reply = (await turn)[0]!


    assert.equal(reply, "The user is gone; nothing was written.", "the turn ended when the connection died")


    assert.equal(space.authManager.assistantConfirmManager.requests().length, 0, "nothing stays pending")


    assert.equal(space.home.stat(["doomed.txt"]), null, "no write ever happened")
})
