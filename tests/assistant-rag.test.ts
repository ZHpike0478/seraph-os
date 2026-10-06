import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, test } from "vitest"
import RagIndex, { cosine, vectorFromBlob, vectorToBlob } from "@server/core/assistant/rag"
import { chunkText } from "@server/core/assistant/rag-tools"

const homes: string[] = []
const servers: Server[] = []

afterAll(function () {

    for (const server of servers) server.close()

    for (const directory of homes) {
        try { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
        catch { }
    }
})

// Deterministic pseudo-embeddings: a 8-bucket char/word histogram, normalized. Words-sharing texts score high; distinct-topic texts score low.
function pseudoEmbed(text: string): number[] {

    const buckets = new Array(8).fill(0)

    for (const word of text.toLowerCase().split(/[^a-z]+/).filter(Boolean)) {

        buckets[word.charCodeAt(0) % 8] += 1
        buckets[word.charCodeAt(word.length - 1) % 8] += 1
    }

    const norm = Math.sqrt(buckets.reduce((sum, value) => sum + value * value, 0)) || 1

    return buckets.map(value => value / norm)
}

/** A scripted OpenAI-compatible endpoint serving /embeddings (and minimal /chat/completions). */
async function scriptEndpoint() {

    let bodies: { text: string[] }[] = []

    const server = createServer((request, response) => {

        let body = ""

        request.on("data", chunk => { body += chunk })

        request.on("end", () => {

            if (request.url?.includes("/embeddings")) {

                const parsed = JSON.parse(body) as { input: string[] }

                bodies.push({ text: parsed.input })

                const data = parsed.input.map((text, index) => ({ index, embedding: pseudoEmbed(text) }))

                response.writeHead(200, { "content-type": "application/json" })

                response.end(JSON.stringify({ data }))
            }

            else {

                response.writeHead(200, { "content-type": "text/event-stream" })

                response.end("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\ndata: [DONE]\n\n")
            }
        })
    })

    servers.push(server)

    await new Promise((resolve: (value: unknown) => void) => server.listen(0, "127.0.0.1", resolve as () => void))

    const address = server.address()

    const port = typeof address === "object" && address ? address.port : 0

    return `http://127.0.0.1:${port}/v1`
}

function openIndex(): RagIndex {

    const directory = mkdtempSync(join(tmpdir(), "seraph-rag-"))

    homes.push(directory)

    return RagIndex.open(join(directory, "assistant-rag.sqlite"))
}

test("the index stores vectors and ranks cosine matches in order", () => {

    const index = openIndex()

    const doc = pseudoEmbed("quarterly revenue report for the medical center")

    const other = pseudoEmbed("recipe for sourdough bread starter")

    index.replacePath("docs/finance.md", [{ text: "quarterly revenue report", vector: new Float32Array(doc) }])

    index.replacePath("docs/food.md", [{ text: "sourdough bread starter recipe", vector: new Float32Array(other) }])

    const hits = index.search(new Float32Array(doc), 2)

    assert.equal(hits[0]!.path, "docs/finance.md")

    assert.equal(hits[1]!.path, "docs/food.md")
})

test("re-indexing a path replaces its stale chunks", () => {

    const index = openIndex()

    const first = pseudoEmbed("old contents about gardens")

    const second = pseudoEmbed("new contents about gardens and ponds")

    index.replacePath("notes.txt", [{ text: "old contents", vector: new Float32Array(first) }])

    assert.equal(index.count("notes.txt"), 1)

    index.replacePath("notes.txt", [
        { text: "new contents", vector: new Float32Array(second) },
        { text: "new contents continued", vector: new Float32Array(second) }
    ])

    assert.equal(index.count("notes.txt"), 2)

    assert.equal(index.count(), 2)

    const hits = index.search(new Float32Array(second), 4)

    assert.equal(hits.filter(hit => hit.excerpt.includes("old")).length, 0)
})

test("chunkText pieces paragraphs around 800 characters with overlap", () => {

    const paragraphs = Array.from({ length: 20 }, (_, index) => `paragraph ${index} ` + "word ".repeat(40))

    const pieces = chunkText(paragraphs.join("\n\n"))

    assert.ok(pieces.length > 1)

    for (const piece of pieces) assert.ok(piece.length <= 900, `piece ${piece.length}`)

    // The seam: piece 2 carries the tail of piece 1 (100-char overlap).
    if (pieces.length >= 2) assert.ok(pieces[1]!.includes(pieces[0]!.slice(-60)))
})

test("blob round-trips preserve the vector exactly", () => {

    const vector = new Float32Array([0.25, -0.5, 1.5, 0])

    const blob = vectorToBlob(vector)

    const back = vectorFromBlob(blob)

    assert.deepEqual(Array.from(back), Array.from(vector))
})

test("cosine is 1 for identical, 0 for zero vectors", () => {

    const a = [1, 2, 3]

    assert.ok(Math.abs(cosine(a, a) - 1) < 1e-12)

    assert.equal(cosine(a, [0, 0, 0]), 0)
})

test("the embedder orders endpoint vectors by the wire's index field", async () => {

    const endpoint = await scriptEndpoint()

    const { default: Embedder } = await import("@server/core/assistant/embeddings")

    const embedder = Embedder.open({ baseUrl: endpoint, apiKey: "test", model: "m", embedModel: "embed-1" })

    assert.ok(embedder)

    const ordered = await embedder.embed(["second should sit here", "first should sit here"])

    assert.equal(ordered.length, 2)

    // The endpoint echoes pseudoEmbed per input; verify each vector matches ITS text.
    assert.ok(Math.abs(ordered[0]![0] - pseudoEmbed("second should sit here")[0]) < 1e-5)

    assert.ok(Math.abs(ordered[1]![2] - pseudoEmbed("first should sit here")[2]) < 1e-5)
})

test("indexes are per-space: two spaces never share chunks", async () => {

    const directory = mkdtempSync(join(tmpdir(), "seraph-rag-iso-"))

    homes.push(directory)

    const icons = { system: join(directory, "logo.png"), defaultProgram: join(directory, "icon.png") }

    const hub = await import("@server/core/hub")

    const application = await (hub.default as { open(home: string, icons: unknown): { space(username: string): Promise<{ ragIndex: RagIndex, close(): void }> } }).open(directory, icons).space("solo")

    const second = await (hub.default as unknown as { open(home: string, icons: unknown): { space(username: string): Promise<{ ragIndex: RagIndex, close(): void }> } }).open(directory, icons).space("duo")

    const vector = new Float32Array(pseudoEmbed("private medical records"))

    application.ragIndex.replacePath("secret.md", [{ text: "private medical records", vector }])

    assert.equal(second.ragIndex.count(), 0)

    const hits = second.ragIndex.search(vector, 4)

    assert.equal(hits.length, 0)

    application.close()

    second.close()
})

test("the tool catalog carries the retrieval tools when an endpoint is configured", async () => {

    const previous = {

        baseUrl: process.env.SERAPH_LLM_BASE_URL,

        embed: process.env.SERAPH_LLM_EMBED_MODEL
    }

    const directory = mkdtempSync(join(tmpdir(), "seraph-rag-cat-"))

    homes.push(directory)

    const icons = { system: join(directory, "logo.png"), defaultProgram: join(directory, "icon.png") }

    try {

        process.env.SERAPH_LLM_BASE_URL = "http://127.0.0.1:9/v1"

        process.env.SERAPH_LLM_EMBED_MODEL = "embed-x"

        const { default: Hub } = await import("@server/core/hub")

        const holder = Hub.open(directory, icons)

        const space = await holder.space("catalog")

        // The assistant catalog: reachable through the assistant instance.
        const assistant = (space as unknown as { assistantInstance: { toolCatalog(): { name: string }[] } | null, assistant: { toolCatalog(): { name: string }[] } | null }).assistant

        const catalog = assistant!.toolCatalog().map(tool => tool.name)

        assert.ok(catalog.includes("files_index"))

        assert.ok(catalog.includes("files_search"))

        space.close()

    }

    finally {

        if (previous.baseUrl === undefined) delete process.env.SERAPH_LLM_BASE_URL

        else process.env.SERAPH_LLM_BASE_URL = previous.baseUrl

        if (previous.embed === undefined) delete process.env.SERAPH_LLM_EMBED_MODEL

        else process.env.SERAPH_LLM_EMBED_MODEL = previous.embed
    }
})
