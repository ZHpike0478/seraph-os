import Application from "../application"
import type { AssistantTool } from "./assistant"
import ConnectionsStore, { type ConnectionKind, connectionEndpoint, connectionKind, connectionName, connectionToken } from "./connections"
import McpClient from "./mcp"
import { contentIsTextish, guardedFetch } from "./web-guard"

/**
 * The connectivity tools: connections the user saves in their own space
 * (remote MCP servers and HTTP APIs, secrets held server-side) plus open-web
 * fetching through the SSRF guard. State-changing asks pause at the user's
 * confirmation like files_write does; reads never pause. Nothing here can
 * name another space: every lookup runs against this space's own store.
 */
export default function connectionTools(application: Application, store: ConnectionsStore): AssistantTool[] {

    /** Streamable-HTTP MCP sessions live per space, in memory, until close. */
    const sessions = new Map<string, McpClient>()

    function mcpClient(name: string): McpClient {

        const held = sessions.get(name)

        if (held) return held

        const record = requireConnection(store, name, "mcp")

        const client = new McpClient(record.endpoint, record.token)

        sessions.set(name, client)

        return client
    }

    return [

        {
            name: "connections_save",
            description: "Save a named outbound connection in the user's space: kind mcp (a Streamable-HTTP MCP server endpoint) or api (an HTTP API base URL). The secret, when given, stays server-side and is never shown back.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "The connection name to save under" },
                    kind: { type: "string", enum: ["mcp", "api"], description: "mcp for an MCP server, api for an HTTP API" },
                    endpoint: { type: "string", description: "The http(s) endpoint URL" },
                    token: { type: "string", description: "Optional bearer secret, stored server-side and never returned" }
                },
                required: ["name", "kind", "endpoint"]
            },
            async execute(arguments_) {

                const name = connectionName(arguments_.name)

                const kind = connectionKind(arguments_.kind)

                const endpoint = connectionEndpoint(arguments_.endpoint)

                const token = connectionToken(arguments_.token)

                const confirmed = await application.authManager.assistantConfirmManager.request("connections_save", `Save the ${kind} connection "${name}" pointing at ${endpoint}${token ? " (with a secret)" : ""}`)

                if (!confirmed) return { error: "The user did not confirm this connection" }

                return { saved: store.save(name, kind, endpoint, token) }
            }
        },

        {
            name: "connections_list",
            description: "List the user's saved outbound connections. Secrets are never listed - each entry says only whether it has one.",
            parameters: { type: "object", properties: {}, required: [] },
            async execute() {

                return { connections: store.list() }
            }
        },

        {
            name: "connections_remove",
            description: "Remove one saved outbound connection by name.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "The connection name to remove" }
                },
                required: ["name"]
            },
            async execute({ name }) {

                const target = connectionName(name)

                const confirmed = await application.authManager.assistantConfirmManager.request("connections_remove", `Remove the connection "${target}"`)

                if (!confirmed) return { error: "The user did not confirm this removal" }

                return { removed: store.remove(target) }
            }
        },

        {
            name: "api_call",
            description: "Call one saved HTTP API connection: the endpoint is merged with the saved base URL and the saved secret rides server-side only (the model never sees or supplies credentials).",
            parameters: {
                type: "object",
                properties: {
                    connection: { type: "string", description: "The saved api connection name" },
                    path: { type: "string", description: "The request path under the connection's endpoint, like /v1/users" },
                    method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "HTTP method (default GET)" },
                    query: { type: "object", description: "Query parameters as an object of strings" },
                    body: { type: "object", description: "JSON request body (non-GET only)" }
                },
                required: ["connection", "path"]
            },
            async execute({ connection, path, method, query, body }) {

                const record = requireConnection(store, connection, "api")

                const target = requestTarget(record.endpoint, path, query)

                const verb = httpMethod(method)

                const payload = verb === "GET" ? undefined : jsonBody(body)

                const response = await fetch(target.toString(), {

                    method: verb,

                    headers: {
                        "accept": "application/json, text/*;q=0.8",
                        ...(record.token ? { authorization: `Bearer ${record.token}` } : {}),
                        ...(payload !== undefined ? { "content-type": "application/json" } : {})
                    },

                    body: payload,

                    signal: AbortSignal.timeout(120_000)
                })

                return await answerOf(response)
            }
        },

        {
            name: "mcp_list_tools",
            description: "List the tools one saved mcp connection's server exposes (performs the MCP handshake when needed).",
            parameters: {
                type: "object",
                properties: {
                    connection: { type: "string", description: "The saved mcp connection name" }
                },
                required: ["connection"]
            },
            async execute({ connection }) {

                const client = mcpClient(String(connection))

                return { tools: await client.listTools() }
            }
        },

        {
            name: "mcp_call_tool",
            description: "Call one tool on a saved mcp connection's server. The user confirms this like a write: nothing is sent to the server before they allow it.",
            parameters: {
                type: "object",
                properties: {
                    connection: { type: "string", description: "The saved mcp connection name" },
                    tool: { type: "string", description: "The MCP tool's name on that server" },
                    arguments: { type: "object", description: "The MCP tool's arguments object" }
                },
                required: ["connection", "tool"]
            },
            async execute({ connection, tool, arguments: mcpArguments }) {

                const target = connectionName(connection)

                const toolName = typeof tool === "string" && tool.trim() ? tool.trim() : null

                if (!toolName) return { error: "mcp_call_tool needs a tool name" }

                if (mcpArguments !== undefined && (typeof mcpArguments !== "object" || mcpArguments === null || Array.isArray(mcpArguments))) return { error: "The MCP tool arguments are an object" }

                const record = requireConnection(store, target, "mcp")

                const confirmed = await application.authManager.assistantConfirmManager.request("mcp_call_tool", `Call MCP tool "${toolName}" on the connection "${target}" (${record.endpoint})`)

                if (!confirmed) return { error: "The user did not confirm this MCP call" }

                const client = mcpClient(target)

                const answer = await client.callTool(toolName, (mcpArguments ?? {}) as Record<string, unknown>)

                return answer.isError
                    ? { error: answer.text || `The MCP tool "${toolName}" reported an error` }
                    : { result: answer.text }
            }
        },

        {
            name: "web_fetch",
            description: "Fetch one public web page or JSON endpoint by URL (GET). Local, private-network, and non-web addresses are refused; redirects are followed only while they stay public.",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "The http(s) URL to fetch" }
                },
                required: ["url"]
            },
            async execute({ url }) {

                return await guardedFetch(url)
            }
        }
    ]
}

