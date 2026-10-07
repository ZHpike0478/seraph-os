import Hub from "@server/core/hub"
import localServer from "./local-server"
import messagepack from "@the-link/messagepack"
import type { SocketServer } from "@the-link/ipc/socket-server"

/**
 * The owner-local IPC adapter: a named pipe or Unix socket confined to the
 * machine, whose peer becomes one administrator through its account-space.
 *
 * Loopback transport alone is not the authentication: a peer's FIRST inbound
 * envelope must be '/gateway/authenticate' {token}. The System resolves the
 * token through the session index and requires a live, non-disabled
 * administrator account before anything binds. Only then the peer joins its
 * space as an external boundary and receives '/gateway/ready'. Any other
 * order, or a refused token, refuses and closes: nothing binds, no ready.
 * A signed-out session's token stops resolving, so a dead session can never
 * mint new gateway authority.
 */
export default function gateway(hub: Hub, path: string) {

    return localServer(path, function (server) {

        server.setSerialize(messagepack.serialize)

        server.setDeserialize(messagepack.deserialize)

        server.onConnection(peer => connect(hub, peer))
    })
}

async function connect(hub: Hub, peer: GatewayPeer) {

    let authenticated = false

    let bound: GatewayConnection | null = null

    // One forwarder for the peer's whole life: the strict handshake until the
    // peer proves itself, then the space's own relay. The bound connection is
    // set before the handshake publish returns, so no forwarder is ever added
    // while this one is already running.
    const stopPeer = peer.$inbound.forwardTo(async (event, ...values: unknown[]) => {

        // Bound: every envelope rides into the account-space from here on.
        if (authenticated) return bound ? bound.relay(event, values) : []

        // The handshake is strict about order: the FIRST envelope through this
        // unbindable door must be the authenticate call itself.
        if (event !== "/gateway/authenticate") return await refuse("A gateway peer must begin with /gateway/authenticate")

        const [token] = values

        if (typeof token !== "string") return await refuse("A gateway peer must authenticate with an administrator session token")

        const space = await hub.spaceForToken(token).catch(() => null)

        if (!space) return await refuse("A gateway peer must authenticate with an administrator session token")

        const account = hub.accounts.find(space.authentication.username ?? "")

        if (!account || account.role !== "admin" || account.disabled) return await refuse("This session is not an administrator")

        // The peer proved itself before anything saw another envelope. The
        // binding happens inside this same handler: authenticated flips first,
        // so the handshake envelope itself never reaches the space, and the
        // connection keeps the space's relays through the forwarder above.
        bound = await bindGateway(space, peer)

        authenticated = true

        try { hub.logs.record("info", "gateway", "peerBound", `A gateway peer bound to the "${space.authentication.username}" space`, { username: space.authentication.username }) }
        catch { /* Logging never obstructs the door. */ }

        return []
    })

    // The handshake never settled (the peer left first): stop holding the
    // peer's forwarder, and the connection never reached bind so removal is moot.
    peer.$internal.subscribeOnce("disconnect", stopPeer)

    // The refusal is the call's own answer: it rides the same publish the
    // peer sent, so a client reads the reason as the call's outcome. The
    // door closes shortly after; the resolve of the refused call itself
    // always leaves first.
    async function refuse(reason: string) {

        try { hub.logs.record("warning", "gateway", "peerRefused", reason, null) }
        catch { /* Logging never obstructs the door. */ }

        setTimeout(() => peer.disconnect().catch(() => undefined), 1_000)

        return [reason]
    }
}

/**
 * One authenticated, bound gateway peer.
 */
type GatewayConnection = { relay: (event: string, values: unknown[]) => Promise<unknown[]>, close: () => Promise<void> }

// The peer proved itself: it joins its account-space as an external boundary,
// gets ready, and rides the space's relays from here on.
async function bindGateway(space: NonNullable<Awaited<ReturnType<Hub["spaceForToken"]>>>, peer: GatewayPeer): Promise<GatewayConnection> {

    const linkManager = space.linkManager

    const connection = linkManager.addExternalConnection(peer)

    let closed = false

    // The relay itself is the handshake forwarder's bound branch (connect()
    // keeps ONE forwarder for the peer's whole life). This binding owns only
    // the space-side removal and the ready push.
    const close = async () => {

        if (closed) return

        closed = true

        await linkManager.removeConnection(connection)
    }

    peer.$internal.subscribeOnce("disconnect", () => void close())

    try {

        await peer.$outbound.publish("/gateway/ready", {

            linkManager: linkManager.toJSON(),

            authManager: linkManager.authManager.toJSON()
        })
    }

    // A connection that closes before it is ready is simply gone: nothing waits for it to succeed.
    catch {

        void close()

        peer.disconnect().catch(() => undefined)
    }

    return { relay: (event, values) => connection.publish(event, ...values), close }
}type GatewayPeer = Parameters<Parameters<SocketServer["onConnection"]>[0]>[0]
