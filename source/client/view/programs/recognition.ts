/**
 * Speech-to-text for the chat window, typed structurally instead of through
 * the platform's globals.
 *
 * This repository's TypeScript DOM types carry the Web Speech result and
 * event interfaces but no `SpeechRecognition` constructor declaration (the
 * spec moved the class to its own module). Rather than reaching through
 * `any` or a global `declare var`, one structural facade lives here: it
 * carries only the surface voice input uses, and every platform object it
 * touches is narrowed through unknown.
 *
 * The recognition engine is the browser's own (Chrome, Edge, Safari): audio
 * goes to whatever service the browser vendor chose, never through the
 * System. A session listens continuously until stopped; the platform's end
 * events restart recognition while the user still wants voice. A refusal or
 * a missing engine surfaces as a false return and one `ended` callback,
 * never as an error the user has to dismiss.
 */

/** One recognized phrase, in the shape of the platform's alternative. */
export interface RecognitionAlternative {

    readonly transcript: string

    readonly confidence: number
}

/** The part of one recognition result voice input reads. */
export interface RecognitionResult {

    readonly isFinal: boolean

    readonly 0: RecognitionAlternative
}

/** The event the platform fires for each recognition batch. */
export interface RecognitionResultEvent {

    readonly results: ArrayLike<RecognitionResult>

    readonly resultIndex: number
}

/** What voice input does with what was heard. */
export type RecognitionListener = (transcript: string, isFinal: boolean) => void

/**
 * The recognition surface voice input drives, constructed from whichever
 * vendor object the window carries rather than from these types' globals.
 */
export interface RecognitionEngine {

    lang: string

    continuous: boolean

    interimResults: boolean

    start(): void

    stop(): void

    abort(): void

    onresult: ((event: RecognitionResultEvent) => void) | null

    onerror: ((event: { readonly error: string }) => void) | null

    onend: (() => void) | null
}

/**
 * Where the platform keeps the engine constructor: `SpeechRecognition`
 * (standard, Safari), `webkitSpeechRecognition` (Chromium). Read through
 * unknown and narrowed by use, so a renamed future surface degrades to
 * "unsupported" instead of a crash.
 */
function findEngine(): (new () => RecognitionEngine) | null {

    const vendor = (typeof window === "undefined" ? null : window) as unknown as Record<string, unknown> | null

    if (!vendor) return null

    for (const key of ["SpeechRecognition", "webkitSpeechRecognition"]) {

        if (typeof vendor[key] === "function") return vendor[key] as new () => RecognitionEngine
    }

    return null
}

/**
 * Dictation composes the input's text from three parts: the draft as it
 * stood when listening began, the phrases closed as final, and the phrase
 * still being spoken. Both halves are pure so they test without a browser,
 * microphone, or network.
 */
export interface DictationBuffer {

    base: string

    final: string

    interim: string
}

/** Folds one recognized phrase into the dictation buffer. */
export function extendDictation(buffer: DictationBuffer, transcript: string, isFinal: boolean): DictationBuffer {

    const phrase = transcript.trim()

    if (!phrase) return buffer

    // An interim retells itself until its own final arrives, which replaces
    // it; finals accumulate phrase by phrase. Interim text stays trimmed,
    // so composing decides spacing once.

    if (!isFinal) return { ...buffer, interim: phrase }

    // The final is the open interim's own utterance, finished: it replaces
    // the interim whole, however far the interim had gotten. In a
    // continuous session only one result window is live, so nothing open
    // can belong to another phrase - replacing is lossless.

    return { ...buffer, final: (buffer.final + " " + phrase).trim(), interim: "" }
}

/** The draft text one dictation buffer composes to. */
export function composeDictation(buffer: DictationBuffer): string {

    let text = buffer.base

    for (const segment of [buffer.final, buffer.interim]) {

        const phrase = segment.trim()

        if (!phrase) continue

        if (text && !/\s$/.test(text)) text += " "

        text += phrase
    }

    return text
}

/**
 * One live recognition session. A session owns one engine instance and its
 * restart loop: the platform's end event while the session still wants
 * audio starts recognition again, and a fatal engine state ends the session
 * once, through `ended`, so the caller's button can rest. The engine
 * constructor is injectable; tests drive a scripted one and the browser
 * supplies its own when it is `null`.
 */
export class RecognitionSession {

    private engine: RecognitionEngine | null = null

    private wanted = false

    public constructor(
        private readonly construct: (new () => RecognitionEngine) | null,
        private readonly onResult: RecognitionListener,
        private readonly ended: () => void
    ) { }

    /** Begins listening; true once the engine accepted the start. */
    public start(lang: string): boolean {

        if (this.wanted) return true

        const construct = this.construct ?? findEngine()

        if (!construct) return false

        const engine = new construct()

        const session = this

        engine.lang = lang

        engine.continuous = true

        engine.interimResults = true

        engine.onresult = event => session.report(event)

        engine.onerror = event => session.fail(event.error)

        engine.onend = function () {

            // The platform ends recognition after every utterance; while
            // the user still wants voice, start again on this engine. A
            // refused restart ends the session quietly instead.

            if (!session.wanted) return

            try { engine.start() }

            catch { session.halt() }
        }

        this.engine = engine

        try {

            engine.start()

            this.wanted = true

            return true
        }

        catch {

            this.halt()

            return false
        }
    }

    /** Stops the session; whatever was heard stays in the draft. */
    public stop() {

        this.wanted = false

        const engine = this.engine

        if (!engine) return

        this.engine = null

        this.detach(engine)

        try { engine.stop() }

        catch { try { engine.abort() } catch { } }
    }

    /** Ends the session after a fatal engine state: once, and quietly. */
    private halt() {

        this.wanted = false

        const engine = this.engine

        this.engine = null

        if (engine) {

            this.detach(engine)

            try { engine.abort() }

            catch { }
        }

        this.ended()
    }

    /** One engine's refusal: fatal ones end the session, the rest pass. */
    private fail(reason: string) {

        // no-speech and aborted are ordinary flow (silence, or the stop the
        // session itself called for); the platform confirms either with its
        // own end event, which the restart loop answers while wanted.

        if (reason === "no-speech" || reason === "aborted") return

        this.halt()
    }

    /** Hands every new result from the event's window to the listener. */
    private report(event: RecognitionResultEvent) {

        for (let index = event.resultIndex; index < event.results.length; index++) {

            const result = event.results[index]

            const alternative = result?.[0]

            if (!alternative) continue

            this.onResult(alternative.transcript, result.isFinal)
        }
    }

    /** Severs one engine's listeners so it can outlive its session. */
    private detach(engine: RecognitionEngine) {

        engine.onresult = null

        engine.onerror = null

        engine.onend = null
    }

    /** Severs and silences this session's live engine, if it has one. */
    public abort() {

        this.wanted = false

        const engine = this.engine

        if (!engine) return

        this.engine = null

        this.detach(engine)

        try { engine.abort() }

        catch { }
    }
}

/** Whether this environment offers speech recognition at all. */
export function recognitionAvailable(): boolean {

    return typeof window !== "undefined" && findEngine() !== null
}