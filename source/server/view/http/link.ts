import { upgradeWebSocket } from "@hono/node-server"
import Hub from "@server/core/hub"
import Gate from "@server/core/hub-gate"
import { HttpServer } from "@the-link/http/server"
import messagepack from "@the-link/messagepack"

/**
 * The multi-user /link door.
 *
 * Every browser connection lands here as an unbound Gate. The gate answers
 * authentication from the Hub, binds the connection to one account-space once
 * proven, and from then on relays between the socket and that space's own
 * LinkManager. The subscribe acknowledgement carries the shared pre-auth
 * snapshot; the space's own state arrives inside the AuthManager the client
 * builds after authentication.
 */
export default function (hub: Hub, debugging: boolean) {

    const http = new HttpServer()

    if (debugging) http.enableDebugging()

    http.setSerialize(messagepack.serialize)

    http.setDeserialize(messagepack.deserialize)

    http.onSubscribe(function (socketLink) {

        const gate = Gate.open(hub)

        const stopForwarding = socketLink.$inbound.forwardTo(function (event, responseUuid: string | null, ...values: unknown[]) {

            // A null response address is an intentional one-way transport
            // envelope. Route it once and do not manufacture an acknowledgement.
            gate.receive(event, responseUuid, ...values)
        })

        socketLink.$internal.subscribeOnce("unsubscribe", async function () {

            stopForwarding()

            await gate.close()
        })

        // Gate replies and pushes ride the gate's own outbound onto the wire.
        gate.$outbound.forwardTo(async function (event, ...values: unknown[]) {

            await socketLink.$outbound.publish(event, ...values)
        })

        return gate.acknowledgement()
    })

    http.prepareConnection(upgradeWebSocket)

    return http.app
}