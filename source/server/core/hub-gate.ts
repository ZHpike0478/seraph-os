import { succeeded, failed } from "@libs/request-outcome"
import Application from "./application"
import Hub from "./hub"
import { TheLink } from "@the-link/core"

/**
 * The front door of a multi-user System.
 *
 * A browser connection arrives here before it belongs to anyone. The gate
 * answers authentication facts from the Hub, and the moment a connection
 * proves itself it is bound to that account's own Application — its own
 * sessions, programs, storage, and announcements. From then on the gate is
 * only a relay; nothing of one space crosses another.
 */
export default class Gate extends TheLink {

    private readonly hub: Hub

    private readonly socket: TheLink

    private space: Application | null = null

    private boundary: ReturnType<Application["linkManager"]["addConnection"]> | null = null

    private constructor(hub: Hub, socket: TheLink) {

        super()

        this.hub = hub

        this.socket = socket
    }

    /** Registers one browser socket as an unbound gate connection. */
    public static open(hub: Hub, socket: TheLink) {

        return new Gate(hub, socket)
    }

    public get bound(): boolean {

        return this.space !== null
    }

    /**
     * The subscribe acknowledgement a client builds its transport from while
     * still anonymous: a private appearance key whose updates arrive once the
     * connection enters its space, and nothing else.
     */
    public acknowledgement() {

        return {

            appearance: { key: "seraphos.gate.appearance", value: null }
        }
    }

    /** The appearance key this gate answers appearance updates under. */
    private static readonly appearanceKey = "seraphos.gate.appearance"

    /** Forwards one client envelope; unbound gates may ask only four things. */
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

        if (responseUuid === null) {

            await this.space!.linkManager.receive(this.boundary!, event, ...values).catch(() => undefined)

            return
        }

        await this.envelope(responseUuid, async () => await this.space!.linkManager.receive(this.boundary!, event, ...values))
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
     * Binds this connection into one account-space exactly once: a boundary is
     * created there, its pushed events flow through this gate (appearance
     * updates re-named to the key the client subscribed to), and when asked a
     * Session is created, its raw token recorded in the Hub index, and its
     * arrival delivered to the socket by that space.
     */
    private async enter(username: string, createSession: boolean) {

        if (this.space) return this.space

        const space = await this.hub.space(username)

        // The space publishes its own pushed events into the gate; the gate
        // forwards them onto the socket, renaming the space's random appearance
        // property key to the one the anonymous acknowledgement promised.
        const boundary = space.linkManager.addConnection(this)

        const stopForwarding = this.$outbound.forwardTo((event, ...values: unknown[]) => {

            const name = typeof event === "string" && event.startsWith("property-update:")
                ? `property-update:${Gate.appearanceKey}`
                : event

            return this.socket.$outbound.publish(name, ...values)
        })

        this.space = space

        this.boundary = boundary

        // The space's current appearance, so the desktop paints it before the
        // first change rather than after.
        await this.socket.$outbound.publish(`property-update:${Gate.appearanceKey}`, space.appearanceManager.value)

        if (!createSession) return space

        // The raw token exists once, inside the space's own sign-in path; the
        // Hub observes it there rather than handling credentials itself.
        const stopObserving = space.linkManager.onSessionToken((token: string) => this.hub.registerSession(token, username))

        try {

            await space.linkManager.signInConnection(boundary)

            void stopForwarding

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

            await this.socket.$outbound.publish(responseUuid, succeeded(results))
        }

        catch (exception) {

            await this.socket.$outbound.publish(responseUuid, failed(exception, false))
        }
    }
}