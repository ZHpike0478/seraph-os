import Application from "../application"
import type { AssistantTool } from "./assistant"
import Embedder from "./embeddings"

/** One file the indexer could not use, and why. */
export type SkippedFile = Readonly<{

    path: string

    reason: string
}>

/** File kinds the indexer can read as text; everything else is skipped, not guessed at. */
export const INDEXABLE_EXTENSIONS = new Set([
    ".txt", ".md", ".markdown", ".rst", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc",
    ".html", ".htm", ".css", ".scss", ".svg", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
    ".csv", ".tsv", ".log", ".sh", ".bash", ".ps1", ".py", ".rb", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".sql",
    ".env", ".gitignore", ".editorconfig", ".properties"
])

/** Cap per file, matching the tool that surfaces file contents to the model. */
const MAX_FILE_BYTES = 512 * 1024

/** Above roughly this ratio of replacement characters, bytes are not text. */
const REPLACEMENT_RATIO = 0.01

/** Embeddings ride in batches: one request per file would refuse at scale. */
const EMBED_BATCH = 32

/**
 * The retrieval tools, present only when an embeddings model is configured at
 * the assistant's own endpoint. They index and search the user's own files
 * inside the space's rag index - the same storage root files_read reads.
 */
export default function ragTools(application: Application, embedder: Embedder): AssistantTool[] {

    const home = application.home

    const index = application.ragIndex

    // This endpoint's vector geometry: chunks from another model carry no
    // meaning here, so a changed model resets the index (the next search
    // reports a reset and points at reindexing).
    const adopted = index.adoptModel(embedder.embedModel)

    async function embedChunks(texts: string[]): Promise<Float32Array[]> {

        const vectors: Float32Array[] = []

        for (let start = 0; start < texts.length; start += EMBED_BATCH) {

            vectors.push(...await embedder.embed(texts.slice(start, start + EMBED_BATCH)))
        }

        return vectors
    }

    return [
        {
            name: "files_index",
            description: "Index the user's files for semantic search: pass a file path or a directory to index every text file under it, recursively. Binary and unknown file kinds are skipped.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "array", items: { type: "string" }, description: "File or directory path as a list of names" }
                },
                required: ["path"]
            },
            async execute({ path }: { path: string[] }) {

                const collected: string[][] = []

                await collect(home, path ?? [], collected)

                if (collected.length === 0) return { error: "The path does not exist in this space" }

                let indexed = 0

                const skipped: SkippedFile[] = []

                for (const filePath of collected) {

                    const joined = filePath.join("/")

                    if (!isIndexableName(joined)) {

                        skipped.push({ path: joined, reason: "not a text file kind" })

                        continue
                    }

                    const source = home.stat(filePath)

                    const byteSize = source?.kind === "file" ? source.size : 0

                    let text: string | null = null

                    try { text = await readWholeFile(home, filePath) }

                    catch {

                        // A file that vanished or refuses mid-walk skips like
                        // any other unreadable one; it never aborts the run.
                        skipped.push({ path: joined, reason: "could not be read" })

                        continue
                    }

                    if (text === null) {

                        skipped.push({ path: joined, reason: "too large or unreadable" })

                        continue
                    }

                    if (looksBinary(text)) {

                        skipped.push({ path: joined, reason: "looks binary" })

                        continue
                    }

                    const pieces = chunkText(text)

                    if (pieces.length === 0) continue

                    // Each chunk knows which file it came from: paragraphs of
                    // a README and a CHANGELOG stop sounding identical.
                    const titled = pieces.map(piece => `${joined}\n${piece}`)

                    const vectors = await embedChunks(titled)

                    indexed += index.replacePath(joined, pieces.map((piece, position) => ({ text: piece, vector: vectors[position]! })), {

                        size: byteSize,

                        modifiedAt: source?.modifiedAt ?? 0
                    })
                }

                return { indexed, files: collected.length, skipped }
            }
        },

        {
            name: "files_search",
            description: "Search the user's indexed files. Blends meaning and exact-match keyword search; returns excerpts with paths, freshness (indexedAt, modifiedAt), and similarity scores. Index first with files_index. Excerpts may be stale: re-read a file with files_read before quoting it.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "What to look for, in natural language or as exact words/identifiers" },
                    k: { type: "number", description: "How many matches (default 4)" }
                },
                required: ["query"]
            },
            async execute({ query, k }: { query: string, k?: number }) {

                if (adopted === "reset") return { error: "The embedding model changed since indexing; use files_index to reindex." }

                if (index.count() === 0) return { error: "Nothing is indexed yet; use files_index first." }

                const vector = await embedder.embedOne(query)

                const matches = index.search(vector, typeof k === "number" ? k : 4, { text: query, floor: 0.3 })

                if (matches.length === 0) return { matches: [], note: "Nothing close enough; try different words or index more files." }

                return { matches }
            }
        }
    ]
}

async function collect(home: Application["home"], path: string[], into: string[][]) {

    // Storage lists answer with paths relative to the listed directory, so
    // each recursion joins them back onto the path it came from: a nested
    // file must index under notes/deep.txt, never as a phantom deep.txt.
    const entries = home.list(path)

    for (const entry of entries) {

        const absolute = [...path, ...entry.path]

        if (entry.kind === "file") into.push(absolute)

        else await collect(home, absolute, into)
    }
}

async function readWholeFile(home: Application["home"], path: string[]): Promise<string | null> {

    const chunks: Uint8Array[] = []

    const body = home.stream(path)

    const reader = body.getReader()

    let size = 0

    while (true) {

        const { done, value } = await reader.read()

        if (done) break

        size += value.byteLength

        if (size > MAX_FILE_BYTES) {

            await reader.cancel()

            return null
        }

        chunks.push(value)
    }

    return chunksToText(chunks)
}

/** A file kind the indexer accepts: by extension, with bare dotfiles by name. */
export function isIndexableName(name: string): boolean {

    const last = name.split("/").pop() ?? ""

    return INDEXABLE_EXTENSIONS.has(extensionOf(last))
}

function extensionOf(name: string): string {

    const dot = name.lastIndexOf(".")

    if (dot <= 0) return name.startsWith(".") ? name.toLowerCase() : ""

    return name.slice(dot).toLowerCase()
}

/** Cheap binary detector: enough U+FFFD replacement characters means not text. */
export function looksBinary(text: string): boolean {

    let replacements = 0

    for (let position = 0; position < text.length; position++) {

        if (text.charCodeAt(position) === 0xfffd) replacements++

        if (replacements > REPLACEMENT_RATIO * text.length) return true
    }

    return false
}

/** ~800-character pieces on paragraph boundaries with a 100-character overlap. */
export function chunkText(text: string): string[] {

    const paragraphs = text.split(/\n\s*\n/)

    const pieces: string[] = []

    let current = ""

    for (const paragraph of paragraphs) {

        if ((current + "\n\n" + paragraph).length > 800 && current) {

            pieces.push(current)

            current = current.slice(-100) + "\n\n" + paragraph
        }

        else current = current ? current + "\n\n" + paragraph : paragraph
    }

    if (current.trim()) pieces.push(current)

    return pieces.filter(piece => piece.trim().length > 0)
}

function chunksToText(chunks: Uint8Array[]) {

    return chunks.map(chunk => new TextDecoder().decode(chunk)).join("")
}