import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, test } from "vitest"
import RagIndex, { keywordQuery } from "@server/core/assistant/rag"
import ragTools, { looksBinary, isIndexableName } from "@server/core/assistant/rag-tools"
import { FileSystem } from "@libs/file-area"

const homes: string[] = []

const servers: Server[] = []

afterAll(function () {

    for (const server of servers) server.close()

    for (const directory of homes) {
        try { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
        catch { }
    }
})

// A word-hash bag rather than the char-bucket pseudoEmbed: discriminating
// enough that the right document wins a top-k assertion on its own merits.
function bagEmbed(text: string): number[] {

    const buckets = new Array(16).fill(0)

    for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {

        let hash = 0

        for (const character of word) hash = (hash * 31 + character.charCodeAt(0)) % 997

        buckets[hash % 16] += 1
    }

    const norm = Math.sqrt(buckets.reduce((sum, value) => sum + value * value, 0)) || 1

    return buckets.map(value => value / norm)
}

function openIndex(): RagIndex {

    const directory = mkdtempSync(join(tmpdir(), "seraph-retrieval-"))

    homes.push(directory)

    return RagIndex.open(join(directory, "assistant-rag.sqlite"))
}

const CORPUS = {
    ports: "notes/constants.md",
    cookies: "docs/baking.md",
    standup: "docs/meeting.md"
}

const CONTENT = {
    [CORPUS.ports]: "The hub service listens on port 6400 and the gate listens on 6300. Every door requires a bearer token.",
    [CORPUS.cookies]: "Sift the flour, cream the butter with sugar, and chill the dough before baking the cookies.",
    [CORPUS.standup]: "Standup notes: the retrieval index ships without a vector database, and the reranker waits for the next milestone."
}

function seedCorpus(index: RagIndex) {

    // Vectors come from the document's words, as a real embedder would see them.
    index.replacePath(CORPUS.ports, [{ text: CONTENT[CORPUS.ports], vector: new Float32Array(bagEmbed(CONTENT[CORPUS.ports])) }], { size: 120, modifiedAt: 1_000 })

    index.replacePath(CORPUS.cookies, [{ text: CONTENT[CORPUS.cookies], vector: new Float32Array(bagEmbed(CONTENT[CORPUS.cookies])) }], { size: 200, modifiedAt: 2_000 })

    index.replacePath(CORPUS.standup, [{ text: CONTENT[CORPUS.standup], vector: new Float32Array(bagEmbed(CONTENT[CORPUS.standup])) }], { size: 300, modifiedAt: 3_000 })
}

test("a semantic query finds its document on the cosine leg alone", () => {

    const index = openIndex()

    seedCorpus(index)

    // No query text: pure vectors, the old behavior upgraded to RRF scoring.
    const query = new Float32Array(bagEmbed("cream butter sugar dough bake"))

    const hits = index.search(query, 2)

    assert.equal(hits[0]!.path, CORPUS.cookies)

    assert.ok(hits[0]!.cosine > hits[1]!.cosine)

    assert.equal(hits[0]!.matched, false)
})

test("an exact identifier reaches its chunk only through the keyword leg", () => {

    const index = openIndex()

    // The ports chunk carries a zero vector: no geometry information at
    // all, so no cosine leg can rank it. Only the keyword leg, fed an
    // exact identifier, can surface it — past a floor that dismisses all
    // of its cosine-only rivals.
    index.replacePath("notes/ports.md", [{ text: "The hub service listens on port 6400 and the gate listens on 6300. Every door requires a bearer token.", vector: new Float32Array(16) }], { size: 120, modifiedAt: 1_000 })

    seedCorpus(index)

    const text = "what listens on 6300"

    const hits = index.search(new Float32Array(bagEmbed(text)), 4, { text, floor: 0.3 })

    const port = hits.find(hit => hit.path === "notes/ports.md")

    assert.ok(port, JSON.stringify(hits))

    assert.equal(port!.matched, true)

    assert.equal(hits[0]!.matched, true, "a keyword hit outranks every cosine-only hit")
})

test("the floor drops cosine-only fuzz but never a keyword match", () => {

    const index = openIndex()

    seedCorpus(index)

    // No keyword leg and nothing close: the floor empties the result
    // instead of serving noise as fact.
    const noise = index.search(new Float32Array(16), 8, { floor: 0.3 })

    assert.deepEqual(noise, [])

    // The same query with an exact identifier present: the ports chunk
    // (zero-vector, cosine 0, below any floor) stands because its words
    // matched. Every cosine-only hit that survived is above the floor.
    const kept = index.search(new Float32Array(16), 8, { text: "6300", floor: 0.3 })

    assert.ok(kept.some(hit => hit.path === CORPUS.ports && hit.matched))

    assert.ok(kept.every(hit => hit.matched || hit.cosine >= 0.3))
})

test("dimension mismatches score zero instead of NaN", () => {

    const index = openIndex()

    seedCorpus(index)

    // A stray vector of another geometry must not poison the ranking.
    const stray = new Float32Array(bagEmbed("standup notes retrieval"))

    assert.equal(stray.length, 16)

    index.replacePath("odd.md", [{ text: "standup notes retrieval", vector: stray.slice(0, 7) }])

    const hits = index.search(new Float32Array(bagEmbed("standup notes retrieval")), 3)

    for (const hit of hits) {

        assert.ok(Number.isFinite(hit.cosine), `cosine ${hit.cosine} for ${hit.path}`)

        assert.ok(Number.isFinite(hit.score))
    }

    assert.ok(hits.every(hit => hit.path !== "odd.md"), "a mismatched vector carries no similarity")
})

test("hits carry their freshness and the index stamps the embedding model", () => {

    const index = openIndex()

    const first = Date.now() - 50

    index.replacePath("diary.md", [{ text: "diary line one", vector: new Float32Array(bagEmbed("diary line one")) }], { size: 42, modifiedAt: first })

    let hits = index.search(new Float32Array(bagEmbed("diary line")), 1, { text: "diary line" })

    assert.equal(hits[0]!.size, 42)

    assert.equal(hits[0]!.modifiedAt, first)

    assert.ok(hits[0]!.indexedAt >= first)

    const second = Date.now()

    index.replacePath("diary.md", [{ text: "diary line two", vector: new Float32Array(bagEmbed("diary line two")) }], { size: 45, modifiedAt: second })

    hits = index.search(new Float32Array(bagEmbed("diary line")), 1, { text: "diary line" })

    assert.equal(hits[0]!.modifiedAt, second)

    assert.ok(hits[0]!.indexedAt > first, "re-indexing refreshes indexedAt")

    assert.equal(index.adoptModel("embed-a"), "created")

    assert.equal(index.embedModel, "embed-a")

    index.replacePath("diary.md", [{ text: "diary line three", vector: new Float32Array(bagEmbed("diary")) }], { size: 60, modifiedAt: second })

    assert.equal(index.adoptModel("embed-b"), "reset", "a new geometry resets every chunk")

    assert.equal(index.count(), 0)

    assert.equal(index.embedModel, "embed-b")

    assert.equal(index.adoptModel("embed-b"), "current")
})

test("the keyword query builder keeps prefixes and drops stopwords", () => {

    assert.equal(keywordQuery("the a of"), null)

    assert.equal(keywordQuery("what listens on 6300"), "listens* 6300*")

    assert.equal(keywordQuery(undefined), null)
})

test("files_index skips non-text kinds, binaries, and reports what it skipped", async () => {

    const directory = mkdtempSync(join(tmpdir(), "seraph-rag-ingest-"))

    homes.push(directory)

    mkdirSync(join(directory, "notes"), { recursive: true })

    writeFileSync(join(directory, "README.md"), "The gate listens on 6300 with flour and butter everywhere.")
    writeFileSync(join(directory, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 0]))
    writeFileSync(join(directory, "model.bin"), Buffer.from(Array.from({ length: 128 }, (_, index) => index % 256)))
    writeFileSync(join(directory, "notes", "deep.txt"), "deep content about gardens")

    let bodies: string[][] = []

    const endpoint = createServer((request, response) => {

        let body = ""

        request.on("data", chunk => { body += chunk })

        request.on("end", () => {

            const parsed = JSON.parse(body) as { input: string[] }

            bodies.push(parsed.input)

            response.writeHead(200, { "content-type": "application/json" })

            response.end(JSON.stringify({ data: parsed.input.map((text, index) => ({ index, embedding: bagEmbed(text) })) }))
        })
    })

    servers.push(endpoint)

    await new Promise((resolve: (value: unknown) => void) => endpoint.listen(0, "127.0.0.1", resolve as () => void))

    const address = endpoint.address()

    const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1`

    const { default: Embedder } = await import("@server/core/assistant/embeddings")

    const index = openIndex()

    index.adoptModel("embed-eval")

    const tools = ragTools({ home: new FileSystem(directory), ragIndex: index } as never, Embedder.open({ baseUrl, apiKey: "", embedModel: "embed-eval", model: "m" })!)

    const indexTool = tools.find(tool => tool.name === "files_index")!

    const result = await indexTool.execute({ path: [] }) as { indexed: number, files: number, skipped: { path: string, reason: string }[] }

    // Files: 4 walked, 2 indexed (README + the nested deep.txt), 2 skipped
    // by kind. The nested file indexing under its real path is the
    // relative-walk fix made visible.
    assert.equal(result.files, 4)

    assert.equal(result.indexed, 2)

    assert.equal(result.skipped.length, 2)

    // The PNG is refused by kind before its bytes are ever read; a binary
    // wearing a text extension is what looksBinary catches.
    assert.deepEqual(result.skipped.map(entry => entry.path).sort(), ["model.bin", "photo.png"])

    // Chunks arrive at the embedder with their file path prefixed.
    assert.ok(bodies.some(batch => batch.some(text => text.startsWith("README.md\n"))))
})

test("a verbatim quote finds its own chunk, every time", () => {

    const index = openIndex()

    // One file, four chunks of distinct subject matter.
    const chunks = [
        "The launch sequence begins with pressurizing the helium tanks to 180 bar and opening the fuel valves.",
        "Sourdough starters need feeding with equal masses of flour and water every day the kitchen stays warm.",
        "The quarterly revenue report shows the medical center contract doubling year over year since March.",
        "Rocket stove designs channel heat through an insulated J-shaped burn chamber to burn wood gas."
    ]

    index.replacePath("docs/notes.md", chunks.map(piece => ({ text: piece, vector: new Float32Array(bagEmbed(piece)) })), { size: 999, modifiedAt: 5 })

    // The property: quote any six consecutive words, and that exact chunk
    // comes back first with its keyword leg lit. This is what a pure
    // cosine index promises and fails.
    for (const [position, piece] of chunks.entries()) {

        // A verbatim quote keeps each word as written ("J-shaped" stays
        // "J-shaped"); only case drops, since FTS matching ignores it.
        const words = piece.split(/\s+/).map(word => word.toLowerCase())

        for (const offset of [0, 6]) {

            const quote = words.slice(offset, offset + 6).join(" ")

            if (words.length - offset < 6) continue

            const hits = index.search(new Float32Array(bagEmbed(quote)), 2, { text: quote })

            const top = hits[0]

            assert.ok(top, `quote "${quote}" returned nothing`)

            assert.ok(top.matched, `quote "${quote}" won on cosine luck, not words`)

            assert.ok(top.excerpt.toLowerCase().includes(quote), `quote "${quote}" surface ${top.path} @${top.ord} instead of chunk ${position}`)
        }
    }
})

test("the binary and kind checks behave on names and text", () => {

    assert.equal(looksBinary("plain ascii text"), false)

    const soup = String.fromCharCode(0xfffd).repeat(20)

    assert.equal(looksBinary(soup), true)

    assert.equal(isIndexableName("notes/plan.md"), true)

    assert.equal(isIndexableName("data.csv"), true)

    assert.equal(isIndexableName("image.png"), false)

    assert.equal(isIndexableName("archive.gz"), false)

    assert.equal(isIndexableName("no_extension_here"), false)
})