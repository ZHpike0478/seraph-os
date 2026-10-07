import { useEffect, useRef, useState } from "react"
import { LucideMic, LucideMicAudioLines, type LucideIcon } from "@phreshos/react-ui/icons"
import {
    RecognitionSession,
    composeDictation,
    extendDictation,
    recognitionAvailable,
    type DictationBuffer
} from "./recognition"

/** Language the recognition engine listens in (BCP 47). */
const recognitionLanguage = "en-US"

/** The dictation toggle's state machine, split from rendering so the chat window keeps its own effect order. */
function useDictation(setDraft: (update: (current: string) => string) => void) {

    const [listening, setListening] = useState(false)

    const buffer = useRef<DictationBuffer>({ base: "", final: "", interim: "" })

    const session = useRef<RecognitionSession | null>(null)

    useEffect(function () {

        return function () {

            session.current?.abort()

            session.current = null
        }
    }, [])

    function toggle() {

        const live = session.current

        // Press while listening: stop. Whatever was heard stays in the draft.

        if (live) {

            live.stop()

            session.current = null

            setListening(false)

            return
        }

        if (!recognitionAvailable()) return

        // The draft as it stood when listening began is the base; dictation
        // appends to it and never clobbers typed text.

        buffer.current.base = ""

        setDraft(current => {

            buffer.current.base = current

            return current
        })

        const session_ = new RecognitionSession(
            null,
            function (transcript, isFinal) {

                buffer.current = extendDictation(buffer.current, transcript, isFinal)

                setDraft(() => composeDictation(buffer.current))
            },
            function () {

                session.current = null

                buffer.current = { base: "", final: "", interim: "" }

                setListening(false)
            }
        )

        if (!session_.start(recognitionLanguage)) return

        session.current = session_

        setListening(true)
    }

    return { listening, toggle }
}

/**
 * The chat input's dictation toggle, next to Send. Listens through the
 * browser's Web Speech engine with the user's own microphone, folds what it
 * hears into the draft as text, and stops on a second press or when the
 * platform refuses. Renders nothing where the browser offers no engine.
 */
export default function VoiceButton({ setDraft }: { setDraft: (update: (current: string) => string) => void }) {

    const { listening, toggle } = useDictation(setDraft)

    if (!recognitionAvailable()) return null

    const Icon: LucideIcon = listening ? LucideMicAudioLines : LucideMic

    return <button
        type="button"
        aria-pressed={listening}
        aria-label={listening ? "Stop dictation" : "Start dictation"}
        title={listening ? "Stop dictation" : "Dictate"}
        className={"inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-border " +
            (listening ? "bg-primary/15 text-primary animate-pulse" : "bg-card opacity-80 hover:opacity-100")}
        onClick={toggle}
    >

        <Icon className="size-4" />

    </button>
}