import LinkManager from "./link-manager/link-manager"
import Authentication from "./authentication/authentication"
import FileManager from "@libs/file-manager"
import UploadManager from "./upload-manager"
import AppearanceManager from "./appearance-manager"
import openStore from "./open-store"
import Keyv from "keyv"
import FileArea, { FileSystem } from "@libs/file-area"
import { homedir } from "node:os"
import { join } from "node:path"
import System from "./system"
import createServerRuntime from "./server-runtime/factory"
import SystemLogs from "./logs"
import AssistantMemory from "./assistant/memory"
import RagIndex from "./assistant/rag"
import Assistant, { assistantConfiguration, type AssistantConfigurationValues } from "./assistant/assistant"
import assistantTools from "./assistant/tools"
import ragTools from "./assistant/rag-tools"
import Embedder from "./assistant/embeddings"

export default class Application {

    /** The icon files the System renders: its own, and the one for a Program without an icon. */
    public readonly icons: ApplicationIcons

    public readonly storage: FileManager

    /** Native filesystem access entered from the operating-system user's home. */
    public readonly home: FileArea

    /** Internal application persistence, reached publicly through named methods. */
    public readonly store: Keyv

    public readonly authentication: Authentication

    public readonly uploads: UploadManager

    /** System-owned persistent records and their internal write capability. */
    public readonly logs: SystemLogs

    public readonly appearanceManager: AppearanceManager

    public readonly linkManager: LinkManager

    /** One authoritative System domain shared by every trusted adapter. */
    public readonly system: System

    /** The Link-bound auth manager: programs, processes, permissions. */
    public get authManager() {

        return this.linkManager.authManager
    }

    /** The Program registry this space serves. */
    public get programManager() {

        return this.linkManager.authManager.programManager
    }

    /** The Process registry of this space. */
    public get processManager() {

        return this.linkManager.authManager.processManager
    }

    /** Core-owned factory for every Server execution environment. */
    public readonly createServerRuntime: typeof createServerRuntime

    /** The assistant of this space; null while no model endpoint is configured. */
    public get assistant(): Assistant | null {

        return this.assistantInstance
    }

    /** One space's assistant memory, open even before a model is configured. */
    public readonly assistantMemory: AssistantMemory

    /** One space's retrieval index over its own files. */
    public readonly ragIndex: RagIndex

    private assistantInstance: Assistant | null

    private constructor(payload: ApplicationPayload) {

        this.icons = payload.icons

        this.storage = payload.storage

        this.home = payload.home

        this.store = payload.store

        this.authentication = payload.authentication

        this.uploads = payload.uploads

        this.appearanceManager = payload.appearanceManager

        this.assistantMemory = payload.assistantMemory

        this.ragIndex = payload.ragIndex

        // A model endpoint configured at boot brings the assistant with it;
        // the tools see the finished application that carries them.
        this.assistantInstance = payload.assistantConfiguration

            ? Assistant.open(payload.assistantConfiguration, payload.assistantMemory, [

                ...assistantTools(this as unknown as Application),

                // The retrieval tools ride the same endpoint: an embeddings
                // model configured alongside the model unlocks them.
                ...ragTools(this as unknown as Application, Embedder.open(payload.assistantConfiguration)!)

            ])

            : null

        this.createServerRuntime = createServerRuntime

        this.logs = new SystemLogs(this.storage.join("logs.sqlite"))

        this.linkManager = new LinkManager(this)

        this.system = new System(this)
    }

    /** Closes the space's own databases; tests use this before removing homes. */
    public close() {

        try { this.ragIndex.close() }
        catch { }

        try { this.assistantMemory.close() }
        catch { }

        try { this.logs.close() }
        catch { }
    }

    public static async initialize(homePath: string, icons: ApplicationIcons, authentication?: Authentication, options?: { nativeRoot?: string }) {

        const storage = new FileManager(homePath)

        const home = new FileSystem(options?.nativeRoot ?? homedir(), "the native filesystem")

        const store = openStore(storage.path)

        authentication ??= await Authentication.open(storage.join("credentials.json"), store)

        const uploads = new UploadManager(storage.navigateTo("uploads"))

        const appearanceManager = await AppearanceManager.open(store, uploads)

        const assistantMemory = AssistantMemory.open(join(homePath, "assistant.sqlite"))

        const ragIndex = RagIndex.open(join(homePath, "assistant-rag.sqlite"))

        const application = new Application({ icons, storage, home, store, authentication, appearanceManager, uploads, assistantMemory, ragIndex, assistantConfiguration: assistantConfiguration(process.env) })

        await application.linkManager.authManager.programManager.initialize()

        return application
    }
}

/** Paths of the icon sources: the System's own, and the default for a Program without one. */
export type ApplicationIcons = Readonly<{ system: string, defaultProgram: string }>

interface ApplicationPayload {

    icons: ApplicationIcons

    storage: FileManager

    home: FileArea

    store: Keyv

    authentication: Authentication

    appearanceManager: AppearanceManager

    uploads: UploadManager

    assistantMemory: AssistantMemory

    ragIndex: RagIndex

    assistantConfiguration: AssistantConfigurationValues | null
}
