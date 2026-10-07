import environment from "@libs/environment"
import AssistantMemory, { type StoredMessage } from "./memory"

/**
 * The model contract every tool answers to. Tools run as the signed-in user,
 * inside that user's space: file tools reach only the space's own storage.
 */
export interface AssistantTool {

    name: string

    description: string

    parameters: Record<string, unknown>

    /** Runs the tool; returns the JSON-able answer handed back to the model. */
    execute(arguments_: Record<string, unknown>): Promise<unknown>
}

const systemPrompt = [

    "You are Seraph, the personal assistant built into this user's Seraph OS desktop.",

    "You run as the signed-in user: every file you read or write is theirs, and nothing outside their space is reachable.",

    "Use tools when they answer the request; say so plainly when none are needed.",

    "When a user tells you something to remember for later, save it with memory_remember.",

    "Remembered facts about the user appear under a Saved facts line; use them naturally and do not repeat them back unless they matter.",

    "Search results from files may be stale: before quoting a searched excerpt, re-read the file with files_read.",

    "Keep answers short and plain."

].join(" ")

/**
 * The recalled facts shown to the model each turn. Recalling is the
 * memory's job, not the model's: saved facts ride along even when the model
 * never thought to ask.
 */
const RECALL_LIMIT = 6

/** Configuration for one OpenAI-compatible endpoint. */
export interface AssistantConfigurationValues {

    baseUrl: string

    apiKey: string

    model: string

    /** The embeddings model served at the same endpoint; enables the RAG tools. */
    embedModel: string
}

/** Reads SERAPH_LLM_* variables, with local Ollama as the silent default. */
export function assistantConfiguration(variables: NodeJS.ProcessEnv): AssistantConfigurationValues | null {

    const baseUrl = environment("seraph", "LLM_BASE_URL", variables).value

        ?? environment("seraphos", "LLM_BASE_URL", variables).value

    const apiKey = environment("seraph", "LLM_API_KEY", variables).value

        ?? environment("seraphos", "LLM_API_KEY", variables).value

        ?? ""

    const model = environment("seraph", "LLM_MODEL", variables).value

        ?? environment("seraphos", "LLM_MODEL", variables).value

        ?? "llama3.2"

    const embedModel = environment("seraph", "LLM_EMBED_MODEL", variables).value

        ?? environment("seraphos", "LLM_EMBED_MODEL", variables).value

        ?? "nomic-embed-text"

    if (!baseUrl) return null

    return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model, embedModel }
}

/** One user-visible reply chunk as it streams. */
export interface AssistantChunk {

    delta: string

    done: boolean
}

/**
 * The assistant itself: conversation + memory context in, streaming text and
 * executed tools out. One instance serves one account-space.
 */
export default class Assistant {

    private readonly memory: AssistantMemory

    private readonly configuration: AssistantConfigurationValues

    private readonly tools: Map<string, AssistantTool>

    private constructor(configuration: AssistantConfigurationValues, memory: AssistantMemory, tools: AssistantTool[]) {

        this.configuration = configuration

        this.memory = memory

        this.tools = new Map(tools.map(tool => [tool.name, tool]))
    }

    public static open(configuration: AssistantConfigurationValues | null, memory: AssistantMemory, tools: AssistantTool[]): Assistant | null {

        return configuration ? new Assistant(configuration, memory, tools) : null
    }

    public static get memoryConstructor() {

        return AssistantMemory.open
    }

    public get available(): boolean {

        return true
    }

    /** The tool catalog, for the desktop to show the user what Seraph may do. */
    /**
     * Runs one of this assistant's registered tools by name - the surface
     * the model's rounds use, opened to the space's own management UI.
     * Only registered tools run; the arguments carry the tool's own shape.
     */
    public async runTool(name: string, arguments_: Record<string, unknown>): Promise<unknown> {

        const tool = this.tools.get(name)

        if (!tool) throw new Error(`The tool "${name}" is not available`)

        return tool.execute(arguments_)
    }

    public toolCatalog() {

        return [...this.tools.values()].map(tool => ({

            name: tool.name,

            description: tool.description
        }))
    }