/** Resolves one saved connection and refuses absent or wrong-kind ones. */
function requireConnection(store: ConnectionsStore, name: unknown, kind: ConnectionKind) {

    const target = connectionName(name)

    const record = store.find(target)

    if (!record) throw new Error(`The connection "${target}" does not exist in this space`)

    if (record.kind !== kind) throw new Error(`The connection "${target}" is a ${record.kind} connection, not ${kind}`)

    return record
}

/** Merges the saved base URL with the model-provided path and query. */
function requestTarget(endpoint: string, rawPath: unknown, rawQuery: unknown): URL {

    const base = new URL(endpoint)

    const suffix = typeof rawPath === "string" ? rawPath.trim() : ""

    let target: URL

    try { target = suffix ? new URL(suffix.startsWith("/") ? suffix : `/${suffix}`, base) : new URL(base.toString()) }
    catch { throw new Error("The api path is not a valid path under this connection") }

    if (typeof rawQuery === "object" && rawQuery !== null && !Array.isArray(rawQuery)) {

        for (const [key, value] of Object.entries(rawQuery as Record<string, unknown>)) {

            if (!/^[a-zA-Z0-9_\-.\[\]%]+$/.test(key) || /authorization|token|secret|key/i.test(key)) throw new Error(`The query parameter "${key}" is not allowed`)

            target.searchParams.set(key, String(value))
        }
    }

    return target
}

/** The HTTP verb: one of five, defaulting to GET. */
function httpMethod(raw: unknown): "GET" | "POST" | "PUT" | "PATCH" | "DELETE" {

    if (raw === undefined || raw === null) return "GET"

    if (raw === "GET" || raw === "POST" || raw === "PUT" || raw === "PATCH" || raw === "DELETE") return raw

    throw new Error("The api method is GET, POST, PUT, PATCH, or DELETE")
}

/** The JSON body: an object or nothing. */
function jsonBody(raw: unknown): string | undefined {

    if (raw === undefined || raw === null) return undefined

    if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("The api body is an object")

    return JSON.stringify(raw)
}

/** Reads one response into the model's answer shape, capping any body. */
async function answerOf(response: Response): Promise<Record<string, unknown>> {

    const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim()

    const reader = response.body?.getReader()

    if (!reader) return { status: response.status, contentType, body: null, truncated: false, bytes: 0 }

    const chunks: Uint8Array[] = []

    let size = 0

    let truncated = false

    while (true) {

        const { done, value } = await reader.read()

        if (done) break

        size += value.byteLength

        if (size > 512 * 1024) {

            await reader.cancel()

            truncated = true

            break
        }

        chunks.push(value)
    }

    const text = chunks.map(chunk => new TextDecoder().decode(chunk)).join("")

    const body = contentIsTextish(contentType) ? text.slice(0, 16_000) : null

    return {
        status: response.status,
        contentType,
        body,
        truncated,
        bytes: chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    }
}
