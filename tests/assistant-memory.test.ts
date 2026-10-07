import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, test } from "vitest"
import AssistantMemory from "@server/core/assistant/memory"

const homes: string[] = []

afterAll(function () {

    for (const directory of homes) {

        try { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
        catch { }
    }
})

function open(): AssistantMemory {

    const directory = mkdtempSync(join(tmpdir(), "seraph-memory-"))

    homes.push(directory)

    return AssistantMemory.open(join(directory, "assistant.sqlite"))
}

test("conversation history keeps order and trims from the newest side", () => {

    const memory = open()

    memory.append("user", "one")
    memory.append("assistant", "two")
    memory.append("user", "three")

    const recent = memory.recent(2)

    assert.deepEqual(recent.map(message => message.content), ["two", "three"])

    memory.clearConversation()

    assert.deepEqual(memory.recent(10), [])
})

test("facts are saved, recalled by keyword, and forgotten", () => {

    const memory = open()

    memory.remember("The user prefers dark theme")
    memory.remember("The user is building a rocket stove in the garage")

    const found = memory.recall("dark")

    assert.equal(found.length, 1)
    assert.equal(found[0]!.text, "The user prefers dark theme")

    const none = memory.recall("unrelated nothing")

    assert.deepEqual(none, [])

    const many = memory.recall("garage stove")

    assert.equal(many.length, 1)
    assert.equal(many[0]!.text, "The user is building a rocket stove in the garage")

    memory.forget(many[0]!.identity)

    assert.deepEqual(memory.recall("garage"), [])
})

test("memory persists across reopen", () => {

    const directory = mkdtempSync(join(tmpdir(), "seraph-memory-"))

    homes.push(directory)

    const path = join(directory, "assistant.sqlite")

    const first = AssistantMemory.open(path)

    first.append("user", "persisted question")

    first.remember("persisted fact")

    first.close()

    const second = AssistantMemory.open(path)

    assert.deepEqual(second.recent(10).map(message => message.content), ["persisted question"])
    assert.equal(second.recall("persisted").length, 1)
})

test("re-remembering a fact updates it instead of duplicating it", () => {

    const memory = open()

    const first = memory.remember("The user's name is Steph")

    const again = memory.remember("The user's name is Steph, spelled s-t-e-p-h")

    assert.equal(again, first, "the near-duplicate adopts the original identity")

    assert.equal(memory.recall("name").length, 1, "no duplicate row accumulated")

    const unrelated = memory.remember("The user builds rocket stoves")

    assert.notEqual(unrelated, first, "a genuinely new fact keeps its own identity")

    assert.equal(memory.recall("stove").length, 1)
})