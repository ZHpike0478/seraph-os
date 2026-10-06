import assert from "node:assert/strict"
import { createHash, createPrivateKey, createPublicKey } from "node:crypto"
import { test } from "vitest"
import { archiveDigest, generateReleaseKeyPair, signArchive, verifyArchive } from "../scripts/release-signing.ts"

test("release signing round-trips over the archive bytes", () => {
  const pair = generateReleaseKeyPair()
  const sensitiveKey = createPrivateKey(pair.privatePem)
  const publicKey = createPublicKey(pair.publicPem)
  const bytes = Buffer.from("seraph archive bytes", "utf8")

  assert.equal(verifyArchive(bytes, signArchive(bytes, sensitiveKey), publicKey), true)
})

test("a flipped archive byte breaks the Ed25519 signature", () => {
  const pair = generateReleaseKeyPair()
  const sensitiveKey = createPrivateKey(pair.privatePem)
  const publicKey = createPublicKey(pair.publicPem)
  const bytes = Buffer.from("seraph archive bytes", "utf8")
  const signature = signArchive(bytes, sensitiveKey)
  const tampered = Buffer.from(bytes)
  tampered[6] ^= 0x01

  assert.equal(verifyArchive(tampered, signature, publicKey), false)
})

test("wrong verification half refuses a valid signature over the archive", () => {
  const first = generateReleaseKeyPair()
  const second = generateReleaseKeyPair()
  const firstSensitive = createPrivateKey(first.privatePem)
  const secondPublic = createPublicKey(second.publicPem)
  const bytes = Buffer.from("seraph archive bytes", "utf8")
  const signature = signArchive(bytes, firstSensitive)

  assert.equal(verifyArchive(bytes, signature, secondPublic), false)
})

test("archiveDigest equals the inline node:crypto sha256 hex digest", () => {
  const bytes = Buffer.from("seraph archive bytes", "utf8")

  assert.equal(archiveDigest(bytes), createHash("sha256").update(bytes).digest("hex"))
  assert.match(archiveDigest(bytes), /^[0-9a-f]{64}$/)
})

test("an Ed25519 signature decodes to exactly 64 base64 bytes", () => {
  const pair = generateReleaseKeyPair()
  const sensitiveKey = createPrivateKey(pair.privatePem)
  const bytes = Buffer.from("seraph archive bytes", "utf8")
  const signature = Buffer.from(signArchive(bytes, sensitiveKey), "base64")

  assert.equal(signature.length, 64)
})

test("a malformed signature refuses verification instead of throwing", () => {
  const pair = generateReleaseKeyPair()
  const publicKey = createPublicKey(pair.publicPem)
  const bytes = Buffer.from("seraph archive bytes", "utf8")

  assert.equal(verifyArchive(bytes, "///not base64 with bad length///", publicKey), false)
})
