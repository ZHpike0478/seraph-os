import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, test } from "vitest"
import Assistant, { assistantConfiguration } from "@server/core/assistant/assistant"
import AssistantMemory from "@server/core/assistant/memory"
import type { AssistantTool } from "@server/core/assistant/assistant"

const homes: string[] = []

const servers: Server[] = []

afterAll(function () {

    for (const server of servers) server.close()

    for (const directory of homes) {

        try { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
        catch { }
    }
})

/** A scripted OpenAI-compatible endpoint: each POST answers one scripted SSE body of several deltas. */
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

                // The real OpenAI wire: text rides `content`; a tool call is
                // `{ id, type, function: { name, arguments } }`.
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

test("the endpoint configuration reads SERAPH_LLM_* variables", () => {

    assert.equal(assistantConfiguration({}), null)

    const local = assistantConfiguration({ SERAPH_LLM_BASE_URL: "http://localhost:11434/v1/" })

    assert.deepEqual(local, { baseUrl: "http://localhost:11434/v1", apiKey: "", model: "llama3.2" })

    const full = assistantConfiguration({

        SERAPH_LLM_BASE_URL: "https://integrate.api.nvidia.com/v1",

        SERAPH_LLM_API_KEY: "nvapi-key",

        SERAPH_LLM_MODEL: "meta/llama-3.1-70b-instruct"
    })

    assert.deepEqual(full, {

        baseUrl: "https://integrate.api.nvidia.com/v1",

        apiKey: "nvapi-key",

        model: "meta/llama-3.1-70b-instruct"
    })
})

test("one turn streams text and runs tools in order", async () => {

    const recorded: string[] = []

    const tools: AssistantTool[] = [

        {
            name: "double",
            description: "Doubles a number",
            parameters: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
            async execute(arguments_) {

                recorded.push(`double:${String(arguments_.value)}`)

                return { doubled: Number(arguments_.value) * 2 }
            }
        }
    ]

    const endpoint = await scriptEndpoint([

        // Round 1, one request: the tool's name arrives first, its streamed
        // arguments complete the call inside the same SSE body.
        {

            deltas: [

                { toolCalls: [{ id: "call-1", name: "double", arguments: "" }] },

                { toolCalls: [{ id: "call-1", name: "", arguments: `{"value":` }] },

                { toolCalls: [{ id: "call-1", name: "", arguments: ` 21}` }] }
            ]
        },

        // Round 2: the model answers in text, streamed word by word.
        { deltas: [{ text: "The answer" }, { text: " is 42." }] }
    ])

    const directory = mkdtempSync(join(tmpdir(), "seraph-assistant-"))

    homes.push(directory)

    const assistant = Assistant.open({ baseUrl: endpoint.url, apiKey: "test", model: "test-model" }, AssistantMemory.open(join(directory, "assistant.sqlite")), tools)

    assert.ok(assistant)

    const deltas: string[] = []

    let final = ""

    for await (const chunk of assistant.turn("double 21 please")) {

        if (chunk.delta) { deltas.push(chunk.delta); final += chunk.delta }

        if (chunk.done) assert.equal(chunk.delta, "")
    }

    assert.deepEqual(recorded, ["double:21"])

    assert.equal(final, "The answer is 42.")

    // The second request carried the tool result.
    assert.equal(endpoint.bodies.length, 2)

    const second = JSON.parse(endpoint.bodies[1]!)

    assert.equal(second.messages.some((message: { role: string }) => message.role === "tool"), true)

    endpoint.stop()

    void deltas
})

test("a tool failure answers as text the model can correct", async () => {

    const tools: AssistantTool[] = [

        {
            name: "explode",
            description: "Always fails",
            parameters: { type: "object", properties: {}, required: [] },
            async execute() { throw new Error("the tool exploded") }
        }
    ]

    const endpoint = await scriptEndpoint([

        { deltas: [{ toolCalls: [{ id: "call-9", name: "explode", arguments: "{}" }] }] },

        { deltas: [{ text: "Sorry, the tool failed; I will say what happened." }] }
    ])

    const directory = mkdtempSync(join(tmpdir(), "seraph-assistant-"))

    homes.push(directory)

    const assistant = Assistant.open({ baseUrl: endpoint.url, apiKey: "", model: "m" }, AssistantMemory.open(join(directory, "assistant.sqlite")), tools)

    assert.ok(assistant)

    let final = ""

    for await (const chunk of assistant.turn("do the thing")) {

        final += chunk.delta
    }

    assert.equal(final, "Sorry, the tool failed; I will say what happened.")

    // The tool's failure reached the model as an answer, not a dead connection.
    const second = JSON.parse(endpoint.bodies[1]!)

    const toolMessage = second.messages.find((message: { role: string }) => message.role === "tool")

    assert.match(toolMessage.content, /the tool exploded/)

    endpoint.stop()
})