    /**
     * One conversational turn. The user's message is remembered, streamed
     * through deltas, and every tool call the model makes is executed in
     * order; the full reply text resolves when done.
     */
    public async *turn(userContent: string): AsyncGenerator<AssistantChunk> {

        const history: StoredMessage[] = this.memory.recent(40)

        this.memory.append("user", userContent)

        // Facts the memory already holds about this message ride along as
        // part of the system context; the model need not ask for them.
        const remembered = this.memory.recall(userContent, RECALL_LIMIT)

        const messages: { role: string, content?: string, tool_calls?: unknown[], tool_call_id?: string }[] = [

            { role: "system", content: remembered.length ? `${systemPrompt}\n\nSaved facts: ${remembered.map(fact => fact.text).join(" | ")}` : systemPrompt },

            ...history.map(historyMessage => ({ role: historyMessage.role, content: historyMessage.content })),

            { role: "user", content: userContent }
        ]

        let reply = ""

        // The model may chain several tool rounds before it answers in text.
        for (let round = 0; round < 8; round++) {

            const stream = await this.request(messages)

            const toolCalls: { id: string, name: string, arguments: string }[] = []

            for await (const delta of this.deltas(stream)) {

                if (delta.content) {

                    reply += delta.content

                    yield { delta: delta.content, done: false }
                }

                if (delta.tool_calls) {

                    for (const call of delta.tool_calls) {

                        const held = toolCalls.find(known => known.id === call.id)

                        if (held) {

                            if (call.function?.name) held.name += call.function.name

                            if (call.function?.arguments) held.arguments += call.function.arguments
                        }

                        else if (call.id) {

                            toolCalls.push({ id: call.id, name: call.function?.name ?? "", arguments: call.function?.arguments ?? "" })
                        }
                    }
                }
            }

            if (toolCalls.length === 0) break

            messages.push({

                role: "assistant",

                ...(reply ? { content: reply } : {}),

                tool_calls: toolCalls.map(call => ({

                    type: "function",

                    id: call.id,

                    function: { name: call.name, arguments: call.arguments || "{}" }
                }))
            })

            for (const call of toolCalls) {

                const answer = await this.executeTool(call.name, call.arguments)

                messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(answer) })
            }
        }

        if (reply) this.memory.append("assistant", reply)

        yield { delta: "", done: true }
    }

    /** Executes one tool call by name; failures answer as strings, not throws. */
    private async executeTool(name: string, rawArguments: string) {

        const tool = this.tools.get(name)

        if (!tool) return { error: `The assistant does not know "${name}"` }

        let parsed: Record<string, unknown>

        try { parsed = rawArguments ? JSON.parse(rawArguments) : {} }

        catch { return { error: "The tool arguments were not valid JSON" } }

        try { return await tool.execute(parsed) }

        catch (exception) {

            return { error: exception instanceof Error ? exception.message : String(exception) }
        }
    }

    private async request(messages: unknown[]) {

        return await fetch(`${this.configuration.baseUrl}/chat/completions`, {

            method: "POST",

            headers: {

                "content-type": "application/json",

                ...(this.configuration.apiKey ? { authorization: `Bearer ${this.configuration.apiKey}` } : {})
            },

            body: JSON.stringify({

                model: this.configuration.model,

                messages,

                stream: true,

                tools: this.toolSchemas()
            }),

            signal: AbortSignal.timeout(120_000)
        })
    }

    private toolSchemas() {

        return [...this.tools.values()].map(tool => ({

            type: "function",

            function: {

                name: tool.name,

                description: tool.description,

                parameters: tool.parameters
            }
        }))
    }

    /** Decodes one OpenAI-compatible SSE stream into per-part deltas. */
    private async *deltas(response: Response): AsyncGenerator<{ content?: string, tool_calls?: Array<Partial<{ id: string, function: Partial<{ name: string, arguments: string }> }>> }> {

        if (!response.ok || !response.body) throw new Error(`The model endpoint answered ${response.status}`)

        const reader = response.body.getReader()

        const decoder = new TextDecoder()

        let buffer = ""

        while (true) {

            const { done, value } = await reader.read()

            if (done) break

            buffer += decoder.decode(value, { stream: true })

            let boundary: number

            while ((boundary = buffer.indexOf("\n")) >= 0) {

                const line = buffer.slice(0, boundary).trim()

                buffer = buffer.slice(boundary + 1)

                if (!line.startsWith("data:")) continue

                const payload = line.slice(5).trim()

                if (payload === "[DONE]") return

                try {

                    const parsed = JSON.parse(payload)

                    const delta = parsed.choices?.[0]?.delta

                    if (delta) yield delta
                }

                catch { /* a partial line or keep-alive; the next chunk completes it */ }
            }
        }
    }
}