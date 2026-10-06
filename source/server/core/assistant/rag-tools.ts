import Application from "../application"
import type { AssistantTool } from "./assistant"
import Embedder from "./embeddings"

/**
 * The retrieval tools, present only when an embeddings model is configured at
 * the assistant's own endpoint. They index and search the user's own files
 * inside the space's rag index - the same storage root files_read reads.
 */
export default function ragTools(application: Application, embedder: Embedder): AssistantTool[] {

    const home = application.home

    const index = application.ragIndex

    async function embedChunks(texts: string[]): Promise<Float32Array[]> {

        return await embedder.embed(texts)
    }

    return [
        {
            name: "files_index",
            description: "Index the user's files for semantic search: pass a file path or a directory to index every text file under it, recursively.",
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

                for (const filePath of collected) {

                    const text = await readWholeFile(home, filePath)

                    if (text === null) continue

                    const pieces = chunkText(text)

                    if (pieces.length === 0) continue

                    const vectors = await embedChunks(pieces)

                    indexed += index.replacePath(filePath.join("/"), pieces.map((text, position) => ({ text, vector: vectors[position]! })))
                }

                return { indexed, files: collected.length }
            }
        },

        {
            name: "files_search",
            description: "Search the user's indexed files semantically. Returns the closest excerpts with their file paths; index first with files_index.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "What to look for, in natural language" },
                    k: { type: "number", description: "How many matches (default 4)" }
                },
                required: ["query"]
            },
            async execute({ query, k }: { query: string, k?: number }) {

                if (index.count() === 0) return { error: "Nothing is indexed yet; use files_index first." }

                const vector = await embedder.embedOne(query)

                return {
                    matches: index.search(vector, typeof k === "number" ? k : 4)
                }
            }
        }
    ]
}

async function collect(home: Application["home"], path: string[], into: string[][]) {

    const entries = home.list(path)

    for (const entry of entries) {

        if (entry.kind === "file") into.push(entry.path)

        else await collect(home, entry.path, into)
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

        if (size > 512 * 1024) {

            await reader.cancel()

            return null
        }

        chunks.push(value)
    }

    return chunksToText(chunks)
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
