import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { SocketClient } from "@the-link/ipc/socket-client"
import messagepack from "@the-link/messagepack"
import gatewayAddress from "@server/view/gateway/address"
import gateway from "@server/view/gateway/gateway"
import type Hub from "@server/core/hub"
import type Application from "@server/core/application"
import { test } from "vitest"

test("gateway contract", async () => {
  const directory = await mkdtemp(resolve(".verify-gateway-"))
  const path = gatewayAddress(directory)
  const received: unknown[][] = []
  let removed = false
  let boundExternal = false
  const snapshot = {
      linkManager: { appearance: { key: "appearance", value: {} } },
      authManager: {
          programManager: { programs: [] },
          processManager: { processes: [] }
      }
  }
  const space = {
      authentication: { username: "root" },
      linkManager: {
          addExternalConnection() {

              boundExternal = true

              return {
                  async publish(event: string, ...values: unknown[]) {
                      received.push([event, ...values])
                      return [{ event, values }]
                  }
              }
          },
          authManager: { ...snapshot.authManager, toJSON() { return snapshot.authManager } },
          toJSON() { return snapshot.linkManager },
          async removeConnection() { removed = true }
      }
  } as unknown as Application
  const hub = {
      async spaceForToken(token: string) { return token === "gateway-token" ? space : null },
      accounts: { find(username: string) { return username === "root" ? { username: "root", role: "admin", disabled: false, createdAt: new Date() } : null } }
  } as unknown as Hub
  const listener = await gateway(hub, path)
  const client = new SocketClient(path)

  client.setSerialize(messagepack.serialize)

  client.setDeserialize(messagepack.deserialize)

  const ready = client.$inbound.waitFirst("/gateway/ready")

  try {
      await client.connect()

      // The first envelope is the handshake: its answer carries the reason a
      // refused peer would have seen, and nothing bound before it resolved.
      const accepted = await client.$outbound.publishFirst("/gateway/authenticate", "gateway-token", "handshake-1")

      assert.equal(accepted, undefined, "the handshake answered success before any other frame")

      assert.equal(boundExternal, true, "a proven token bound its boundary")

      assert.deepEqual(await ready, snapshot)
      assert.deepEqual(
          await client.$outbound.publishFirst("/auth/example", "authorization", { binary: new Uint8Array([1, 2, 3]) }),
          { event: "/auth/example", values: ["authorization", { binary: new Uint8Array([1, 2, 3]) }] }
      )
      assert.deepEqual(received, [["/auth/example", "authorization", { binary: new Uint8Array([1, 2, 3]) }]])
  } finally {
      await client.disconnect()
      await listener.close()
      await rm(directory, { recursive: true, force: true })
  }

  assert.equal(removed, true)

  console.log("gateway boundary verified")
}, 120_000)
