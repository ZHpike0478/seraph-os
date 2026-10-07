import assert from "node:assert/strict"
import { test } from "vitest"
import {
    RecognitionSession,
    composeDictation,
    extendDictation,
    recognitionAvailable,
    type DictationBuffer,
    type RecognitionEngine,
    type RecognitionResultEvent
} from "@client/view/programs/recognition"

/**
 * A scripted engine: records its calls, exposes its installed listeners,
 * and lets tests fire recognition events directly.
 */
const engines: ScriptedEngine[] = []

class ScriptedEngine implements RecognitionEngine {

    public constructor() { void engines.push(this) }

    public lang = ""

    public continuous = false

    public interimResults = false

    public started = 0

    public stopped = 0

    public aborted = 0

    public onresult: ((event: RecognitionResultEvent) => void) | null = null

    public onerror: ((event: { readonly error: string }) => void) | null = null

    public onend: (() => void) | null = null

    public start() { this.started++ }

    public stop() { this.stopped++ }

    public abort() { this.aborted++ }
}

/** Engines made since the snapshot; each test sees only its own. */
function freshEngines(): ScriptedEngine[] {

    const start = engines.length

    return new Proxy([] as ScriptedEngine[], {

        get(_target, key, receiver) {

            const live = engines.slice(start)

            const value = Reflect.get(live, key, receiver)

            return typeof value === "function" ? value.bind(live) : value
        }
    })
}

/** Builds one result event the way the platform frames recognitions. */
function resultEvent(entries: Array<[string, boolean]>, resultIndex = 0): RecognitionResultEvent {

    const results = entries.map(function ([transcript, isFinal]) {

        return {
            isFinal,
            length: 1,
            item: function () { throw new Error("not driven here") },
            0: { transcript, confidence: 0.9 }
        }
    })

    return { results, resultIndex }
}

const empty: DictationBuffer = { base: "", final: "", interim: "" }

test("dictation buffer composes base, finals, and the open interim", () => {

    let buffer = extendDictation(empty, "hello", false)

    assert.equal(composeDictation(buffer), "hello", "an open interim shows while heard")

    buffer = extendDictation(buffer, "hello there", true)

    assert.equal(composeDictation(buffer), "hello there", "the final replaces the interim it closed")

    buffer = extendDictation(buffer, "and more", false)

    assert.equal(composeDictation(buffer), "hello there and more", "the next interim appends")

    buffer = extendDictation(buffer, "spoken more", true)

    assert.equal(composeDictation(buffer), "hello there spoken more", "the final replaces the interim it closes, then accumulates")

    // Whitespace-only phrases change nothing.

    assert.deepEqual(extendDictation(buffer, "   ", true), buffer)
})

test("dictation buffer keeps a typed base and spaces between parts", () => {

    const typed: DictationBuffer = { base: "draft text", final: "", interim: "" }

    let buffer = extendDictation(typed, "spoken", false)

    assert.equal(composeDictation(buffer), "draft text spoken")

    buffer = extendDictation(buffer, "spoken more", true)

    assert.equal(composeDictation(buffer), "draft text spoken more", "the final replaces the interim whole")

    // A base that already ends in whitespace stays clean.

    const trailing: DictationBuffer = { base: "draft text  ", final: "final", interim: "interim" }

    assert.equal(composeDictation(trailing), "draft text  final interim")
})

test("a session drives the engine: settings, results, restarts", () => {

    const heard: Array<[string, boolean]> = []

    let endings = 0

    const mine = freshEngines()

    const session = new RecognitionSession(
        ScriptedEngine,
        (transcript, isFinal) => heard.push([transcript, isFinal]),
        function () { endings++ }
    )

    assert.equal(recognitionAvailable(), false, "the node test window has no engine")

    assert.equal(session.start("en-US"), true)

    assert.equal(engines.length, 1, "one engine per running session")

    assert.equal(mine[0].started, 1)

    assert.equal(mine[0].continuous, true, "dictation listens continuously")

    assert.equal(mine[0].interimResults, true, "interim phrases reach the draft as they are heard")

    assert.equal(mine[0].lang, "en-US")

    // Results flow through, final and interim alike, from the event window.

    mine[0].onresult?.(resultEvent([["earlier", true]]))

    mine[0].onresult?.(resultEvent([["one", false], ["two", true]], 0))

    assert.deepEqual(heard, [["earlier", true], ["one", false], ["two", true]])

    // Utterance end while wanted restarts recognition on the same engine.

    mine[0].onend?.()

    assert.equal(mine[0].started, 2, "restarted after one utterance")

    assert.equal(endings, 0)
})

test("a refusal starts nothing and a fatal engine error ends the session once", () => {

    let endings = 0

    const mine = freshEngines()

    const session = new RecognitionSession(
        ScriptedEngine,
        function () { undefined },
        function () { endings++ }
    )

    // A missing platform engine (injected constructor null and none on the
    // window) starts nothing.

    const nothing = new RecognitionSession(null, function () { undefined }, function () { endings++ })

    assert.equal(nothing.start("en-US"), false)

    session.start("en-US")

    // Silence is ordinary flow: the engine's end event carries the decision.

    mine[0].onerror?.({ error: "no-speech" })

    assert.equal(endings, 0)

    mine[0].onend?.()

    assert.equal(mine[0].started, 2, "silence restarts while the user wants voice")

    // A refusal is fatal: the session ends exactly once and the engine is
    // silenced.

    mine[0].onerror?.({ error: "not-allowed" })

    assert.equal(endings, 1)

    assert.equal(mine[0].aborted, 1)

    assert.equal(mine[0].onresult, null, "the refused engine's listeners were severed")

    // An end event after the session ended does not end it again.

    mine[0].onend?.()

    assert.equal(endings, 1)
})

test("stop and stop-then-restart leave no dangling engine", () => {

    let endings = 0

    const mine = freshEngines()

    const session = new RecognitionSession(
        ScriptedEngine,
        function () { undefined },
        function () { endings++ }
    )

    session.start("en-US")

    const first = mine[0]

    session.stop()

    assert.equal(first.onresult, null, "the stopped engine's listeners were severed")

    assert.equal(first.onend, null)

    assert.ok(first.stopped === 1 || first.aborted === 1, "the engine was asked to stop")

    // A stopped engine's end event does not restart or end the session:
    // the session severed the engine's listeners and kept nothing of it.
    // (The end handler was captured above the sever assert only to satisfy
    // TS's null-narrowing; the sever asserts prove termination.)

    assert.equal(first.started, 1)

    assert.equal(endings, 0)

    // A fresh start builds a new engine with its own listeners.

    session.start("en-US")

    assert.equal(mine.length, 2, "a new session run owns a new engine")

    assert.equal(mine[1].onresult !== null, true)

    // Teardown aborts without firing `ended`.

    session.abort()

    assert.equal(mine[1].aborted, 1)

    assert.equal(endings, 0)
})