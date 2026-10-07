import { useEffect, useRef, useState } from "react"
import { Settings2, X } from "@phreshos/react-ui/icons"
import { AuthManagerContext } from "../contexts"

/** What the config view carries: everything but the key itself. */
interface ConfigView {

    baseUrl: string

    model: string

    embedModel: string

    hasKey: boolean

    source: "space" | "environment"

    live: boolean
}

/** The retrieval index's status. */
interface RagStatus {

    count: number

    paths: { path: string, chunks: number, size: number, modifiedAt: number, indexedAt: number }[]

    embedModel: string | null

    reset: boolean

    embeddingsAvailable: boolean
}

/**
 * The chat window's assistant settings: the model provider (endpoint,
 * models, key) and the retrieval index (status, index-a-path, search).
 * The key field never shows a stored key - it is write-only; a blank
 * field keeps whatever key the server already holds.
 */
export default function AssistantSettings({ onChanged }: { onChanged?: () => void }) {

    const auth = AuthManagerContext.useValue()

    const [open, setOpen] = useState(false)

    const [config, setConfig] = useState<ConfigView | null>(null)

    const [rag, setRag] = useState<RagStatus | null>(null)

    useEffect(function () {

        if (!open) return

        let stop = false

        void (async function () {

            const [nextConfig, nextRag] = await Promise.all([

                auth.$outbound.publishFirst<ConfigView>("/assistant/config-view"),

                auth.$outbound.publishFirst<RagStatus>("/assistant/rag-status")
            ])

            if (stop) return

            setConfig(nextConfig)

            setRag(nextRag)
        })()

        return function () { stop = true }

    }, [open, auth])

    function refresh() {

        onChanged?.()
    }

    if (!open) return <button
        type="button"
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card opacity-80 hover:opacity-100"
        aria-label="Assistant settings"
        title="Assistant settings"
        onClick={() => setOpen(true)}
    >

        <Settings2 className="size-4" />

    </button>

    return <Panel auth={auth} config={config} rag={rag} onDone={function () { setOpen(false); refresh() }} />
}

