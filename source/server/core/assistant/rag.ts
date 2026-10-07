import { DatabaseSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

/** One retrieved chunk, with everything a caller needs to trust or refresh it. */
export type RagHit = Readonly<{

    path: string

    /** The chunk's position in its file, zero-based. */
    ord: number

    /** Reciprocal-rank-fusion score over the cosine and keyword legs. */
    score: number

    /** The raw cosine similarity, for callers that gate on a noise floor. */
    cosine: number

    /** True when the keyword index matched this chunk. */
    matched: boolean

    excerpt: string

    /** What the source file looked like when it was indexed. */
    size: number

    modifiedAt: number

    indexedAt: number
}>

export type SearchOptions = Readonly<{

    /** Query text for the keyword leg; absent means cosine only. */
    text?: string

    /** Drop cosine-only hits below this similarity; keyword matches always stand. */
    floor?: number
}>

/** The keyword-mirror layout this code maintains; a change rebuilds on open. */
const FTS_VERSION = "1"

/**
 * One account-space's retrieval index: chunks of the user's own files with
 * their embedding vectors, in one SQLite database inside the space's own
 * storage. Nothing here can name another space.
 *
 * Search is hybrid: cosine over the stored vectors and BM25 over an FTS5
 * mirror of the chunk text, fused by reciprocal rank. Each row also records
 * what the source file looked like (size, modified time) and which embedding
 * model produced its vector, so a search can never quietly answer from
 * another model's geometry or from out-of-date chunks.
 */
export default class RagIndex {

    private readonly database: DatabaseSync

    private constructor(database: DatabaseSync) {

        this.database = database
    }

    public static open(path: string) {

        mkdirSync(dirname(path), { recursive: true })

        const database = new DatabaseSync(path)

        database.exec("pragma journal_mode = wal; pragma busy_timeout = 5000")

        RagIndex.migrate(database)

        // The keyword mirror reads its text back from chunks itself (an
        // external-content table): one copy of the text, and deletes stay
        // exact through the FTS5 'delete' command.
        database.exec(`
            create virtual table if not exists chunks_fts using fts5 (
                text, content='chunks', content_rowid='id'
            )
        `)

        // The keyword mirror rides the same writes as the chunks table.
        database.exec(`
            create trigger if not exists chunks_fts_insert after insert on chunks
            begin
                insert into chunks_fts (rowid, text) values (new.id, new.text);
            end
        `)

        database.exec(`
            create trigger if not exists chunks_fts_delete after delete on chunks
            begin
                insert into chunks_fts (chunks_fts, rowid, text) values ('delete', old.id, old.text);
            end
        `)

        database.exec(`
            create trigger if not exists chunks_fts_update after update of text on chunks
            begin
                insert into chunks_fts (chunks_fts, rowid, text) values ('delete', old.id, old.text);
                insert into chunks_fts (rowid, text) values (new.id, new.text);
            end
        `)

        // A mirror carried over from a pre-trigger database (written as
        // v0) holds nothing searchable: rebuild it once, by version stamp,
        // so an open after every write stays cheap. A crashed write leaves
        // both sides consistent (one transaction), so no other probe exists.
        const version = RagIndex.metaValue(database, "ftsVersion")

        if (version !== FTS_VERSION) {

            database.exec("insert into chunks_fts (chunks_fts, rank) values ('rebuild', 'fix')")

            RagIndex.setMetaValue(database, "ftsVersion", FTS_VERSION)
        }

        return new RagIndex(database)
    }

    /** Reads one meta value; undefined when never stamped. */
    private static metaValue(database: DatabaseSync, key: string): string | undefined {

        return (database.prepare("select value from meta where key = ?").get(key) as { value: string } | undefined)?.value
    }

    private static setMetaValue(database: DatabaseSync, key: string, value: string) {

        database.prepare("insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value").run(key, value)
    }

    /** How many chunks this index holds in total, and for one path. */
    public count(path?: string): number {

        const row = path === undefined

            ? this.database.prepare("select count(*) as total from chunks").get()

            : this.database.prepare("select count(*) as total from chunks where path = ?").get(path)

        return Number((row as { total: number | bigint }).total)
    }

    /** Adopts an embedding model for this index: the first call stamps it;
     * a change resets every chunk, because vectors from one model carry no
     * meaning in another's geometry. "reset" tells the caller to reindex.
     */
    public adoptModel(model: string): "created" | "current" | "reset" {

        const stamped = RagIndex.metaValue(this.database, "embedModel")

        if (stamped === undefined) {

            RagIndex.setMetaValue(this.database, "embedModel", model)

            return "created"
        }

        if (stamped === model) return "current"

        this.database.exec("begin immediate")

        try {

            this.database.exec("delete from chunks")

            RagIndex.setMetaValue(this.database, "embedModel", model)

            this.database.exec("commit")
        }

        catch (exception) {

            this.database.exec("rollback")

            throw exception
        }

        return "reset"
    }

    /** The embedding model this index's vectors belong to, once stamped. */
    public get embedModel(): string | null {

        return RagIndex.metaValue(this.database, "embedModel") ?? null
    }

    /** Replaces every chunk of one path with fresh ones; returns the count indexed. */
    public replacePath(path: string, chunks: { text: string, vector: Float32Array }[], source?: { size?: number, modifiedAt?: number }): number {

        const at = Date.now()

        const size = Math.max(0, Math.round(source?.size ?? 0))

        const modifiedAt = Math.max(0, Math.round(source?.modifiedAt ?? 0))

        this.database.exec("begin immediate")

        try {

            this.database.prepare("delete from chunks where path = ?").run(path)

            const insert = this.database.prepare(`
                insert into chunks (path, ord, text, vector, size, modified_at, indexed_at)
                values (?, ?, ?, ?, ?, ?, ?)
            `)

            chunks.forEach((chunk, ord) => insert.run(path, ord, chunk.text, vectorToBlob(chunk.vector), size, modifiedAt, at))

            this.database.exec("commit")

            return chunks.length
        }

        catch (exception) {

            this.database.exec("rollback")

            throw exception
        }
    }

    /** Every indexed path, with chunk counts and what each looked like when indexed. */
    public paths(): { path: string, chunks: number, size: number, modifiedAt: number, indexedAt: number }[] {

        return this.database.prepare(`
            select path, count(*) as chunks, max(size) as size, max(modified_at) as modifiedAt, max(indexed_at) as indexedAt
            from chunks group by path order by path
        `).all() as unknown as { path: string, chunks: number, size: number, modifiedAt: number, indexedAt: number }[]
    }

    /**
     * The top-k chunks of the whole index for one query. The cosine leg works
     * from the stored vectors; when query text is given, a keyword leg over
     * the full-text mirror joins in, and both are fused by reciprocal rank
     * with the keyword leg weighted higher: an exact identifier beats a
     * distant paraphrase. `floor` drops cosine-only noise but never a
     * keyword match.
     */
    public search(vector: Float32Array, k = 4, options?: SearchOptions): RagHit[] {

        const take = Math.max(1, Math.min(k, 16))

        const floor = options?.floor ?? 0

        const rows = this.database.prepare(`
            select id, path, ord, text, vector, size, modified_at as modifiedAt, indexed_at as indexedAt from chunks
        `).all() as unknown as { id: number, path: string, ord: number, text: string, vector: Uint8Array, size: number, modifiedAt: number, indexedAt: number }[]

        const query = Array.from(vector)

        const rowsById = new Map(rows.map(row => [row.id, row]))

        const denseRows = rows

            .map(row => ({ row, similarity: cosine(query, Array.from(vectorFromBlob(row.vector))) }))

            .filter(entry => entry.similarity >= floor && entry.similarity > 0)

            .sort((a, b) => b.similarity - a.similarity)

            .slice(0, take * 4)

        // A present-but-empty keyword query keeps the fusion plain: with one
        // leg, reciprocal rank preserves that leg's own order.
        const weights = keywordQuery(options?.text) ? { dense: 0.4, keyword: 0.6 } : { dense: 1.0, keyword: 0.0 }

        const fused = new Map<number, { row: typeof rows[number], score: number, cosine: number }>()

        const keywordHits = new Set<number>()

        denseRows.forEach((entry, position) => {

            const current = fused.get(entry.row.id)

            const score = (current?.score ?? 0) + weights.dense / (60 + position + 1)

            fused.set(entry.row.id, { row: entry.row, score, cosine: entry.similarity })
        })

        if (weights.keyword > 0) {

            const match = keywordQuery(options?.text)!

            // Keyword matches stand regardless of the floor, so they bypass
            // it: their leg's rank comes straight from BM25.
            const keywordRows = this.keywordSearch(match, take * 4)

            keywordRows.forEach(hit => keywordHits.add(hit.rowid))

            keywordRows.forEach((entry, position) => {

                const known = fused.get(entry.rowid)

                const score = (known?.score ?? 0) + weights.keyword / (60 + position + 1)

                const row = rowsById.get(entry.rowid) ?? known?.row

                if (row) fused.set(entry.rowid, { row, score, cosine: known?.cosine ?? cosine(query, Array.from(vectorFromBlob(row.vector))) })
            })

            // A keyword hit stands even when its cosine sits below the floor.
            for (const identity of keywordHits) {

                const entry = fused.get(identity)

                if (entry && entry.cosine < floor) fused.set(identity, { ...entry, cosine: floor })
            }
        }

        return [...fused.values()]

            .sort((a, b) => b.score - a.score)

            .slice(0, take)

            .map(entry => ({

                path: entry.row.path,

                ord: entry.row.ord,

                score: entry.score,

                cosine: entry.cosine,

                matched: weights.keyword > 0 && keywordHits.has(entry.row.id),

                excerpt: entry.row.text,

                size: entry.row.size,

                modifiedAt: entry.row.modifiedAt,

                indexedAt: entry.row.indexedAt
            }))
    }

    /** BM25-ranked chunk ids for one keyword query; empty when nothing matches. */
    private keywordSearch(match: string, limit: number): { rowid: number, rank: number }[] {

        try {

            return this.database.prepare(`
                select rowid, bm25(chunks_fts) as rank from chunks_fts
                where chunks_fts match ? order by rank limit ?
            `).all(match, limit) as unknown as { rowid: number, rank: number }[]
        }

        catch {

            // An unmatched-syntax query must never break a search.
            return []
        }
    }

    /** Drops every chunk of one path. */
    public drop(path: string): boolean {

        const gone = this.database.prepare("delete from chunks where path = ?").run(path)

        return Number(gone.changes) > 0
    }

    /** Distinguishes indexed hits from absent paths. */
    public hasPath(path: string): boolean {

        return this.database.prepare("select 1 from chunks where path = ? limit 1").get(path) !== undefined
    }

    public close() {

        this.database.close()
    }

    /** The schema, forward from whatever version opened last. */
    private static migrate(database: DatabaseSync) {

        database.exec(`
            create table if not exists chunks (

                id integer primary key autoincrement,

                path text not null,

                ord integer not null,

                text text not null,

                vector blob not null,

                size integer not null default 0,

                modified_at integer not null default 0,

                indexed_at integer not null default 0
            )
        `)

        // A pre-staleness database: add the lineage columns in place.
        const columns = (database.prepare("pragma table_info(chunks)").all() as unknown as { name: string }[]).map(entry => entry.name)

        for (const column of ["size", "modified_at", "indexed_at"]) {

            if (!columns.includes(column)) database.exec(`alter table chunks add column ${column} integer not null default 0`)
        }

        database.exec("create index if not exists chunks_path on chunks (path)")

        database.exec(`
            create table if not exists meta (

                key text primary key,

                value text not null
            )
        `)
    }
}

/** Builds the FTS5 match string for one keyword query: prefix tokens, stopword light. */
export function keywordQuery(text: string | undefined): string | null {

    const words = (text ?? "").toLowerCase().match(/[a-z0-9_]+/g) ?? []

    const kept = words.filter(word => word.length > 1 && !STOP_WORDS.has(word))

    const unique = [...new Set(kept)]

    if (unique.length === 0) return null

    return unique.map(word => `${word}*`).join(" ")
}

const STOP_WORDS = new Set([
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are", "was", "were",
    "be", "been", "it", "its", "this", "that", "these", "those", "at", "by", "from", "as", "not",
    "what", "which", "who", "how", "where", "when", "why", "do", "does", "did", "can", "will", "would", "you", "your", "my"
])

export function vectorToBlob(vector: Float32Array): Buffer {

    return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

export function vectorFromBlob(blob: Uint8Array): Float32Array {

    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)

    const copy = new Float32Array(blob.byteLength / 4)

    for (let index = 0; index < copy.length; index++) copy[index] = view.getFloat32(index * 4, true)

    return copy
}

export function cosine(a: number[], b: number[]): number {

    if (a.length === 0 || a.length !== b.length) return 0

    let dot = 0

    let na = 0

    let nb = 0

    for (let index = 0; index < a.length; index++) {

        dot += a[index] * b[index]

        na += a[index] * a[index]

        nb += b[index] * b[index]
    }

    return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb))
}