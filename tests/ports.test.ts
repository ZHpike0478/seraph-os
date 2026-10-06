import { strict as assert } from "node:assert"
import { createServer } from "node:http"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { defaultHome, defaultPorts, environmentPorts, listenOnPorts, parsePorts, portRange, requestedPorts } from "@server/view/configuration"
import { test } from "vitest"

test("ports contract", async () => {
  assert.equal(environmentPorts("seraphos", {}), undefined)
  assert.deepEqual(environmentPorts("seraphos", { SERAPHOS_PORT: "4305" }), [4305])
  assert.deepEqual(
      environmentPorts("seraphos", { SERAPHOS_PORT: "4196,4234,5000-5002,4234" }),
      [4196, 4234, 5000, 5001, 5002]
  )
  assert.deepEqual(portRange(6400, 6499), Array.from({ length: 100 }, (_, index) => 6400 + index))
  assert.deepEqual(defaultPorts(false), portRange(6400, 6499))
  assert.deepEqual(defaultPorts(true), portRange(6300, 6399))
  assert.equal(defaultHome(false), resolve(homedir(), ".seraphos"))
  assert.equal(defaultHome(true), resolve("storage"))

  for (const value of ["", "0", "65536", "43.12", "port", "6400-", "6401-6400", "6400,,6401"]) {

      assert.throws(() => parsePorts(value, "SERAPHOS_PORT"), /SERAPHOS_PORT must contain ports or inclusive ranges/)
  }

  const occupied = createServer()
  const available = createServer()

  const occupiedPort = await listenOnPorts(occupied, "127.0.0.1")
  const availablePort = await listenOnPorts(available, "127.0.0.1")

  await close(available)

  const selected = createServer()

  assert.equal(await listenOnPorts(selected, "127.0.0.1", [occupiedPort, availablePort]), availablePort)

  await assert.rejects(
      listenOnPorts(createServer(), "127.0.0.1", [occupiedPort, availablePort]),
      /No configured System port is available/
  )

  await Promise.all([close(occupied), close(selected)])

  const temporary = await mkdtemp(join(tmpdir(), "seraphos-port-request-"))
  const request = join(temporary, "next-port")

  try {

      await writeFile(request, "4400,4500-4502\n")

      assert.deepEqual(await requestedPorts(["node", "main.js", "--port-request", request]), [4400, 4500, 4501, 4502])
      await assert.rejects(readFile(request), error => (error as NodeJS.ErrnoException).code === "ENOENT")
  }

  finally { await rm(temporary, { recursive: true, force: true }) }

  function close(server: ReturnType<typeof createServer>) {

      return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}, 120_000)
