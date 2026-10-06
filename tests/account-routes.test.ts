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
import type { AccountView } from "@server/core/link-manager/auth-manager/auth-manager"

const homes: string[] = []

afterAll(function () {

    // Windows holds SQLite handles briefly; leftover temp directories harm nothing.
    for (const directory of homes) {

        try { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
        catch { }
    }
})

function open(): Hub {

    const directory = mkdtempSync(join(tmpdir(), "seraph-accounts-"))

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

/** Session tokens the gate pushes while a sign-in runs, oldest first. */
function captureTokens(connection: ReturnType<typeof connect>) {

    const tokens: string[] = []

    const stop = connection.client.$inbound.subscribe("/session/signed-in", value => {

        if (typeof value === "string") tokens.push(value)
    })

    return { tokens, stop }
}

/** The reason a refused request names, as the wire carried it. */
function refusalReason(outcome: RequestOutcome<unknown>) {

    if (outcome.success !== false) throw new Error("the request was expected to be refused")

    return outcome.error
}

/** Bootstraps the first administrator on a fresh System and returns the session token. */
async function bootstrapAdmin(connection: ReturnType<typeof connect>) {

    const { tokens, stop } = captureTokens(connection)

    const signedUp = await connection.ask<{ signedUp: true }>("/owner/sign-up", "root", "root-password-1")

    assert.deepEqual(signedUp, { signedUp: true })

    stop()

    assert.equal(tokens.length, 1, "the bootstrap connection received one session token")

    return tokens[0]!
}

test("administrators manage accounts through the routes", async () => {

    const hub = open()

    const admin = connect(hub)

    const adminToken = await bootstrapAdmin(admin)

    // An administrator creates a user account, and reads the whole store back.
    // Bound relays answer with the one-element results array of the space; the
    // value of the operation is its first element.
    // The relay answers with the results array of the space; the created
    // account view is its first element.
    const created = (await admin.ask<AccountView[]>("/auth/accounts/create", adminToken, "alice", "alice-password", "user"))[0]!

    assert.equal(created.role, "user")

    assert.equal(created.disabled, false)

    assert.equal(typeof created.createdAt, "number")

    const list = (await admin.ask<AccountView[][]>("/auth/accounts/list", adminToken))[0]!

    assert.deepEqual(list.map(account => account.username).sort(), ["alice", "root"])

    assert.ok(list.every(account => typeof account.createdAt === "number"), "every account carries a serial creation time")

    // Roles flip both ways.
    void (await admin.ask<boolean[]>("/auth/accounts/set-role", adminToken, "alice", "admin"))[0]

    assert.equal((await admin.ask<AccountView[][]>("/auth/accounts/list", adminToken))[0]!.find(account => account.username === "alice")?.role, "admin")

    void (await admin.ask<boolean[]>("/auth/accounts/set-role", adminToken, "alice", "user"))[0]

    assert.equal((await admin.ask<AccountView[][]>("/auth/accounts/list", adminToken))[0]!.find(account => account.username === "alice")?.role, "user")

    // A disabled account cannot sign in until it is enabled again.
    void (await admin.ask<boolean[]>("/auth/accounts/set-disabled", adminToken, "alice", true))[0]

    const lockedOut = connect(hub)

    assert.equal(await lockedOut.ask<boolean>("/owner/sign-in", "alice", "alice-password"), false)

    void (await admin.ask<boolean[]>("/auth/accounts/set-disabled", adminToken, "alice", false))[0]

    const returning = connect(hub)

    const { tokens: returningTokens, stop: stopReturning } = captureTokens(returning)

    assert.equal(await returning.ask<boolean>("/owner/sign-in", "alice", "alice-password"), true)

    stopReturning()

    assert.equal(returningTokens.length, 1, "an enabled account signs in again")

    // Resetting credentials kills the old password and lives with the new one.
    void (await admin.ask<boolean[]>("/auth/accounts/reset-credentials", adminToken, "alice", "alice-next-password"))[0]

    const oldPassword = connect(hub)

    assert.equal(await oldPassword.ask<boolean>("/owner/sign-in", "alice", "alice-password"), false)

    const newPassword = connect(hub)

    assert.equal(await newPassword.ask<boolean>("/owner/sign-in", "alice", "alice-next-password"), true)
})

test("the accounts routes refuse everyone but administrators", async () => {

    const hub = open()

    const admin = connect(hub)

    const adminToken = await bootstrapAdmin(admin)

    await admin.ask<unknown>("/auth/accounts/create", adminToken, "alice", "alice-password", "user")

    // A signed-in non-admin is refused, with the reason in the outcome.
    const alice = connect(hub)

    const { tokens: aliceTokens, stop: stopAlice } = captureTokens(alice)

    assert.equal(await alice.ask<boolean>("/owner/sign-in", "alice", "alice-password"), true)

    stopAlice()

    const refusedList = await alice.askOutcome("/auth/accounts/list", aliceTokens[0]!)

    assert.equal(refusedList.success, false)

    assert.equal(refusalReason(refusedList), "Only an administrator may manage accounts")

    // Its create is refused too, and the store keeps exactly the accounts it had.
    const refusedCreate = await alice.askOutcome("/auth/accounts/create", aliceTokens[0]!, "bob", "bob-password-1", "user")

    assert.equal(refusedCreate.success, false)

    assert.equal(refusalReason(refusedCreate), "Only an administrator may manage accounts")

    const intact = (await admin.ask<AccountView[][]>("/auth/accounts/list", adminToken))[0]!

    assert.deepEqual(intact.map(account => account.username).sort(), ["alice", "root"])

    // A bogus token on a bound connection fails authorization before anything else.
    const bogus = await alice.askOutcome("/auth/accounts/list", "not-a-token")

    assert.equal(bogus.success, false)

    assert.equal(refusalReason(bogus), "Unauthorized")

    // A connection that never signed in is refused at the gate.
    const stranger = connect(hub)

    const anonymous = await stranger.askOutcome("/auth/accounts/list")

    assert.deepEqual(anonymous, { success: false, error: "This connection is not signed in" })
})

test("the routes carry the store's last-administrator protection", async () => {

    const hub = open()

    const admin = connect(hub)

    const adminToken = await bootstrapAdmin(admin)

    // Demoting the only administrator is refused.
    const demotion = await admin.askOutcome("/auth/accounts/set-role", adminToken, "root", "user")

    assert.equal(demotion.success, false)

    assert.match(refusalReason(demotion), /The last administrator cannot be demoted/)

    // Disabling the only administrator is refused too.
    const disabling = await admin.askOutcome("/auth/accounts/set-disabled", adminToken, "root", true)

    assert.equal(disabling.success, false)

    assert.match(refusalReason(disabling), /The last administrator cannot be disabled/)

    // With a second administrator, the first may be demoted after all.
    await admin.ask<unknown>("/auth/accounts/create", adminToken, "bernard", "bernard-password", "admin")

    // The second administrator proves itself on its own connection before the
    // first one is demoted; the store counts live administrators, not sessions.
    const bernard = connect(hub)

    const { tokens: bernardTokens, stop: stopBernard } = captureTokens(bernard)

    assert.equal(await bernard.ask<boolean>("/owner/sign-in", "bernard", "bernard-password"), true)

    stopBernard()

    assert.equal(bernardTokens.length, 1, "the second administrator signed in")

    assert.equal((await admin.ask<boolean[]>("/auth/accounts/set-role", adminToken, "root", "user"))[0], true)

    // The demoted administrator is already only a user again: even its listing
    // is refused from here on, so the remaining administrator reads the store.
    const denied = await admin.askOutcome("/auth/accounts/list", adminToken)

    assert.equal(denied.success, false)

    assert.equal(refusalReason(denied), "Only an administrator may manage accounts")

    const bernardToken = bernardTokens[0]!

    const roles = (await bernard.ask<AccountView[][]>("/auth/accounts/list", bernardToken))[0]!

    assert.equal(roles.find(account => account.username === "root")?.role, "user")

    assert.equal(roles.find(account => account.username === "bernard")?.role, "admin")
})