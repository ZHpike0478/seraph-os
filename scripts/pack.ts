import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { name, version } from "@/package.json"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { loadSigningKey, signArchive } from "@/scripts/release-signing"
import { resolve } from "node:path"
import AdmZip from "adm-zip"

const archive = `${name}@${version}.zip`
const zip = new AdmZip()

zip.addLocalFolder(resolve("dist"))

// Bundled assets already live in each consumer's build output. Everything
// else retains its filesystem identity and therefore accompanies the build.
for (const asset of readdirSync(resolve("assets"), { withFileTypes: true })) {

    if (asset.name === "bundled" || asset.name.startsWith(".")) continue

    const source = resolve("assets", asset.name)

    if (asset.isDirectory()) zip.addLocalFolder(source, `assets/${asset.name}`)

    else if (asset.isFile()) zip.addLocalFile(source, "assets")
}

zip.writeZip(resolve(archive))

const checksum = createHash("sha256").update(readFileSync(resolve(archive))).digest("hex")

writeFileSync(resolve(`${archive}.sha256`), `${checksum}  ${archive}\n`)


// Optional detached Ed25519 signature over the archive. Without
// SERAPHOS_RELEASE_KEY the release publishes with its checksum only; a
// configured-but-missing PEM fails the pack instead of silently
// shipping an unsigned artifact.
const signingPath = process.env["SERAPHOS_RELEASE_KEY"]

if (signingPath === undefined) console.log("Unsigned release: set SERAPHOS_RELEASE_KEY to a signing PEM to sign.")

else if (!existsSync(signingPath)) {

    console.error("Signing key not found; refusing to publish an unsigned release.")

    process.exitCode = 1
}

else {

    const signature = signArchive(readFileSync(resolve(archive)), loadSigningKey(signingPath))

    writeFileSync(resolve(`${archive}.ed25519.sig`), `${signature}\n`)

    console.log("Signed the archive (Ed25519).")
}

console.log(`\nPacked ${archive}`)
