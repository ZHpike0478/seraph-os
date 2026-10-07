import { DatabaseSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

export type MemoryFact = Readonly<{

    identity: number

    text: string

    createdAt: number
}>

export type StoredMessage = Readonly<{

    role: "user" | "assistant"

    content: string

    at: number
}>

/**
 * One account-space's assistant memory: conversation history the desktop can
 * reopen, and long-term facts the assistant saves and recalls by keyword.
 * Both live in one SQLite database inside the space's own storage, so memory
 * is as private as every other file the user owns.
 */
export default class AssistantMemory {

    private readonly database: DatabaseSync

    private constructor(database: DatabaseSync) {

        this.database = database
    }

    public static open(path: string) {

        mkdirSync(dirname(path), { recursive: true })

        const database = new DatabaseSync(path)

        database.exec("pragma journal_mode = wal; pragma busy_timeout = 5000")

        database.exec(`

            create table if not exists messages (

                id integer primary key autoincrement,

                role text not null check (role in ('user', 'assistant')),

                content text not null,

                at integer not null
            )
        `)

        database.exec(`

            create table if not exists facts (

                id integer primary key autoincrement,

                text text not null,

                created_at integer not null
            )
        `)

        return new AssistantMemory(database)
    }

    /** The newest conversation turn boundary: history is trimmed around this. */
    public append(role: "user" | "assistant", content: string) {

        this.database.prepare("insert into messages (role, content, at) values (?, ?, ?)").run(role, content, Date.now())
    }

    /** The last `limit` messages, in conversation order. */
    public recent(limit = 40): StoredMessage[] {

        const rows = this.database.prepare(`

            select role, content, at from messages

            order by id desc limit ?
        `).all(limit) as unknown as { role: string, content: string, at: number }[]

        return rows.reverse().map(row => ({

            role: row.role === "user" ? "user" : "assistant",

            content: row.content,

            at: row.at
        }))
    }

    /**
     * Saves one long-term fact when it is not already there; returns the
     * identity of the surviving row. Word-overlap near-duplicates replace
     * the older row, so "the user's name is Steph" cannot accumulate fifty
     * times as one conversation rephrases it.
     */
    public remember(text: string): number {

        const proposed = normalizeFact(text)

        if (!proposed.words.length) throw new Error("A remembered fact needs some words")

        const rows = this.database.prepare("select id, text from facts").all() as unknown as { id: number, text: string }[]

        const overlap = rows

            .map(row => ({ identity: row.id, text: row.text, score: overlapScore(proposed.words, normalizeFact(row.text).words) }))

            .filter(entry => entry.score >= DUPLICATE_OVERLAP)

            .sort((a, b) => b.score - a.score || b.identity - a.identity)

        const [best] = overlap

        if (best) {

            // The newest phrasing wins the body; the original's age and
            // identity survive so stability and provenance persist.
            this.database.prepare("update facts set text = ? where id = ?").run(text, best.identity)

            return best.identity
        }

        const result = this.database.prepare("insert into facts (text, created_at) values (?, ?)").run(text, Date.now())

        return Number(result.lastInsertRowid)
    }

    /** Keyword recall: substrings match case-insensitively, newest first. */
    public recall(query: string, limit = 8): MemoryFact[] {

        const words = query.toLowerCase().split(/\s+/).filter(word => word.length > 2)

        const rows = this.database.prepare("select id, text, created_at from facts order by id desc limit 500").all() as unknown as { id: number, text: string, created_at: number }[]

        const scored = rows

            .map(row => ({

                identity: row.id,

                text: row.text,

                createdAt: row.created_at,

                score: words.filter(word => row.text.toLowerCase().includes(word)).length

            }))
            .filter(row => row.score > 0)

            .sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)

            .slice(0, limit)

        return scored.map(({ identity, text, createdAt }) => ({ identity, text, createdAt }))
    }

    public forget(identity: number) {

        this.database.prepare("delete from facts where id = ?").run(identity)
    }

    /** Drops conversation history; long-term facts survive. */
    public clearConversation() {

        this.database.prepare("delete from messages").run()
    }

    /** Closes the underlying database. */
    public close() {

        this.database.close()
    }
}

/** Two facts sharing this fraction of significant words count as the same fact. */
const DUPLICATE_OVERLAP = 0.6

function normalizeFact(text: string): { words: string[] } {

    const words = (text ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []

    return { words: words.filter(word => word.length > 1) }
}

/** Jaccard overlap of two word sets, in [0, 1]. */
function overlapScore(a: string[], b: string[]): number {

    if (a.length === 0 || b.length === 0) return 0

    const left = new Set(a)

    const right = new Set(b)

    let shared = 0

    for (const word of left) if (right.has(word)) shared++

    const union = new Set([...left, ...right]).size

    return union === 0 ? 0 : shared / union
}