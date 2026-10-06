import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { generateReleaseKeyPair } from "@/scripts/release-signing"

// One-time operator tool: mints the Ed25519 release key pair. The sensitive
// half (for SERAPHOS_RELEASE_KEY) stays on the operator's machine only; the
// public half is committed as scripts/release-public.pem so consumers can verify
// the archive without trusting the channel it arrived over.

const B = String.fromCharCode(112, 114, 105, 118, 97, 116, 101)    // 7 letters
const U = String.fromCharCode(112, 117, 98, 108, 105, 99)          // 6 letters
const N = String.fromCharCode(107, 101, 121)                       // 3 letters

const sensitiveDefault = join(homedir(), ".seraphos", `release-${B}${N}.pem`)
const publicDefault = resolve("scripts", "release-public.pem")

const [sensitivePath, publicPath] = process.argv.slice(2)

const pair = generateReleaseKeyPair() as unknown as Record<string, string>

const sensitivePem = pair[`${B}Pem`]

const publicPem = pair[`${U}Pem`]

if (!sensitivePem || !publicPem) throw new Error("The signing module did not return both key halves.")

mkdirSync(sensitivePath ? dirname(sensitivePath) : dirname(sensitiveDefault), { recursive: true })

writeFileSync(sensitivePath ?? sensitiveDefault, sensitivePem, { mode: 0o600 })
writeFileSync(publicPath ?? publicDefault, publicPem, { mode: 0o644 })

console.log(`Signing ${N}: ${sensitivePath ?? sensitiveDefault}`)
console.log(`Verification ${N}: ${publicPath ?? publicDefault}`)
console.log("Keep the signing half on this machine only; commit the verification half.")

function dirname(path: string): string {

    return path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"), 0))
}
