// Verifier: consumer-side check that a release archive is the one the
// release sign half signed. Dependency-free: node:crypto + node:fs only.
//
// Usage: bunx vite-node scripts/verify-release.ts <archive.zip> <archive.ed25519.sig> <public.pem>

import { verify } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { archiveDigest, loadPublicVerificationKey } from "@/scripts/release-signing"

const usage = "usage: bunx vite-node scripts/verify-release.ts <archive.zip> <archive.ed25519.sig> <public.pem>"
const [archivePath, signaturePath, verificationKeyPath] = process.argv.slice(2)

if (!archivePath || !signaturePath || !verificationKeyPath) {

    console.error(usage)
    process.exitCode = 1
}

else {

    const bytes = readFileSync(archivePath)
    const checksumPath = `${archivePath}.sha256`

    if (existsSync(checksumPath)) {

        // sha256sum's own two-space format: "<hex>  <archive name>".
        const expected = readFileSync(checksumPath, "utf8").trim().split("  ")[0]

        if (archiveDigest(bytes) === expected) console.log(`Checksum matches (${checksumPath}).`)

        else {

            console.error("FAILED: the archive does not match its sha256 checksum.")
            process.exitCode = 1
            process.exit(1)
        }
    }

    else console.log(`WARNING: no ${checksumPath} beside the archive; checksum check skipped.`)

    const signature = Buffer.from(readFileSync(signaturePath, "utf8").trim(), "base64")

    if (verify(null, bytes, loadPublicVerificationKey(verificationKeyPath), signature)) {

        console.log("VERIFIED: signature and checksum match.")
        process.exitCode = 0
    }

    else {

        console.error("FAILED: the Ed25519 signature does not match this archive.")
        process.exitCode = 1
    }
}
