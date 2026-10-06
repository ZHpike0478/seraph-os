import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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

    const directory = mkdtempSync(join(tmpdir(), "seraph-hub-seed-"))

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

    return { client, gate, ask }
}

/** Session tokens the gate pushes while a sign-in runs, oldest first. */
function captureTokens(connection: ReturnType<typeof connect>) {

    const tokens: string[] = []

    const stop = connection.client.$inbound.subscribe("/session/signed-in", value => {

        if (typeof value === "string") tokens.push(value)
    })

    return { tokens, stop }
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

/** Ends a space's own handles the way tests on Windows must before any rm. */
async function closeSpace(space: Awaited<ReturnType<Hub["space"]>>) {

    await space.store.disconnect()

    space.close()
}

test("an opened space finds the seeded seraph Program registered installed", async () => {

    const hub = open()

    const admin = connect(hub)

    await bootstrapAdmin(admin)

    const space = await hub.space("root")

    const entry = space.programManager.programs.get("seraph")

    assert.ok(entry, "the seeded program is registered")

    assert.equal(entry.installed, true)

    assert.equal(entry.program.name, "Seraph")

    assert.notEqual(entry.program.client, null)

    assert.ok(entry.program.clientPath, "the client half resolves to a place")

    const declared = await entry.program.validate()

    assert.equal(declared, undefined, "a valid program validates")

    assert.equal(entry.program.client?.start, true)

    assert.equal(readFileSync(join(entry.program.clientPath!, "index.html"), "utf-8").includes("<h1>Seraph</h1>"), true, "the client half carries its index.html")

    await closeSpace(space)
})

test("launching seraph through the wire creates a process with a client endpoint", async () => {

    const hub = open()

    const admin = connect(hub)

    const adminToken = await bootstrapAdmin(admin)

    const space = await hub.space("root")

    const entry = space.programManager.programs.get("seraph")!

    assert.ok(entry, "seeded before launch")

    const [created] = await admin.ask<unknown[]>("/auth/program/create-process", adminToken, {

        identity: entry.program.identity,

        reference: entry.program.reference
    }, {})

    assert.equal(typeof created, "string", "the wire answers one process identity")

    const running = space.processManager.processes.get(created as string)

    assert.ok(running, "the server created the process")

    assert.equal(running!.program, entry.program, "the process runs the seeded program")

    assert.notEqual(running!.clientEndpoint, null, "the server created a window for its client endpoint")

    assert.equal(running!.program.identity, "seraph")

    await space.processManager.exit(running!.identity)

    assert.equal(space.processManager.processes.has(running!.identity), false, "the process ended cleanly")

    await closeSpace(space)
})

test("reopening the same home keeps the seeded program.json bytes untouched", async () => {

    const hub = open()

    const admin = connect(hub)

    await bootstrapAdmin(admin)

    const first = await hub.space("root")

    const declaration = join(first.programManager.fileManager.path, "seraph", "program.json")

    const seeded = first.programManager.programs.get("seraph")!

    assert.ok(seeded.installed)

    const bytesBefore = readFileSync(declaration)

    assert.ok(bytesBefore.length > 0)

    await closeSpace(first)

    // Same home, fresh Hub, fresh space: the seeder must not rewrite anything.
    const reopened = Hub.open(hub.home, { system: join(hub.home, "logo.png"), defaultProgram: join(hub.home, "icon.png") })

    const second = await reopened.space("root")

    const still = second.programManager.programs.get("seraph")!

    assert.equal(still.installed, true, "the seeded program registers installed again")

    const bytesAfter = readFileSync(declaration)

    assert.equal(Buffer.compare(bytesBefore, bytesAfter), 0, "the seeder never rewrites an existing program.json")

    await closeSpace(second)
})

test("every account-space seeds its own seraph under its own home", async () => {

    const hub = open()

    const admin = connect(hub)

    await bootstrapAdmin(admin)

    const rootSpace = await hub.space("root")

    await hub.accounts.create("alice", "alice-password", "user")

    const aliceSpace = await hub.space("alice")

    const rootProgram = rootSpace.programManager.programs.get("seraph")!

    const aliceProgram = aliceSpace.programManager.programs.get("seraph")!

    assert.ok(rootProgram.installed)

    assert.ok(aliceProgram.installed)

    // Two spaces, two programs: same identity, never one shared record.
    assert.notEqual(rootProgram.program, aliceProgram.program)

    assert.ok(rootProgram.program.root.includes(join("users", "root")))

    assert.ok(aliceProgram.program.root.includes(join("users", "alice")))

    assert.notEqual(rootProgram.program.root, aliceProgram.program.root)

    assert.notEqual(rootSpace.programManager.fileManager.path, aliceSpace.programManager.fileManager.path)

    await closeSpace(rootSpace)

    await closeSpace(aliceSpace)
})

test("a corrupted seed leaves the space openable and usable", async () => {

    const hub = open()

    // A fresh account whose space has never been opened, carrying a
    // broken declaration exactly where the seeder would have laid the
    // real one: an owner's half-written edit, or a damaged copy.
    await hub.accounts.create("x", "x-password-1", "user")

    const broken = join(hub.home, "users", "x", "programs", "seraph", "program.json")

    mkdirSync(join(hub.home, "users", "x", "programs", "seraph"), { recursive: true })

    writeFileSync(broken, "{ not json !!!", "utf-8")

    const space = await hub.space("x")

    // Opening the space must not throw, and its own registry stays usable.
    assert.equal(space.programManager.programs.has("seraph"), false, "an unreadable program is left where it lies")

    // The registry itself answers queries exactly as it would have.
    let refused = false

    try { space.programManager.find("seraph") }

    catch { refused = true }

    assert.equal(refused, true, "the registry answers a missing identity with its usual refusal")

    await closeSpace(space)
})