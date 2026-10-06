import { succeeded, failed } from "@libs/request-outcome"
import Application from "./application"
import Hub from "./hub"
import { defaultAppearance } from "@phreshos/core"
import { TheLink } from "@the-link/core"

/** The appearance property key every gate connection subscribes to while anonymous. */
export const gateAppearanceKey = "seraphos.gate.appearance"

/**
 * The front door of a multi-user System.
 *
 * A browser connection arrives here before it belongs to anyone. The gate
 * answers authentication facts from the Hub, and the moment a connection
 * proves itself it is bound to that account's own Application — its own
 * sessions, programs, storage, and announcements. From then on the gate is
 * only a relay; nothing of one space crosses another.
 *
 * Replies and pushes leave on the gate's own outbound tunnel; the transport
 * door forwards them onto the wire. The bridge link is what the account-space
 * sees as the connection, so the space's own appearance key is rewritten to
 * the anonymous acknowledgement's key in exactly one place.
 */
export default class Gate extends TheLink {

    private readonly hub: Hub

    private readonly bridge: TheLink

    private space: Application | null = null

    private boundary: ReturnType<Application["linkManager"]["addConnection"]> | null = null

    private constructor(hub: Hub) {

        super()

        this.hub = hub

        // The account-space publishes its pushes onto this bridge; the gate
        // renames its appearance property and re-publishes on its own outbound.
        this.bridge = new TheLink()

        this.bridge.$outbound.forwardTo((event, ...values: unknown[]) => {

            const name = typeof event === "string" && event.startsWith("property-update:")
                ? `property-update:${gateAppearanceKey}`
                : event

            return this.$outbound.publish(name, ...values)
        })
    }

    /** Registers one browser socket as an unbound gate connection. */
    public static open(hub: Hub) {

        return new Gate(hub)
    }

    public get bound(): boolean {

        return this.space !== null
    }

    /**
     * The subscribe acknowledgement a client builds its transport from while
     * still anonymous: a private appearance key whose updates arrive once the
     * connection enters its space, and nothing else.
     */
    // The anonymous acknowledgement carries a USABLE default, not null: the
    // sign-up/sign-in stage paints from it before any account-space exists
    // (its appearance push arrives on enter).
    public acknowledgement() {

        return {

            appearance: { key: gateAppearanceKey, value: defaultAppearance }
        }
    }

    /** Forwards one client envelope; an unbound gate may ask only four things. */
    public receive(event: string, responseUuid: string | null, ...values: unknown[]) {

        if (this.space) return this.relay(event, responseUuid, values)

        if (event === "/owner/state") return this.envelope(responseUuid, () => this.hubState())

        if (event === "/owner/sign-up") return this.envelope(responseUuid, () => this.bootstrap(values))

        if (event === "/owner/sign-in") return this.envelope(responseUuid, () => this.signIn(values))

        if (event === "/session-authenticate") return this.envelope(responseUuid, () => this.resume(values))

        this.envelope(responseUuid, function () {

            throw new Error("This connection is not signed in")
        })
    }

    /** The client socket closed; the bound space must release its boundary. */
    public async close() {

        if (this.boundary) await this.space!.linkManager.removeConnection(this.boundary)
    }

    private async relay(event: string, responseUuid: string | null, values: unknown[]) {

        const space = this.space!

        const boundary = this.boundary!

        if (responseUuid === null) {

            try { await space.linkManager.receive(boundary, event, ...values) }
            catch { }

            return
        }

        try {

            const results = await space.linkManager.receive(boundary, event, ...values)

            await this.$outbound.publish(responseUuid, succeeded(results))
        }

        catch (exception) {

            await this.$outbound.publish(responseUuid, failed(exception, false))
        }
    }

    private hubState() {

        return {

            signedUp: !this.hub.needsBootstrap(),

            requirements: {

                username: { minimumLength: 1, maximumLength: 64 },

                password: { minimumLength: 8, maximumLength: 1_024 }
            }
        }
    }

    /** First-ever sign-up creates the administrator and signs its connection in. */
    private async bootstrap(values: unknown[]) {

        const [username, password] = values

        if (typeof username !== "string" || typeof password !== "string") throw new Error("The credentials are invalid: username-required")

        const account = await this.hub.bootstrap(username, password)

        await this.enter(account.username, true)

        return { signedUp: true }
    }

    private async signIn(values: unknown[]) {

        const [username, password] = values

        if (typeof username !== "string" || typeof password !== "string") return false

        const found = await this.hub.verifySignIn(username, password)

        if (!found) return false

        await this.enter(found.username, true)

        return true
    }

    /** A returning browser presents its token; the Hub names its account-space. */
    private async resume(values: unknown[]) {

        const [token] = values

        const username = typeof token === "string" ? this.hub.sessionUsername(token) : null

        if (!username) {

            if (typeof token === "string" && token) this.hub.forgetSession(token)

            return false
        }

        await this.enter(username, false)

        // The space answers resume itself; its Sessions store owns the token.
        return await this.space!.linkManager.receive(this.boundary!, "/session-authenticate", token)
    }

    /**
     * Binds this connection into one account-space exactly once: the bridge
     * becomes the space's boundary link, and when asked a Session is created,
     * its raw token recorded in the Hub index, and its arrival delivered to
     * the socket through the gate.
     */
    private async enter(username: string, createSession: boolean) {

        if (this.space) return this.space

        const space = await this.hub.space(username)

        const boundary = space.linkManager.addConnection(this.bridge)

        this.space = space

        this.boundary = boundary

        // The space marks its fresh boundary visible the way the original
        // flow's first anonymous session-authenticate did, so its own sign-in
        // path accepts the connection this gate carries.
        try { await space.linkManager.receive(boundary, "/session-authenticate", null) }
        catch { /* an anonymous authenticate always succeeds; never block bind */ }

        // The space's current appearance, so the desktop paints it before the
        // first change rather than after.
        await this.$outbound.publish(`property-update:${gateAppearanceKey}`, space.appearanceManager.value)

        if (!createSession) return space

        // The raw token exists once, inside the space's own sign-in path; the
        // Hub observes it there rather than handling credentials itself.
        const stopObserving = space.linkManager.onSessionToken((token: string) => this.hub.registerSession(token, username))

        try {

            await space.linkManager.signInConnection(boundary)

            return space
        }

        finally {

            stopObserving()
        }
    }

    /** Runs one operation and answers its envelope exactly once. */
    private async envelope<Result>(responseUuid: string | null, operation: () => Promise<Result> | Result) {

        if (responseUuid === null) {

            try { await operation() }
            catch { }

            return
        }

        try {

            const results = await operation()

            await this.$outbound.publish(responseUuid, succeeded(results))
        }

        catch (exception) {

            await this.$outbound.publish(responseUuid, failed(exception, false))
        }
    }
}