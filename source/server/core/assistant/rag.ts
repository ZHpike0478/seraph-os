import { DatabaseSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

/**
 * One account-space's retrieval index: chunks of the user's own files with
 * their embedding vectors, in one SQLite database inside the space's own
 * storage. Nothing here can name another space.
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

        database.exec(`
            create table if not exists chunks (

                id integer primary key autoincrement,

                path text not null,

                ord integer not null,

                text text not null,

                vector blob not null
            )
        `)

        database.exec("create index if not exists chunks_path on chunks (path)")

        return new RagIndex(database)
    }

    /** How many chunks this index holds in total, and for one path. */
    public count(path?: string): number {

        const row = path === undefined

            ? this.database.prepare("select count(*) as total from chunks").get()

            : this.database.prepare("select count(*) as total from chunks where path = ?").get(path)

        return Number((row as { total: number | bigint }).total)
    }

    /** Replaces every chunk of one path with fresh ones; returns the count indexed. */
    public replacePath(path: string, chunks: { text: string, vector: Float32Array }[]): number {

        this.database.exec("begin immediate")

        try {

            this.database.prepare("delete from chunks where path = ?").run(path)

            const insert = this.database.prepare("insert into chunks (path, ord, text, vector) values (?, ?, ?, ?)")

            chunks.forEach((chunk, ord) => insert.run(path, ord, chunk.text, vectorToBlob(chunk.vector)))

            this.database.exec("commit")

            return chunks.length
        }

        catch (exception) {

            this.database.exec("rollback")

            throw exception
        }
    }

    /** Every indexed path, with chunk counts. */
    public paths(): { path: string, chunks: number }[] {

        return this.database.prepare(`
            select path, count(*) as chunks from chunks group by path order by path
        `).all() as unknown as { path: string, chunks: number }[]
    }

    /** The top-k chunks of the whole index for one query vector. */
    public search(vector: Float32Array, k = 4): { path: string, score: number, excerpt: string }[] {

        const rows = this.database.prepare("select path, ord, text, vector from chunks").all() as unknown as { path: string, ord: number, text: string, vector: Uint8Array }[]

        const query = Array.from(vector)

        return rows

            .map(row => ({

                path: row.path,

                score: cosine(query, Array.from(vectorFromBlob(row.vector))),

                excerpt: row.text.slice(0, 240)
            }))

            .sort((a, b) => b.score - a.score)

            .slice(0, Math.max(1, Math.min(k, 16)))
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
}

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
