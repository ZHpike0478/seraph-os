import Hub from "@server/core/hub"
import localServer from "./local-server"
import messagepack from "@the-link/messagepack"
import type { SocketServer } from "@the-link/ipc/socket-server"

/**
 * The owner-local IPC adapter: a Unix socket or named pipe confined to the
 * machine, whose peers act as the administrator through the first live
 * administrator's account-space. Loopback transport is the authentication;
 * per-session auth arrives with the native service boundary in a later phase.
 */
export default function gateway(hub: Hub, path: string) {

    return localServer(path, function (server) {

        server.setSerialize(messagepack.serialize)

        server.setDeserialize(messagepack.deserialize)

        server.onConnection(peer => connect(hub, peer))
    })
}

async function connect(hub: Hub, peer: GatewayPeer) {

    const space = await hub.adminSpace()

    if (!space) throw new Error("The System has no administrator yet")

    const linkManager = space.linkManager

    const connection = linkManager.addExternalConnection(peer)

    let closed = false

    const close = async () => {

        if (closed) return

        closed = true

        stopForwarding()

        await linkManager.removeConnection(connection)
    }

    const stopForwarding = peer.$inbound.forwardTo((event, ...values: unknown[]) => connection.publish(event, ...values))

    peer.$internal.subscribeOnce("disconnect", close)

    try {

        await peer.$outbound.publish("/gateway/ready", {

            linkManager: linkManager.toJSON(),

            authManager: linkManager.authManager.toJSON()
        })
    }

    // A connection that closes before it is ready is simply gone: nothing waits for it to succeed.
    catch {

        await close()

        await peer.disconnect().catch(() => undefined)
    }
}

type GatewayPeer = Parameters<Parameters<SocketServer["onConnection"]>[0]>[0]