/** The open panel: two sections, provider then retrieval. */
function Panel({ auth, config, rag, onDone }: {

    auth: ReturnType<typeof AuthManagerContext.useValue>

    config: ConfigView | null

    rag: RagStatus | null

    onDone: () => void
}) {

    const [baseUrl, setBaseUrl] = useState("")

    const [model, setModel] = useState("")

    const [embedModel, setEmbedModel] = useState("")

    const [apiKey, setApiKey] = useState("")

    const [message, setMessage] = useState<string | null>(null)

    const [busy, setBusy] = useState(false)

    const [indexPath, setIndexPath] = useState("")

    const [query, setQuery] = useState("")

    const [searchResults, setSearchResults] = useState<string>("")

    const initialized = useRef(false)

    // Seed the fields once per open, from what the server holds.

    if (config && !initialized.current) {

        initialized.current = true

        setBaseUrl(config.baseUrl)

        setModel(config.model)

        setEmbedModel(config.embedModel)
    }

    async function save() {

        setBusy(true)

        setMessage(null)

        try {

            const saved = await auth.$outbound.publishFirst<ConfigView>("/assistant/config-save", baseUrl, model, embedModel, apiKey)

            setMessage(`Saved and live (source: ${saved.source}${saved.hasKey ? ", key stored" : ", no key"})`)

            setApiKey("")
        }

        catch (exception) {

            setMessage(exception instanceof Error ? exception.message : String(exception))
        }

        finally {

            setBusy(false)
        }
    }

    async function clear_() {

        setBusy(true)

        setMessage(null)

        try {

            await auth.$outbound.publishFirst("/assistant/config-clear")

            setMessage("Cleared; the boot environment governs again.")
        }

        catch (exception) {

            setMessage(exception instanceof Error ? exception.message : String(exception))
        }

        finally {

            setBusy(false)
        }
    }

    async function index() {

        setBusy(true)

        setMessage(null)

        try {

            const path = indexPath.trim().split("/").filter(Boolean)

            const result = await auth.$outbound.publishFirst<{ indexed: number, files: number, skipped?: { path: string, reason: string }[] }>("/assistant/rag-index", path)

            const skipped = result.skipped?.length ? `, ${result.skipped.length} skipped` : ""

            setMessage(`Indexed ${result.indexed} chunks from ${result.files} files${skipped}.`)
        }

        catch (exception) {

            setMessage(exception instanceof Error ? exception.message : String(exception))
        }

        finally {

            setBusy(false)
        }
    }

    async function search() {

        setBusy(true)

        setMessage(null)

        setSearchResults("")

        try {

            const result = await auth.$outbound.publishFirst<{ matches?: Array<{ path: string, excerpt?: string, page?: number }>, error?: string, note?: string }>("/assistant/rag-search", query)

            if (result.error) setMessage(result.error)

            else if (!result.matches || result.matches.length === 0) setMessage(result.note ?? "Nothing found.")

            else setSearchResults(result.matches.map(match => `${match.path}${match.page ? ` (page ${match.page})` : ""}${match.excerpt ? ` - ${match.excerpt}` : ""}`).join("\n"))
        }

        catch (exception) {

            setMessage(exception instanceof Error ? exception.message : String(exception))
        }

        finally {

            setBusy(false)
        }
    }

    return <div className="absolute inset-0 z-10 grid grid-rows-[auto_minmax(0_1fr)] bg-background/95 p-4" role="dialog" aria-label="Assistant settings">

        <div className="flex items-center justify-between pb-2">

            <h3 className="text-sm font-medium">Assistant settings</h3>

            <button type="button" aria-label="Close settings" className="rounded-lg p-1 opacity-70 hover:opacity-100" onClick={onDone}><X className="size-4" /></button>

        </div>

        <div className="min-h-0 overflow-y-auto text-sm">

            <section className="space-y-2 pb-4">

                <h4 className="text-xs font-medium opacity-60">Model provider (overrides seraphos.env when saved)</h4>

                <Field label="Endpoint URL" value={baseUrl} onChange={setBaseUrl} placeholder="http://localhost:11434/v1" />

                <Field label="Model" value={model} onChange={setModel} placeholder="qwen3.5:4b" />

                <Field label="Embeddings model" value={embedModel} onChange={setEmbedModel} placeholder="qwen3-embedding:latest" />

                <Field label="API key (write-only; blank keeps the stored one)" value={apiKey} onChange={setApiKey} placeholder={config?.hasKey ? "a key is stored" : "none stored"} password />

                <div className="flex gap-2 pt-1">

                    <button type="button" className="rounded-lg bg-primary px-3 py-1.5" disabled={busy || !baseUrl || !model || !embedModel} onClick={() => void save()}>Save and apply</button>

                    <button type="button" className="rounded-lg border border-border px-3 py-1.5" disabled={busy} onClick={() => void clear_()}>Use environment defaults</button>

                </div>

                {config && <p className="pt-1 text-xs opacity-60">Current: {config.source === "space" ? "saved in this space" : "from seraphos.env"}; live: {config.live ? "yes" : "no endpoint"}</p>}

            </section>

            <section className="space-y-2 border-t border-border pt-3">

                <h4 className="text-xs font-medium opacity-60">Retrieval index (RAG)</h4>

                {rag?.reset === true && <p className="text-xs text-primary">The embeddings model changed since indexing - reindex to search again.</p>}

                <p className="text-xs opacity-60">{rag ? `${rag.count} chunks${rag.embedModel ? `, geometry: ${rag.embedModel}` : ""}` : "loading..."}</p>

                <Field label="Path to index (inside your space's files, e.g. notes or notes/deep)" value={indexPath} onChange={setIndexPath} placeholder="notes" />

                <button type="button" className="rounded-lg border border-border px-3 py-1.5" disabled={busy || !indexPath.trim()} onClick={() => void index()}>Index now</button>

                <Field label="Search the index" value={query} onChange={setQuery} placeholder="what to look for" />

                <button type="button" className="rounded-lg border border-border px-3 py-1.5" disabled={busy || !query.trim()} onClick={() => void search()}>Search</button>

                {searchResults && <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-card p-2 text-xs">{searchResults}</pre>}

            </section>

            {message && <p className="pt-2 text-xs opacity-80" role="status">{message}</p>}

        </div>

    </div>
}

/** One labeled input row. */
function Field({ label, value, onChange, placeholder, password }: {

    label: string

    value: string

    onChange: (next: string) => void

    placeholder?: string

    password?: boolean
}) {

    return <label className="block space-y-1">

        <span className="block text-xs opacity-60">{label}</span>

        <input
            type={password ? "password" : "text"}
            className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm outline-none"
            value={value}
            placeholder={placeholder}
            onChange={event => onChange(event.target.value)}
        />

    </label>
}