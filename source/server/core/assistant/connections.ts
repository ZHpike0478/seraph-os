import { DatabaseSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

/**
 * Named outbound connections of one account-space: remote MCP servers and
 * HTTP APIs the assistant may be asked to call on the user's behalf. One
 * store per space, SQLite, like assistant.sqlite and assistant-rag.sqlite.
 * Secrets stay here: every view that leaves the server carries hasKey, and
 * no route or tool result ever echoes a saved token back.
 */

export type ConnectionKind = "mcp" | "api"

/** The only shape of a connection that ever leaves the server. */
export interface ConnectionView {

    name: string

    kind: ConnectionKind

    endpoint: string

    hasKey: boolean

    createdAt: string
}

interface ConnectionRecord extends ConnectionView {

    token: string | null
}

/** A connection name: 1-64 chars, letter/number first, no control characters. */
export function connectionName(value: unknown): string {

    if (typeof value !== "string") throw new Error("A connection needs a name")

    const name = value.trim()

    if (!/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,63}$/.test(name)) throw new Error("A connection name is 1-64 characters starting with a letter or number")

    return name
}

/** A connection kind: mcp (Streamable HTTP) or api (HTTP API). */
export function connectionKind(value: unknown): ConnectionKind {

    if (value !== "mcp" && value !== "api") throw new Error("A connection kind is mcp or api")

    return value
}

/** A connection endpoint: an http(s) URL, no credentials in the URL itself. */
export function connectionEndpoint(value: unknown): string {

    if (typeof value !== "string" || !value.trim()) throw new Error("A connection needs an endpoint URL")

    let parsed: URL

    try { parsed = new URL(value.trim()) }
    catch { throw new Error("The connection endpoint is not a valid URL") }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("The connection endpoint is http or https")

    if (parsed.username || parsed.password) throw new Error("The connection endpoint carries its credentials server-side, not in the URL")

    return parsed.origin + (parsed.pathname === "/" ? "" : parsed.pathname) + parsed.search
}

/** A optional saved secret: a string, or nothing. */
export function connectionToken(value: unknown): string | null {

    if (value === undefined || value === null || value === "") return null

    if (typeof value !== "string") throw new Error("A connection secret is a string or nothing")

    return value
}

export default class ConnectionsStore {

    private readonly database: DatabaseSync

    private constructor(database: DatabaseSync) {

        this.database = database
    }

    public static open(path: string) {

        mkdirSync(dirname(path), { recursive: true })

        const database = new DatabaseSync(path)

        database.exec("pragma journal_mode = wal; pragma busy_timeout = 5000")

        database.exec(`
            create table if not exists connections (

                name text primary key,

                kind text not null,

                endpoint text not null,

                token text,

                created_at text not null
            )
        `)

        return new ConnectionsStore(database)
    }

    /** Saves one connection, replacing any previous one of the same name. */
    public save(name: string, kind: ConnectionKind, endpoint: string, token: string | null): ConnectionView {

        this.database.prepare(`
            insert into connections (name, kind, endpoint, token, created_at)
            values (?, ?, ?, ?, ?)
            on conflict(name) do update set kind = excluded.kind, endpoint = excluded.endpoint, token = excluded.token, created_at = excluded.created_at
        `).run(name, kind, endpoint, token, new Date().toISOString())

        return this.view(this.find(name)!)
    }

    /** Every connection of this space, names only growing more specific. */
    public list(): ConnectionView[] {

        const rows = this.database.prepare("select name, kind, endpoint, token, created_at from connections order by name").all() as unknown as ConnectionRecord[]

        return rows.map(record => this.view(this.record(record.name)))
    }

    /** The full record, secrets included - server-side use only. */
    public find(name: string): ConnectionRecord | null {

        const row = this.database.prepare("select name, kind, endpoint, token, created_at from connections where name = ?").get(name) as unknown as { name: string, kind: string, endpoint: string, token: string | null, created_at: string } | undefined

        if (!row) return null

        return {
            name: row.name,
            kind: row.kind === "mcp" ? "mcp" : "api",
            endpoint: row.endpoint,
            token: row.token,
            hasKey: row.token !== null && row.token !== "",
            createdAt: row.created_at
        }
    }

    /** Drops one connection; tells whether anything was dropped. */
    public remove(name: string): boolean {

        const gone = this.database.prepare("delete from connections where name = ?").run(name)

        return Number(gone.changes) > 0
    }

    public close() {

        this.database.close()
    }

    private record(name: string): ConnectionRecord {

        const found = this.find(name)

        if (!found) throw new Error(`The connection "${name}" does not exist`)

        return found
    }

    private view(record: ConnectionRecord): ConnectionView {

        return {
            name: record.name,
            kind: record.kind,
            endpoint: record.endpoint,
            hasKey: record.hasKey,
            createdAt: record.createdAt
        }
    }
}
