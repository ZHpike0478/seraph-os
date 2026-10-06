import { createHash, createPrivateKey, createPublicKey, sign, verify, generateKeyPairSync } from "node:crypto"
import { readFileSync } from "node:fs"

/**
 * One detached Ed25519 signature over the release archive's bytes.
 *
 * The scheme stays inside Node's own crypto so the System gains no
 * dependency: a PEM key pair on disk, a one-shot sign over the archive,
 * the base64 signature beside it, and the public key committed in the
 * repository for whoever installs the release.
 */

export interface ReleaseKeyPairPaths {

    private_: string

    public_: string
}

/** Creates an Ed25519 release key pair; the private half never leaves the operator's machine. */
export function generateReleaseKeyPair(): { privatePem: string, publicPem: string } {

    const pair = generateKeyPairSync("ed25519")

    return {

        privatePem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),

        publicPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString()
    }
}

export function loadSigningKey(path: string) {

    return createPrivateKey(readPem(path))
}

export function loadPublicVerificationKey(path: string) {

    return createPublicKey(readPem(path))
}

export function archiveDigest(bytes: Uint8Array): string {

    return createHash("sha256").update(bytes).digest("hex")
}

/** One-shot Ed25519 signature over the archive's own bytes; base64-encoded. */
export function signArchive(bytes: Uint8Array, privateKey: ReturnType<typeof createPrivateKey>): string {

    return sign(null, bytes, privateKey).toString("base64")
}

export function verifyArchive(bytes: Uint8Array, signatureBase64: string, publicKey: ReturnType<typeof createPublicKey>): boolean {

    try {

        return verify(null, bytes, publicKey, Buffer.from(signatureBase64, "base64"))
    }

    catch {

        return false
    }
}

function readPem(path: string): string {

    return readFileSync(path, "utf8")
}
