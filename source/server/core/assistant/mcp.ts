/**
 * A minimal Streamable-HTTP MCP client, hand-rolled over fetch (zero new
 * dependencies): JSON-RPC 2.0 POSTs, the server's Mcp-Session-Id response
 * header carried on every later call. One client serves one space-side
 * connection; sessions live in memory and die with the space.
 *
 * Wire contract (transport):
 * - initialize: POST {endpoint} body {jsonrpc, id, method: "initialize",
 *   params: {protocolVersion, capabilities, clientInfo}}. The response
 *   carries the Mcp-Session-Id header; remember it.
 * - notifications/initialized: POST with no id; a 202 or empty body is fine.
 * - tools/list: POST {jsonrpc, id, method: "tools/list", params: {}} ->
 *   result.tools[] {name, description?, inputSchema?}.
 * - tools/call: POST {jsonrpc, id, method: "tools/call", params: {name,
 *   arguments}} -> result {content[], isError?}; a text item is the model-
 *   readable answer. Errors surface as {error, code} in plain text.
 */

export interface McpToolDescription {

    name: string

    description?: string

    inputSchema?: Record<string, unknown>
}

export interface McpToolResult {

    text: string

    isError: boolean
}

const protocolVersion = "2025-06-18"

const clientInfo = { name: "seraphos-assistant", version: "0.2.0" }

export default class McpClient {

    private sessionId: string | null = null

    private nextId = 1

    public constructor(private readonly endpoint: string, private readonly token: string | null) { }

    /** Performs the initialize/initialized handshake if not already done. */
    private async ensureSession(): Promise<void> {

        if (this.sessionId !== null) return

        const open = await this.post("initialize", {

            protocolVersion,

            capabilities: {},

            clientInfo
        })

        if (open.error) throw new Error(`The MCP server refused initialize: ${open.error.message} (${open.error.code})`)

        this.sessionId = open.sessionId ?? null

        if (this.sessionId === null) throw new Error("The MCP server answered initialize without a session id")

        // The initialized notification completes the handshake; failures
        // here are logged by the caller, never fatal.
        try { await this.notify("notifications/initialized") }
        catch { }
    }

    /** Lists the server's tools; performs the handshake on first use. */
    public async listTools(): Promise<McpToolDescription[]> {

        await this.ensureSession()

        const answer = await this.post("tools/list", {})

        if (answer.error) throw new Error("The MCP server refused tools/list")

        const tools = (answer.result as { tools?: McpToolDescription[] } | undefined)?.tools

        return Array.isArray(tools) ? tools : []
    }

    /** Calls one tool and returns its text content. */
    public async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {

        await this.ensureSession()

        const answer = await this.post("tools/call", { name, arguments: args })

        if (answer.error) throw new Error(`The MCP tool "${name}" failed: ${answer.error.message} (${answer.error.code})`)

        const result = answer.result as { content?: Array<{ type?: string, text?: string }>, isError?: boolean } | undefined

        const text = (result?.content ?? [])
            .map(item => typeof item?.text === "string"
                ? item.text
                : JSON.stringify(item))
            .filter(part => part.length > 0)
            .join("\n")

        return { text, isError: result?.isError === true }
    }

    /** One JSON-RPC request plus the transport quirks (session header, SSE or JSON). */
    private async post(method: string, params: Record<string, unknown>): Promise<{ result?: unknown, error?: { code: number, message: string }, sessionId?: string | null }> {

        const id = this.nextId++

        const response = await fetch(this.endpoint, {

            method: "POST",

            headers: {
                "content-type": "application/json",
                "accept": "application/json, text/event-stream",
                ...(this.sessionId !== null ? { "mcp-session-id": this.sessionId } : {}),
                ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
            },

            body: JSON.stringify({
                jsonrpc: "2.0",
                id,
                method,
                params
            }),

            signal: AbortSignal.timeout(120_000)
        })

        if (!response.ok) throw new Error(`The MCP server answered ${response.status}`)

        const headerSession = response.headers.get("mcp-session-id")

        const contentType = response.headers.get("content-type") ?? ""

        if (contentType.includes("text/event-stream")) return { ...await this.readEventStream(response), sessionId: headerSession }

        if (response.status === 202) return { result: undefined, sessionId: headerSession }

        return { ...await this.readJson(response), sessionId: headerSession }
    }

    private async notify(method: string): Promise<void> {

        const response = await fetch(this.endpoint, {

            method: "POST",

            headers: {
                "content-type": "application/json",
                "accept": "application/json, text/event-stream",
                ...(this.sessionId !== null ? { "mcp-session-id": this.sessionId } : {}),
                ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
            },

            body: JSON.stringify({ jsonrpc: "2.0", method, params: {} }),

            signal: AbortSignal.timeout(120_000)
        })

        if (!response.ok) throw new Error(`The MCP server answered ${response.status}`)
    }

    private async readJson(response: Response): Promise<{ result?: unknown, error?: { code: number, message: string } }> {

        const parsed = JSON.parse(await response.text()) as {
            result?: unknown
            error?: { code: number, message: string }
            id?: unknown
        }

        if (parsed.error) return { error: parsed.error }

        return { result: parsed.result }
    }

    /** Parses SSE frames of data: {...} JSON-RPC replies, ignoring keep-alives. */
    private async readEventStream(response: Response): Promise<{ result?: unknown, error?: { code: number, message: string } }> {

        const reader = response.body!.getReader()

        const decoder = new TextDecoder()

        let buffer = ""

        let pending: { result?: unknown, error?: { code: number, message: string } } | undefined

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

                if (payload === "[DONE]") continue

                try {

                    const parsed = JSON.parse(payload) as { result?: unknown, error?: { code: number, message: string }, id?: unknown }

                    if (parsed.result !== undefined) pending = { result: parsed.result }

                    else if (parsed.error !== undefined) pending = { error: parsed.error }
                }

                catch { /* a keep-alive or comment frame */ }
            }
        }

        return pending ?? {}
    }
}
