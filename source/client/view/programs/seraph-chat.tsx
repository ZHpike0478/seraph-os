import { useState, useRef, useEffect, useCallback } from "react"
import { AuthManagerContext } from "../contexts"
import AssistantSettings from "./assistant-settings"
import VoiceButton from "./voice-button"

type StoredMessage = { role: string, content: string, at: number }

/**
 * Seraph, the assistant, as a desktop Program window: the user's own
 * conversation history, streaming replies, and the model's tools listed in
 * the footer. History lives in the user's space on the server.
 */
export default function SeraphChat() {

    const auth = AuthManagerContext.useValue()

    const [state, setState] = useState<{ available: boolean, tools: { name: string, description: string }[] } | null>(null)

    const [history, setHistory] = useState<StoredMessage[]>([])

    const [draft, setDraft] = useState("")

    const [pending, setPending] = useState(false)

    const [streaming, setStreaming] = useState("")

    const bottom = useRef<HTMLDivElement>(null)

    const [reloadState, setReloadState] = useState(0)

    const refreshState = useCallback(function () { setReloadState(current => current + 1) }, [])

    useEffect(function () {

        let stopChunks

        void (async function () {

            const [assistantState, assistantHistory] = await Promise.all([

                auth.$outbound.publishFirst<{ available: boolean, tools: { name: string, description: string }[] }>("/assistant/state"),

                auth.$outbound.publishFirst<StoredMessage[]>("/assistant/history")
            ])

            setState(assistantState)

            setHistory(assistantHistory)
        })()

        stopChunks = auth.$inbound.subscribe("/assistant/chunk", (delta: unknown) => {

            if (typeof delta !== "string") return

            setStreaming(current => current + delta)
        })

        return () => { stopChunks?.() }

    }, [auth, reloadState])

    useEffect(function () {

        bottom.current?.scrollIntoView({ behavior: "smooth" })

    }, [history, streaming])

    async function send() {

        const content = draft.trim()

        if (!content || pending) return

        setDraft("")

        setHistory(current => [...current, { role: "user", content, at: Date.now() }])

        setPending(true)

        setStreaming("")

        try {

            const reply = await auth.$outbound.publishFirst<string>("/assistant/turn", content)

            if (typeof reply === "string" && reply) {

                setHistory(current => [...current, { role: "assistant", content: reply, at: Date.now() }])
            }
        }

        catch (exception) {

            setHistory(current => [...current, { role: "assistant", content: String(exception instanceof Error ? exception.message : exception), at: Date.now() }])
        }

        finally {

            setStreaming("")

            setPending(false)
        }
    }

    function onKeyDown(event: React.KeyboardEvent) {

        if (event.key === "Enter" && !event.shiftKey) {

            event.preventDefault()

            void send()
        }
    }

    if (state === null) return null

    if (!state.available) return <div className="grid size-full place-content-center gap-2 p-6 text-center">

        <p className="font-medium">Seraph has no model yet</p>

        <p className="opacity-60">Set SERAPH_LLM_BASE_URL, SERAPH_LLM_API_KEY, and SERAPH_LLM_MODEL in the System's environment, then restart it.</p>

    </div>

    return <div className="flex size-full flex-col">

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">

            {history.map((message, index) => <div

                key={index}

                className={message.role === "user" ? "ml-auto w-fit max-w-3/4 rounded-xl bg-primary px-3 py-2" : "w-fit max-w-3/4 rounded-xl bg-card px-3 py-2"}

            >{message.content}</div>)}

            {streaming && <div className="w-fit max-w-3/4 rounded-xl bg-card px-3 py-2">{streaming}</div>}

            <div ref={bottom} />

        </div>

        <div className="border-t border-border p-3">

            <div className="flex gap-2">

                <input

                    className="flex-1 rounded-lg border border-border bg-card px-3 py-2 outline-none"

                    placeholder="Ask Seraph…"

                    value={draft}

                    onChange={event => setDraft(event.target.value)}

                    onKeyDown={onKeyDown}

                    disabled={pending}

                />

                <VoiceButton setDraft={setDraft} />

                <AssistantSettings onChanged={() => void refreshState()} />

                <button type="button" className="rounded-lg bg-primary px-4 py-2" onClick={() => void send() } disabled={pending}>{pending ? "…" : "Send"}</button>

            </div>

            <p className="mt-2 text-xs opacity-50">Tools: {state.tools.map(tool => tool.name).join(", ") || "none"}</p>

        </div>

    </div>
}