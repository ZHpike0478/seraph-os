import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, test } from "vitest"
import Hub from "@server/core/hub"
import Gate from "@server/core/hub-gate"
import gateway from "@server/view/gateway/gateway"
import gatewayAddress from "@server/view/gateway/address"
import { SocketClient } from "@the-link/ipc/socket-client"
import messagepack from "@the-link/messagepack"
import { TheLink } from "@the-link/core"
import { type RequestOutcome, unwrap } from "@libs/request-outcome"

const homes: string[] = []
const listeners: Array<{ close(): Promise<void> }> = []

afterAll(function () {

    // Windows holds SQLite handles briefly; leftovers harm nothing.
    for (const directory of homes) {
        try { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
        catch { }
    }
})

function open(): Hub {

    const directory = mkdtempSync(join(tmpdir(), "seraph-gateway-auth-"))

    homes.push(directory)

    const icons = { system: join(directory, "logo.png"), defaultProgram: join(directory, "icon.png") }

    return Hub.open(directory, icons)
}

/** One gate connection driven by an in-process client link, exactly as the wire door bridges it. */
function connect(hub: Hub) {

    const client = new TheLink()

    const gate = Gate.open(hub)

    client.$outbound.forwardTo(async function (event, ...values) {

        const [responseUuid, ...rest] = values as [string | null, ...unknown[]]

        gate.receive(String(event), typeof responseUuid === "string" ? responseUuid : null, ...rest)

        return []
    })

    gate.$outbound.forwardTo(async function (event, ...values) {

        await client.$inbound.publish(event, ...values)
    })

    function ask<Result>(event: string, ...values: unknown[]): Promise<Result> {

        const responseUuid = `uuid-${Math.random().toString(36).slice(2)}-${Date.now()}`

        const reply = client.$inbound.waitFirst<RequestOutcome<Result>>(responseUuid)

        client.$outbound.publish(event, responseUuid, ...values)

        return reply.then(outcome => unwrap(outcome))
    }

    return { client, gate, ask }
}

function captureTokens(connection: ReturnType<typeof connect>) {

    const tokens: string[] = []

    const stop = connection.client.$inbound.subscribe("/session/signed-in", value => {

        if (typeof value === "string") tokens.push(value)
    })

    return { tokens, stop }
}

async function openGateway(hub: Hub) {

    const address = gatewayAddress(homes[homes.length - 1]!)

    const listener = await gateway(hub, address)

    listeners.push(listener)

    return address
}

async function peerOpen(address: string) {

    const client = new SocketClient(address)

    client.setSerialize(messagepack.serialize)

    client.setDeserialize(messagepack.deserialize)

    await client.connect()

    return client
}

test("an administrator's session token binds a peer; its relays ride its own space", async () => {

    const hub = open()

    const address = await openGateway(hub)

    const admin = connect(hub)

    const { tokens, stop } = captureTokens(admin)

    assert.deepEqual(await admin.ask("/owner/sign-up", "root", "root-password-1"), { signedUp: true })

    stop()

    const token = tokens[0]!

    const peer = await peerOpen(address)

    // Subscriptions come before the publishes they must observe.
    const ready = peer.$inbound.waitFirst<unknown>("/gateway/ready")

    try {

        await peer.$outbound.publishFirst("/gateway/authenticate", token, "handshake-1")

        const readiness = await ready

        assert.ok(readiness && typeof readiness === "object", "the bound peer received its space's readiness snapshot")

        // A bound relay reaches the admin's own space through the real wire.
        const state = await peer.$outbound.publishFirst("/auth/authentication/state", token)

        assert.ok(state !== undefined && state !== null, "the space returned its authentication state: " + JSON.stringify(state))
    }

    finally {

        await peer.disconnect()
    }
}, 120_000)

test("a peer without an administrator token never binds", async () => {

    const hub = open()

    const address = await openGateway(hub)

    const admin = connect(hub)

    const { tokens: adminTokens, stop: stopAdmin } = captureTokens(admin)

    assert.deepEqual(await admin.ask("/owner/sign-up", "root", "root-password-1"), { signedUp: true })

    stopAdmin()

    const adminToken = adminTokens[0]!

    // (i) no token at all: the refusal answer rides the reply address.
    const empty = await peerOpen(address)

    const emptyOut = await empty.$outbound.publishFirst<string>("/gateway/authenticate")

    assert.match(String(emptyOut), /must authenticate/)

    await empty.disconnect()

    // (ii) a user account's token.
    await admin.ask("/auth/accounts/create", adminToken, "alice", "alice-password", "user")

    const alice = connect(hub)

    const { tokens: aliceTokens, stop: stopAlice } = captureTokens(alice)

    assert.equal(await alice.ask("/owner/sign-in", "alice", "alice-password"), true)

    stopAlice()

    const nonAdmin = await peerOpen(address)

    const nonAdminOut = await nonAdmin.$outbound.publishFirst<string>("/gateway/authenticate", aliceTokens[0])

    assert.match(String(nonAdminOut), /not an administrator/)

    await nonAdmin.disconnect()

    // (iii) a disabled administrator's token: a second admin disables the
    // first (the store refuses disabling the last administrator), and the
    // dead session's token stops resolving in the hub index too.
    await admin.ask("/auth/accounts/create", adminToken, "bernard", "bernard-password", "admin")

    const bernard = connect(hub)

    const { tokens: bernardTokens, stop: stopBernard } = captureTokens(bernard)

    assert.equal(await bernard.ask("/owner/sign-in", "bernard", "bernard-password"), true)

    stopBernard()

    await bernard.ask("/auth/accounts/set-disabled", bernardTokens[0], "root", true)

    // The session may sit in the index until its lifetime passes, but the
    // handshake re-reads the account: a disabled administrator's token can
    // never bind a peer.
    const gone = await peerOpen(address)

    const goneOut = await gone.$outbound.publishFirst<string>("/gateway/authenticate", adminToken)

    assert.match(String(goneOut), /not an administrator/)

    await gone.disconnect()

    // (iv) an unknown token.
    const stranger = await peerOpen(address)

    const strangerOut = await stranger.$outbound.publishFirst<string>("/gateway/authenticate", "not-a-token")

    assert.match(String(strangerOut), /must authenticate/)

    await stranger.disconnect()
}, 120_000)

test("a peer that speaks before it authenticates never binds", async () => {

    const hub = open()

    const address = await openGateway(hub)

    const peer = await peerOpen(address)

    try {

        // The first envelope is not the handshake: the refusal is the call's
        // own answer, and the door closes after it.
        const refused = await peer.$outbound.publishFirst<string>("/auth/authentication/state")

        assert.match(String(refused), /must begin with/)

        // A second handshake is refused the same way: the door never bound.
        const again = await peer.$outbound.publishFirst<string>("/gateway/authenticate", "whatever-token")

        assert.match(String(again), /must authenticate/)
    }

    finally {

        await peer.disconnect()
    }
}, 120_000)

test("signing out kills the token that minted a peer", async () => {

    const hub = open()

    const address = await openGateway(hub)

    const admin = connect(hub)

    const { tokens, stop } = captureTokens(admin)

    assert.deepEqual(await admin.ask("/owner/sign-up", "root", "root-password-1"), { signedUp: true })

    const token = tokens[0]!

    // Sign the session out over the admin's own gate connection, then wait
    // for the signed-out push to cross before trusting the dead token.
    const signedOut = admin.client.$inbound.waitFirst("/session/signed-out")

    await admin.ask("/auth/session/sign-out-current", token)

    await signedOut

    stop()

    assert.equal(await hub.spaceForToken(token), null, "a signed-out session stopped resolving")

    // And the dead token can never mint a new gateway peer.
    const late = await peerOpen(address)

    const lateOut = await late.$outbound.publishFirst<string>("/gateway/authenticate", token)

    assert.match(String(lateOut), /must authenticate/)

    await late.disconnect()
}, 120_000)
