import { strict as assert } from "node:assert"
import { defaultHostname, environmentHostname } from "@server/view/configuration"
import { test } from "vitest"

test("listener hostname contract", () => {
  assert.equal(defaultHostname(), "localhost")
  assert.equal(environmentHostname("seraphos", {}), undefined)
  assert.equal(environmentHostname("seraphos", { SERAPHOS_HOST: "0.0.0.0" }), "0.0.0.0")
  assert.equal(environmentHostname("seraphos", { SERAPHOS_HOST: "::" }), "::")
  assert.equal(environmentHostname("seraphos", { SERAPHOS_HOST: "desktop.internal" }), "desktop.internal")

  for (const value of ["", " ", " localhost", "localhost ", "two hosts"]) {
    assert.throws(
      () => environmentHostname("seraphos", { SERAPHOS_HOST: value }),
      /SERAPHOS_HOST must contain one hostname or IP address/
    )
  }
})
