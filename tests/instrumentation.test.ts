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

    for (const directory of homes) {

        try { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
        catch { }
    }
})

function open(): Hub {

    const directory = mkdtempSync(join(tmpdir(), "seraph-instr-"))

    homes.push(directory)

    const icons = { system: join(directory, "logo.png"), defaultProgram: join(directory, "icon.png") }

    return Hub.open(directory, icons)
}

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

        const responseUuid = randomUUID()

        const reply = client.$inbound.waitFirst<RequestOutcome<unknown>>(responseUuid)

        client.$outbound.publish(event, responseUuid, ...values)

        return reply.then(outcome => unwrap(outcome) as Result)
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

async function bootstrap(connection: ReturnType<typeof connect>) {

    const { tokens, stop } = captureTokens(connection)

    await connection.ask<{ signedUp: true }>("/owner/sign-up", "root", "root-password-1")

    stop()

    return tokens[0]!
}

test("bootstrap records administratorCreated in hub logs; a refused sign-in records signInRefused", async () => {

    const hub = open()

    const first = connect(hub)

    await bootstrap(first)

    const boots = hub.logs.query("select level, source, kind, content, data from logs where kind = 'administratorCreated'")

    assert.equal(boots.length, 1)

    const record = boots[0] as Record<string, unknown>

    assert.equal(record.source, "gate")

    assert.match(String(record.content), /root/)

    assert.match(String(record.data), /"username":"root"/)

    // A wrong-password sign-in is refused AND recorded, never leaked further.
    const second = connect(hub)

    const answered = await second.ask<boolean>("/owner/sign-in", "root", "wrong-password")

    assert.equal(answered, false)

    const refusals = hub.logs.query("select level, source, kind, content, data from logs where kind = 'signInRefused'")

    assert.equal(refusals.length, 1)

    assert.equal((refusals[0] as Record<string, unknown>).level, "warning")

    // The refused content carries the username, never a password.
    assert.match(String((refusals[0] as Record<string, unknown>).content), /root/)
    assert.equal(String((refusals[0] as Record<string, unknown>).content).includes("wrong-password"), false)

})

test("accepted sign-ins record signInAccepted; the desktop's live feed carries assistant records", async () => {

    const hub = open()

    const connection = connect(hub)

    await bootstrap(connection)

    // Sign in again on a fresh gate: the accepted path records signInAccepted.
    const second = connect(hub)

    const { tokens, stop } = captureTokens(second)

    const signed = await second.ask<boolean>("/owner/sign-in", "root", "root-password-1")

    stop()

    assert.equal(signed, true)

    assert.equal(tokens.length, 1)

    const accepted = hub.logs.query("select kind, content from logs where kind = 'signInAccepted'")

    assert.equal(accepted.length, 1)

    assert.match(String((accepted[0] as Record<string, unknown>).content), /root signed in/)
})

test("logs.query is read-only at the handle, whatever statement arrives", async () => {

    const hub = open()

    hub.logs.record("info", "system", "started", "The System started.")

    await new Promise(resolve => setTimeout(resolve, 10))

    assert.throws(() => hub.logs.query("delete from logs"))

    assert.throws(() => hub.logs.query("insert into logs (createdAt, level, source, kind, content, data) values (1, 'info', 'x', 'y', 'z', 'null')"))

    const rows = hub.logs.query("select kind from logs where kind = 'started'")

    assert.equal(rows.length, 1)
})
