import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, test } from "vitest"
import Hub from "@server/core/hub"
import type Assistant from "@server/core/assistant/assistant"
import {
    assistantConfigPath,
    configurationView,
    ragStatus,
    saveSpaceConfiguration,
    clearSpaceConfiguration,
    loadSpaceConfiguration,
    configurationOf,
    reopenAssistant,
    type AssistantConfigView
} from "@server/core/assistant-config"

const homes: string[] = []

afterAll(function () {

    for (const directory of homes) {

        try { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
        catch { }
    }
})

import Gate from "@server/core/hub-gate"
import { TheLink } from "@the-link/core"
import { randomUUID } from "node:crypto"

const icons = { system: "system-icon.png", defaultProgram: "program-icon.png" }

/** One hub + one signed-in admin space, through the real gate. */
async function bootedSpace() {

    const home = mkdtempSync(join(tmpdir(), "assistant-config-"))

    homes.push(home)

    const hub = Hub.open(home, icons)

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

    function ask(event: string, ...values: unknown[]) {

        const uuid = randomUUID()

        const reply = client.$inbound.waitFirst<{ success: boolean, result?: unknown, error?: { message?: string } }>(uuid)

        client.$outbound.publish(event, uuid, ...values)

        return reply
    }

    const tokens: string[] = []

    client.$inbound.subscribe("/session/signed-in", value => {

        if (typeof value === "string") tokens.push(value)
    })

    const outcome = await ask("/owner/sign-up", "root", "root-password-1")

    assert.equal(outcome.success, true)

    const space = await hub.spaceForToken(tokens[0]!)

    assert.ok(space)

    return { home, hub, space: space! }
}

test("configuration validation: shape, URL, key normalization", () => {

    assert.equal(configurationOf(null), null)

    assert.equal(configurationOf({}), null)

    assert.equal(configurationOf({ baseUrl: "nope", model: "m", embedModel: "e" }), null, "a non-URL endpoint refuses")

    const good = configurationOf({ baseUrl: "http://x:1/v1/", model: "m", embedModel: "e", apiKey: "  " })

    assert.ok(good)

    assert.equal(good.baseUrl, "http://x:1/v1", "trailing slashes strip")

    assert.equal(good.apiKey, "", "a blank key is none, not null")

    assert.equal(configurationOf({ baseUrl: "http://x:1/v1", model: "m", embedModel: "e", apiKey: "sk" })!.apiKey, "sk")
})

test("config view: environment default, space override, key never echoed", { timeout: 20_000 }, async () => {

    const { home, hub, space } = await bootedSpace()

    void home  // the space's own path is what the config checks use

    // No environment endpoint configured in this test process: the view
    // says so without inventing one.

    const empty = await configurationView(space)

    assert.equal(empty.live, false)

    assert.equal(empty.hasKey, false)

    // Saving applies live only when the values validate.

    const saved = await saveSpaceConfiguration(space, {
        baseUrl: "http://localhost:9/v1",
        model: "probe-model",
        embedModel: "probe-embed",
        apiKey: "probe-key"
    })

    assert.equal(saved.source, "space")

    assert.equal(saved.hasKey, true)

    assert.equal(existsSync(assistantConfigPath(space.homePath)), true)

    // File is 0600 and carries the key (server-side only).

    const raw = readFileSync(assistantConfigPath(space.homePath), "utf8")

    assert.match(raw, /probe-key/)

    // Views show hasKey, never the key.

    const view = await configurationView(space)

    assert.equal(view.hasKey, true)

    assert.equal(!JSON.stringify(view).includes("probe-key"), true, "no key in any view")

    // The blank-key save keeps the stored key.

    const kept = await saveSpaceConfiguration(space, {
        baseUrl: "http://localhost:9/v1",
        model: "probe-model-2",
        embedModel: "probe-embed",
        apiKey: "",
        keepKey: true
    })

    assert.equal(kept.hasKey, true, "blank keeps stored")

    assert.equal(kept.model, "probe-model-2")

    // Clear returns to the environment and unloads the live assistant.

    await clearSpaceConfiguration(space)

    const cleared = await configurationView(space)

    assert.equal(cleared.source, "environment")

    assert.equal(cleared.live, false)

    assert.equal(await loadSpaceConfiguration(space.homePath), null)

    for (const opened of await hub.openedSpaces()) opened.close()
})

test("rag status reports count/geometry/reset without an endpoint", { timeout: 20_000 }, async () => {

    const { hub, space } = await bootedSpace()

    const status = await ragStatus(space)

    assert.equal(status.count, 0)

    assert.deepEqual(status.paths, [])

    assert.equal(status.embeddingsAvailable, false)

    for (const opened of await hub.openedSpaces()) opened.close()
})

test("reopenAssistant replaces the live instance (with a config it exists, without it is null)", { timeout: 20_000 }, async () => {

    const { hub, space } = await bootedSpace()

    const before: Assistant | null = space.assistant

    assert.ok(before === null, "no endpoint configured: the assistant starts null")

    reopenAssistant(space, { baseUrl: "http://localhost:9/v1", model: "m", embedModel: "e", apiKey: "" })

    const reopened: Assistant | null = space.assistant

    assert.ok(reopened !== null, "the reopened assistant exists")

    assert.equal(reopened.toolCatalog().some(tool => tool.name === "files_index"), true, "the rag tools ride the reopened assistant")

    reopenAssistant(space, null)

    assert.ok(space.assistant === null, "cleared: the assistant is null again")

    for (const opened of await hub.openedSpaces()) opened.close()
})

test("a saved configuration governs the next boot of the same space", { timeout: 20_000 }, async () => {

    const { home, hub, space } = await bootedSpace()

    await saveSpaceConfiguration(space, { baseUrl: "http://saved:1/v1", model: "saved-model", embedModel: "saved-embed", apiKey: null })

    for (const opened of await hub.openedSpaces()) opened.close()

    // Reopen the whole hub: the space's boot configuration now comes from
    // the saved file, not the (unset) environment.

    const hub2 = Hub.open(home, icons)

    const tokens2: string[] = []

    const client2 = new TheLink()

    const gate2 = Gate.open(hub2)

    client2.$outbound.forwardTo(async function (event, ...values) {

        const [responseUuid, ...rest] = values as [string | null, ...unknown[]]

        gate2.receive(String(event), typeof responseUuid === "string" ? responseUuid : null, ...rest)

        return []
    })

    gate2.$outbound.forwardTo(async function (event, ...values) {

        await client2.$inbound.publish(event, ...values)
    })

    function ask2(event: string, ...values: unknown[]) {

        const uuid = randomUUID()

        const reply = client2.$inbound.waitFirst<{ success: boolean, result?: unknown }>(uuid)

        client2.$outbound.publish(event, uuid, ...values)

        return reply
    }

    client2.$inbound.subscribe("/session/signed-in", value => {

        if (typeof value === "string") tokens2.push(value)
    })

    // The space's boot configuration came from the saved file, so the
    // assistant exists at boot (the environment carried nothing).

    await ask2("/owner/sign-in", "root", "root-password-1")

    assert.ok(tokens2.length >= 1, "sign-in happened")

    const space2 = await hub2.spaceForToken(tokens2[0]!)

    assert.ok(space2)

    assert.equal(space2.assistant !== null, true, "the saved configuration brought the assistant up at boot")

    const view: AssistantConfigView = await configurationView(space2)

    assert.equal(view.source, "space")

    assert.equal(view.baseUrl, "http://saved:1/v1")

    for (const space of await hub2.openedSpaces()) space.close()
})
