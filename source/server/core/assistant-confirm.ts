import { TheLink } from "@the-link/core"
import { Subscribe } from "@the-link/core/decorators"
import shortIdentity from "@libs/short-identity"
import type AuthManager from "./link-manager/auth-manager/auth-manager"

/** How long a confirmation waits for its user's decision. */
export const assistantConfirmTimeout = 120_000

/** What the Desktop needs to show one assistant write ask. */
export interface AssistantConfirmSnapshot {

    /** The short identity that Allow and Deny name. */

    readonly identity: string

    /** The writing tool that asked. */

    readonly tool: "files_write" | "desktop_set_theme" | "connections_save" | "connections_remove" | "mcp_call_tool"

    /** The change in one human-readable sentence. */

    readonly summary: string

    /** When the ask was created. */

    readonly createdAt: Date
}

/**
 * Authoritative lifecycle of pending assistant write confirmations. One per
 * account-space, exactly like the permission manager: the user's own
 * connection answers, and anything else — expiry, denial, or a departed
 * connection — is a refusal the model reads as plain text.
 */
export default class AssistantConfirmManager extends TheLink {

    private readonly pendingConfirms = new Map<string, PendingAssistantConfirm>()

    public constructor(private readonly authManager: AuthManager) {

        super()

        this.connectTo(authManager, "/assistant-confirm")
    }

    public requests() {

        return [...this.pendingConfirms.values()].map(request => request.snapshot)
    }

    public pending(identity: string) {

        return this.pendingConfirms.has(identity)
    }

    /**
     * Asks the requesting connection's user to allow one write. Resolves
     * true only after an explicit Allow on that connection; denial, expiry,
     * or the connection's departure resolves false — never an error, so the
     * tool answers the model with a plain refusal.
     */
    public async request(tool: "files_write" | "desktop_set_theme" | "connections_save" | "connections_remove" | "mcp_call_tool", summary: string, timeout: number = assistantConfirmTimeout): Promise<boolean> {

        if (tool !== "files_write" && tool !== "desktop_set_theme" && tool !== "connections_save" && tool !== "connections_remove" && tool !== "mcp_call_tool") throw new Error("An assistant confirmation needs a writing tool")

        if (typeof summary !== "string" || !summary.trim()) throw new Error("An assistant confirmation needs a summary")

        if (!Number.isFinite(timeout) || timeout < 0) throw new Error("An assistant confirmation timeout must be a non-negative finite number")

        let connection: ReturnType<AuthManager["linkManager"]["connections"]>[number] | null

        try { connection = this.authManager.linkManager.connection() }

        catch { return false }

        if (connection.signal.aborted) return false

        const identity = shortIdentity()

        const snapshot = Object.freeze({

            identity,

            tool,

            summary,

            createdAt: new Date()
        }) satisfies AssistantConfirmSnapshot

        let settle: (confirmed: boolean) => void = () => undefined

        const result = new Promise<boolean>(resolve => { settle = resolve })

        // The ask belongs to the connection that asked: when it leaves, nobody
        // is there to answer, and the write must never happen.
        const end = () => { this.finish(identity, false).catch(() => undefined) }

        const cancelConnection = this.onConnectionEnd(connection, end)

        this.pendingConfirms.set(identity, { snapshot, settle, cancelConnection, timer: null, resolving: false })

        await this.$outbound.publish("/request", snapshot).catch(() => undefined)

        // A request must become observable before its expiry can resolve it,
        // as a permission request is.
        const pending = this.pendingConfirms.get(identity)

        if (pending) pending.timer = this.expire(identity, timeout)

        return await result
    }

    @Subscribe("/allow")
    public async allow(identity: unknown) {

        const request = this.claim(identity)

        await this.finish(request.snapshot.identity, true)
    }

    @Subscribe("/deny")
    public async deny(identity: unknown) {

        const request = this.claim(identity)

        await this.finish(request.snapshot.identity, false)
    }


    /**
     * Applies the allowed theme as the space's desktop preference on the
     * very connection that asked. The Desktop listens for this event on its
     * own link; the appearance store keeps its own fields untouched.
     */
    public async pushDesktopPreference(change: unknown) {

        if (!change || typeof change !== "object") throw new Error("A desktop preference change must be an object")

        let connection: ReturnType<AuthManager["linkManager"]["connections"]>[number]

        try { connection = this.authManager.linkManager.connection() }

        catch (exception) { throw new Error("A desktop preference change needs the asking connection") }

        const link = connection.link

        await link.$outbound.publish("/change-desktop-preferences", change).catch(() => undefined)
    }

    private claim(identity: unknown) {

        const request = typeof identity === "string" ? this.pendingConfirms.get(identity) : undefined

        if (!request || request.resolving) throw new Error("The confirmation request does not exist")

        // Claim synchronously so two terminal operations can never both
        // settle the same confirmation.
        request.resolving = true

        return request
    }

    private async finish(identity: string, confirmed: boolean) {

        const request = this.pendingConfirms.get(identity)

        if (!request) throw new Error("The confirmation request does not exist")

        if (!this.pendingConfirms.delete(identity)) throw new Error("The confirmation request does not exist")

        if (request.timer) clearTimeout(request.timer)

        request.cancelConnection()

        // Publishing before settling keeps any open dialog on this space
        // synchronized before the asking turn resumes.
        await this.$outbound.publish("/resolve", request.snapshot).catch(() => undefined)

        request.settle(confirmed)
    }

    /** Watches one connection's departure; returns the cleanup. */
    private onConnectionEnd(connection: ReturnType<AuthManager["linkManager"]["connections"]>[number], end: () => void) {

        const signal = connection.signal

        if (signal.aborted) { end(); return () => undefined }

        signal.addEventListener("abort", end, { once: true })

        return () => signal.removeEventListener("abort", end)
    }

    private expire(identity: string, timeout: number): ReturnType<typeof setTimeout> {

        const maximumDelay = 2_147_483_647

        const remaining = timeout

        return setTimeout(() => {

            if (remaining > maximumDelay) {

                const request = this.pendingConfirms.get(identity)

                if (request) request.timer = this.expire(identity, timeout)
            }

            else void this.deny(identity).catch(() => undefined)
        }, Math.max(0, Math.min(maximumDelay, remaining)))
    }

    public toJSON() {

        return { requests: new Map(this.requests().map(request => [request.identity, request])) }
    }
}

interface PendingAssistantConfirm {

    readonly snapshot: AssistantConfirmSnapshot

    readonly settle: (confirmed: boolean) => void

    readonly cancelConnection: () => void

    timer: ReturnType<typeof setTimeout> | null

    resolving: boolean
}

export type AssistantConfirmManagerSnapshot = ReturnType<AssistantConfirmManager["toJSON"]>
