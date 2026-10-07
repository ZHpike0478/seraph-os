/**
 * Server: per-space assistant configuration + RAG management routes.
 *
 * Two surfaces the desktop needed and the environment file could not
 * carry:
 *
 * 1. LLM provider settings. The boot-time `assistantConfiguration(env)`
 *    remains the DEFAULT; a saved space config (assistant-config.json,
 *    0600, in the space's own directory) overrides it and APPLIES to the
 *    live assistant immediately. The key never leaves the server: every
 *    view says `hasKey`, nothing echoes it.
 *
 * 2. RAG access: status (what's indexed, under which embedding geometry),
 *    index-a-path (the same ingestion the model's files_index tool runs),
 *    and search (the same fused retrieval). The database previously had
 *    no path to the UI at all - only the model could touch it.
 *
 * Routes ride the space's authenticated /auth boundary like every other
 * assistant route; the invoking connection's session token was already
 * verified by the intercept.
 */

import { writeFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import Assistant, {
    type AssistantConfigurationValues
} from "./assistant/assistant"
import Embedder from "./assistant/embeddings"
import ragTools from "./assistant/rag-tools"
import assistantTools from "./assistant/tools"
import connectionTools from "./assistant/connection-tools"
import type Application from "./application"

/** Where one space's saved assistant configuration lives. */
export function assistantConfigPath(homePath: string): string {

    return join(homePath, "assistant-config.json")
}

/** What the desktop may see of the configuration. Never the key. */
export interface AssistantConfigView {

    baseUrl: string

    model: string

    embedModel: string

    hasKey: boolean

    /** Where each value came from: the space's saved file, or the boot environment. */
    source: "space" | "environment"

    /** Whether the assistant is live with this configuration right now. */
    live: boolean
}

/** Reads the space's saved configuration; null when none stands. */
export async function loadSpaceConfiguration(homePath: string): Promise<AssistantConfigurationValues | null> {

    let text: string

    try { text = await readFile(assistantConfigPath(homePath), "utf8") }

    catch { return null }

    let parsed: unknown

    try { parsed = JSON.parse(text) }

    catch { return null }

    return configurationOf(parsed)
}

/** Validates one configuration record; null when the shape is wrong. */
export function configurationOf(value: unknown): AssistantConfigurationValues | null {

    if (typeof value !== "object" || value === null) return null

    const record = value as Record<string, unknown>

    const baseUrl = typeof record.baseUrl === "string" ? record.baseUrl.trim().replace(/\/+$/, "") : ""

    const model = typeof record.model === "string" ? record.model.trim() : ""

    const embedModel = typeof record.embedModel === "string" ? record.embedModel.trim() : ""

    // The key normalizes to "" when absent: the assistant already treats
    // a blank key as none (it omits the authorization header), and the
    // values interface stays a plain string everywhere.
    const apiKey = typeof record.apiKey === "string" && record.apiKey.trim() ? record.apiKey.trim() : ""

    if (!baseUrl || !model || !embedModel) return null

    try { new URL(baseUrl) }
    catch { return null }

    return { baseUrl, model, embedModel, apiKey }
}

/**
 * The space's effective configuration: the saved file when it stands,
 * otherwise the boot environment's. The source tells the UI which one.
 */
export async function effectiveConfiguration(application: Application): Promise<{ configuration: AssistantConfigurationValues | null, source: "space" | "environment" }> {

    const saved = await loadSpaceConfiguration(application.homePath)

    if (saved) return { configuration: saved, source: "space" }

    return { configuration: application.bootConfiguration, source: "environment" }
}

/** One view of the current configuration for the desktop. */
export async function configurationView(application: Application): Promise<AssistantConfigView> {

    const { configuration, source } = await effectiveConfiguration(application)

    return {
        baseUrl: configuration?.baseUrl ?? "",
        model: configuration?.model ?? "",
        embedModel: configuration?.embedModel ?? "",
        hasKey: !!configuration && configuration.apiKey.trim() !== "",
        source,
        live: application.assistant !== null
    }
}

/**
 * Saves one space configuration and re-opens the assistant with it, live.
 * The saved file wins over the environment at boot from now on. Passing
 * `key: null` when the space already holds a key keeps it - the desktop
 * never repeats a key it did not display.
 */
export async function saveSpaceConfiguration(
    application: Application,
    input: { baseUrl: string, model: string, embedModel: string, apiKey: string | null, keepKey?: boolean }
): Promise<AssistantConfigView> {

    const current = await effectiveConfiguration(application)

    const apiKey = input.apiKey?.trim()

    const candidate = configurationOf({
        baseUrl: input.baseUrl,
        model: input.model,
        embedModel: input.embedModel,
        // A blank key field keeps the stored key; only a typed value
        // replaces it.
        apiKey: apiKey ? apiKey : current.configuration?.apiKey ?? ""
    })

    if (!candidate) throw new Error("An assistant configuration needs a URL, a model, and an embeddings model")

    const configuration: AssistantConfigurationValues = candidate

    await writeFile(assistantConfigPath(application.homePath), JSON.stringify(configuration, null, 2), { mode: 0o600 })

    reopenAssistant(application, configuration)

    return {
        ...configuration,
        hasKey: configuration.apiKey.trim() !== "",
        source: "space",
        live: application.assistant !== null
    }
}

/** Clears the saved configuration: the boot environment governs again. */
export async function clearSpaceConfiguration(application: Application): Promise<void> {

    const { rm } = await import("node:fs/promises")

    try { await rm(assistantConfigPath(application.homePath)) }
    catch { }

    const { configuration } = await effectiveConfiguration(application)

    reopenAssistant(application, configuration)
}

/**
 * Re-opens the space's assistant (and its embedder-driven tools) with one
 * configuration. The boot-time construction path, factored so a live
 * change follows the exact same tool wiring.
 */
export function reopenAssistant(application: Application, configuration: AssistantConfigurationValues | null): void {

    application.replaceAssistant(configuration

        ? Assistant.open(configuration, application.assistantMemory, [

            ...assistantTools(application as never),

            ...ragTools(application as never, Embedder.open(configuration)!),

            ...connectionTools(application as never, application.connections)
        ])

        : null)
}

/**
 * The RAG surface the desktop reads: what is indexed, under which
 * geometry, plus whether the index was reset by a model change.
 */
export async function ragStatus(application: Application): Promise<{
    count: number
    paths: { path: string, chunks: number, size: number, modifiedAt: number, indexedAt: number }[]
    embedModel: string | null
    reset: boolean
    embeddingsAvailable: boolean
}> {

    const index = application.ragIndex

    const { configuration } = await effectiveConfiguration(application)

    const embedder = Embedder.open(configuration)

    const stamped = index.embedModel

    return {
        count: index.count(),
        paths: index.paths(),
        embedModel: stamped,
        reset: embedder !== null && stamped !== null && stamped !== embedder.embedModel,
        embeddingsAvailable: configuration !== null
    }
}