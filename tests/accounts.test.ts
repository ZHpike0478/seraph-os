import { strict as assert } from "node:assert"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, test } from "vitest"
import Accounts, { type AccountRole } from "@server/core/accounts"

const homes: string[] = []

const stores: Accounts[] = []

afterAll(function () {

    for (const store of stores) store.close()

    // Windows briefly holds freshly closed SQLite handles; a leftover temp
    // directory harms nothing, so cleanup stays best-effort.
    for (const directory of homes) {

        try { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
        catch { }
    }
})

function open(): Accounts {

    const directory = mkdtempSync(join(tmpdir(), "seraph-accounts-"))

    homes.push(directory)

    const store = Accounts.open(join(directory, "accounts.sqlite"))

    stores.push(store)

    return store
}

async function create(database: Accounts, username: string, password: string, role: AccountRole) {

    return database.create(username, password, role)
}

test("bootstrap detection", async () => {

    const accounts = open()

    assert.equal(accounts.needsBootstrap(), true)

    await accounts.create("admin", "initial-password", "admin")

    assert.equal(accounts.needsBootstrap(), false)
})

test("create, list, find", async () => {

    const accounts = open()

    const admin = await accounts.create("admin", "initial-password", "admin")

    assert.equal(admin.username, "admin")

    assert.equal(admin.role, "admin")

    assert.equal(admin.disabled, false)

    const display = await accounts.create("  Alice  ", "alice-password", "user")

    assert.equal(display.username, "Alice")

    const listed = accounts.list()

    assert.deepEqual(listed.map(account => account.username), ["admin", "Alice"])

    assert.equal(accounts.find("Alice")?.username, "Alice") // NFKC + trim lookup

    assert.equal(accounts.find("nobody"), null)

    // snapshots carry no credential material
    assert.deepEqual(Object.keys(accounts.list()[0]!), ["username", "role", "disabled", "createdAt"])
})

test("verify and disabled accounts", async () => {

    const accounts = open()

    await accounts.create("admin", "initial-password", "admin")
    await accounts.create("bob", "bob-password", "user")

    assert.deepEqual(await accounts.verify("admin", "initial-password"), { username: "admin", role: "admin" })
    assert.deepEqual(await accounts.verify("bob", "bob-password"), { username: "bob", role: "user" })

    assert.equal(await accounts.verify("bob", "wrong-password"), null)
    assert.equal(await accounts.verify("nobody", "bob-password"), null)
    assert.equal(await accounts.verify("", "bob-password"), null)

    await accounts.setDisabled("bob", true)

    assert.equal(await accounts.verify("bob", "bob-password"), null)

    await accounts.setDisabled("bob", false)

    assert.deepEqual(await accounts.verify("bob", "bob-password"), { username: "bob", role: "user" })
})

test("credential reset keeps role and disability", async () => {

    const accounts = open()

    await accounts.create("carol", "carol-password", "user")
    await accounts.setDisabled("carol", true)

    await accounts.resetCredentials("carol", "next-password")

    assert.equal(await accounts.verify("carol", "carol-password"), null)
    assert.equal(await accounts.verify("carol", "next-password"), null) // still disabled

    await accounts.setDisabled("carol", false)

    assert.deepEqual(await accounts.verify("carol", "next-password"), { username: "carol", role: "user" })
})

test("role changes and last-admin lockout", async () => {

    const accounts = open()

    await accounts.create("root", "root-password", "admin")
    await accounts.create("dave", "dave-password", "user")

    await accounts.setRole("dave", "admin")

    assert.equal(accounts.find("dave")?.role, "admin")

    await accounts.setRole("dave", "user")

    assert.equal(accounts.find("dave")?.role, "user")

    // the only administrator can be neither demoted nor disabled
    await assert.rejects(accounts.setRole("root", "user"), /last administrator/)
    await assert.rejects(accounts.setDisabled("root", true), /last administrator/)

    await accounts.create(" Backup ", "backup-password", "admin")

    // a second administrator unblocks both
    await accounts.setRole("root", "user")
    await accounts.setDisabled("root", true)

    assert.equal(accounts.find("root")?.disabled, true)
})

test("create validation errors", async () => {

    const accounts = open()

    await accounts.create("admin", "initial-password", "admin")

    for (const username of ["", "   ", "\u0000", "x".repeat(65)]) {

        await assert.rejects(create(accounts, username, "valid-password-123", "user"), /invalid/)
    }

    for (const password of ["short", "", "admin"]) {

        await assert.rejects(create(accounts, "newuser", password, "user"), /invalid/)
    }

    await assert.rejects(create(accounts, "admin", "another-password", "user"), /already exists/)
})

test("accounts persist across reopen", async () => {

    const directory = mkdtempSync(join(tmpdir(), "seraph-accounts-"))

    homes.push(directory)

    const path = join(directory, "accounts.sqlite")

    const first = Accounts.open(path)

    await first.create("admin", "initial-password", "admin")
    await first.create("bob", "bob-password", "user")

    const second = Accounts.open(path)

    assert.deepEqual(second.list().map(account => account.username), ["admin", "bob"])
    assert.equal(second.needsBootstrap(), false)
    assert.deepEqual(await second.verify("bob", "bob-password"), { username: "bob", role: "user" })
})