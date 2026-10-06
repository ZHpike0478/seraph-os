import assert from "node:assert/strict"
import { join } from "node:path"
import gatewayAddress from "@server/view/gateway/address"
import { test } from "vitest"

test("gateway address contract", async () => {
  const first = gatewayAddress("C:\\Users\\Person\\.seraphos", "win32")

  assert.match(first, /^\\\\\.\\pipe\\seraphos-[a-f0-9]{32}-gateway$/)
  assert.equal(first, gatewayAddress("c:/users/person/.seraphos/", "win32"))
  assert.notEqual(first, gatewayAddress("C:\\Users\\Other\\.seraphos", "win32"))
  assert.equal(gatewayAddress("/home/person/.seraphos", "linux"), join("/home/person/.seraphos", "gateway.sock"))

  console.log("gateway address verified")
}, 120_000)
