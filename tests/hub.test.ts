import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, test } from "vitest"
import Hub from "@server/core/hub"
import Gate from "@server/core/hub-gate"
import { TheLink } from "@the-link/core"
import { type RequestOutcome, unwrap } from "@libs/request-outcome"

const homes: string[] = []

afterAll(function () {

    // Windows holds SQLite handles briefly; leftover temp directories harm nothing.
    for (const directory of homes) {

        try { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
        catch { }
    }
})

function open(): Hub {

    const directory = mkdtempSync(join(tmpdir(), "seraph-hub-"))

    homes.push(directory)

    const icons = { system: join(directory, "logo.png"), defaultProgram: join(directory, "icon.png") }

    return Hub.open(directory, icons)
}

/** One gate connection driven by an in-process client link, exactly as the wire door bridges it. */
function connect(hub: Hub) {

    const client = new TheLink()

    const gate = Gate.open(hub)

    // The client's outbound carries every envelope: (event, responseUuid, ...values).
    client.$outbound.forwardTo(async function (event, ...values) {

        const [responseUuid, ...rest] = values as [string | null, ...unknown[]]

        gate.receive(String(event), typeof responseUuid === "string" ? responseUuid : null, ...rest)

        return []
    })

    // Replies and pushes ride the gate's outbound into the client's inbound.
    gate.$outbound.forwardTo(async function (event, ...values) {

        await client.$inbound.publish(event, ...values)
    })

    /** One correlated request: the reply arrives under the response address. */
    function ask<Result>(event: string, ...values: unknown[]): Promise<Result> {

        const responseUuid = randomUUID()

        const reply = client.$inbound.waitFirst<RequestOutcome<Result>>(responseUuid)

        client.$outbound.publish(event, responseUuid, ...values)

        return reply.then(outcome => unwrap(outcome))
    }

    function askOutcome(event: string, ...values: unknown[]): Promise<RequestOutcome<unknown>> {

        const responseUuid = randomUUID()

        const reply = client.$inbound.waitFirst<RequestOutcome<unknown>>(responseUuid)

        client.$outbound.publish(event, responseUuid, ...values)

        return reply
    }

    return { client, gate, ask, askOutcome }
}

test("two accounts share nothing", async () => {

    const hub = open()

    // The first connection bootstraps the administrator.
    const admin = connect(hub)

    const tokens: string[] = []

    const stopToken = admin.client.$inbound.subscribe("/session/signed-in", value => {

        if (typeof value === "string") tokens.push(value)
    })

    const state = await admin.ask<{ signedUp: boolean }>("/owner/state")

    assert.equal(state.signedUp, false)

    const signedUp = await admin.ask<{ signedUp: true }>("/owner/sign-up", "root", "root-password-1")

    assert.deepEqual(signedUp, { signedUp: true })

    stopToken()

    assert.equal(tokens.length, 1, "the bootstrap connection received one session token")

    const adminToken = tokens[0]!

    // Its token resolves to its own account-space.
    const adminSpace = await hub.space("root")

    assert.equal(await hub.spaceForToken(adminToken), adminSpace)

    // A second connection signs in as a second account.
    await hub.accounts.create("alice", "alice-password", "user")

    const alice = connect(hub)

    const aliceTokens: string[] = []

    const stopAliceToken = alice.client.$inbound.subscribe("/session/signed-in", value => {

        if (typeof value === "string") aliceTokens.push(value)
    })

    const aliceState = await alice.ask<{ signedUp: boolean }>("/owner/state")

    assert.equal(aliceState.signedUp, true)

    const wrongPassword = await alice.ask<boolean>("/owner/sign-in", "alice", "wrong-password")

    assert.equal(wrongPassword, false)

    assert.equal(aliceTokens.length, 0, "a refused sign-in creates no session")

    const aliceIn = await alice.ask<boolean>("/owner/sign-in", "alice", "alice-password")

    assert.equal(aliceIn, true)

    stopAliceToken()

    assert.equal(aliceTokens.length, 1)

    const aliceToken = aliceTokens[0]!

    // Its token resolves to its own space, never to the other's.
    const aliceSpace = await hub.space("alice")

    assert.equal(await hub.spaceForToken(aliceToken), aliceSpace)

    // An unknown token resolves to nothing.
    assert.equal(await hub.spaceForToken("not-a-token"), null)

    // Account-spaces keep entirely separate homes.
    assert.notEqual(adminSpace.storage.path, aliceSpace.storage.path)

    assert.ok(adminSpace.storage.path.includes(join("users", "root")))

    assert.ok(aliceSpace.storage.path.includes(join("users", "alice")))
})

test("resume binds a returning browser to its own space", async () => {

    const hub = open()

    await hub.accounts.create("admin", "admin-password-1", "admin")

    const first = connect(hub)

    const tokens: string[] = []

    const stop = first.client.$inbound.subscribe("/session/signed-in", value => {

        if (typeof value === "string") tokens.push(value)
    })

    const started = await first.ask<boolean>("/owner/sign-in", "admin", "admin-password-1")

    assert.equal(started, true)

    stop()

    const token = tokens[0]!

    // The same token on a new connection resumes straight into the space.
    const second = connect(hub)

    const resumed = await second.ask<unknown>("/session-authenticate", token)

    // The space's own answer rides the results array: one result,
    // itself a [token, AuthManager] pair.
    assert.equal(Array.isArray(resumed), true, "a live token resumes its session")

    assert.equal((resumed as unknown[]).length, 1)

    assert.equal(Array.isArray((resumed as unknown[])[0]), true)

    // A dead token answers the same shape the original flow answered.
    const dead = await second.ask<boolean>("/session-authenticate", "long-gone")

    assert.deepEqual(dead, [false])
})

test("an unknown event while anonymous is refused", async () => {

    const hub = open()

    const stranger = connect(hub)

    const refused = await stranger.askOutcome("/storage", "list", [])

    assert.deepEqual(refused, { success: false, error: "This connection is not signed in" })
})