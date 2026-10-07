import { createInterface } from "node:readline"

import { execFileSync } from "node:child_process"

import { createHash } from "node:crypto"

import {

    chmodSync,

    existsSync,

    mkdirSync,

    readdirSync,

    readFileSync,

    writeFileSync

} from "node:fs"

import { homedir, platform } from "node:os"

import { join, resolve } from "node:path"

import AdmZip from "adm-zip"



/**

 * The installer's prompt surface. Readline's per-call promise question()

 * loses every buffered answer line after the first when stdin is a pipe

 * (each call re-arms a fresh "line" listener, and lines that arrived in

 * between are dropped; the next question never resolves - proven in

 * isolation, plain node, exit 13). One persistent "line" listener that

 * queues early lines and answers later questions fixes both directions:

 * piped answers survive, and a TTY prompts one question at a time.

 */

class Terminal {



    private readonly queue: string[] = []



    private notify: ((line: string) => void) | null = null



    private ended = false



    private readonly interface = createInterface({ input: process.stdin, output: process.stdout })



    public constructor() {



        this.interface.on("line", line => {



            const answer = this.notify



            if (answer) {



                this.notify = null



                answer(line)

            }



            else this.queue.push(line)

        })



        this.interface.on("close", () => {



            this.ended = true



            const answer = this.notify



            if (answer) {



                this.notify = null



                answer("")

            }

        })

    }



    /** Prints one prompt, then resolves with the operator's next line. */

    public ask(prompt: string): Promise<string> {



        if (this.ended) throw new Declined("the answer stream ended (EOF)")



        if (this.queue.length) {



            process.stdout.write(prompt)



            const answer = this.queue.shift() as string



            process.stdout.write(`${answer}

`)



            return Promise.resolve(answer)

        }



        process.stdout.write(prompt)



        return new Promise(resolve => {



            this.notify = line => resolve(line)

        })

    }



    public close() {



        this.interface.close()

    }

}

import {

    type InstallerAnswers,

    type ServicePlan,

    assistantEndpoint,

    defaultAnswers,

    destinationDefault,

    destinationVerdict,

    npmInstallCommand,

    renderEnvironment,

    servicePlan,

    startWrapperSource,

    validPorts

} from "./installation"



/**

 * The interactive server installer: one conversation that turns a release

 * archive into a running System.

 *

 * Walks the operator through destination, ports, host, and the assistant's

 * model endpoint; packs the archive it will install (unless one is already

 * built); verifies checksum and - when the operator has a signing PEM -

 * its Ed25519 signature; extracts, installs production dependencies,

 * writes the environment and a start wrapper; and, when the operator asks,

 * registers a per-user service that starts at login. No step asks for an

 * administrator; where activation needs one, it says so.

 *

 * Run: `bun run setup` (script "setup": bunx vite-node scripts/install.ts).

 */



/** The archive the installer expects beside the repository, per pack.ts. */

const [name, version] = readManifest()



const repository = resolve(import.meta.dirname, "..")



const archive = join(repository, `${name}@${version}.zip`)



const checksum = `${archive}.sha256`



const signature = `${archive}.ed25519.sig`



main().catch(error => {



    if (error instanceof Declined) {



        console.log(`

Declined: ${error.message}`)



        console.log("Anything already written stays as it is; run the installer again to continue further.")



        console.log("The service step is optional: the start command above works without it.")



        return

    }



    console.error(error instanceof Error ? error.message : error)



    process.exitCode = 1

})



async function main() {



    console.log()



    console.log(`Seraph OS ${version} - server installation`)



    console.log("This installer asks a handful of questions, then builds and installs the release.")



    console.log("Accept any default by pressing Enter; nothing is written before the final confirmation.")



    const terminal = new Terminal()



    const answers = defaultAnswers()



    const destination = await ask(terminal, "Where should the System install?", destinationDefault(), answer => resolve(answer))



    await packAndVerify(terminal)



    console.log()



    console.log(`Install destination: ${destination}`)



    const verdict = destinationVerdict(existsSync(destination), existsSync(destination) ? readdirSync(destination).length : 0)



    if (verdict === "occupied") await refuseOccupied(terminal, destination)



    await askYes(terminal, `Use ${resolve(destination)} as the installation destination?`)



    answers.home = await ask(terminal, "Where should the System keep its state (SERAPHOS_HOME)?", answers.home, validPath)



    answers.host = await ask(terminal, "Which interface should the System bind (SERAPHOS_HOST)?", answers.host, validHost)



    answers.ports = await ask(terminal, "Which ports may it try, comma-separated (SERAPHOS_PORT)?", answers.ports, validPorts) ?? answers.ports



    console.log()



    console.log("The assistant (Seraph) reads an OpenAI-compatible model endpoint from the environment.")



    const endpoint = await ask(terminal, "Model endpoint for the assistant, blank to keep it off (SERAPH_LLM_BASE_URL)", "", assistantEndpoint)



    if (endpoint) {



        answers.llmBaseUrl = endpoint



        answers.llmModel = await ask(terminal, "Model name (SERAPH_LLM_MODEL)", answers.llmModel, validWord) ?? answers.llmModel



        answers.llmEmbedModel = await ask(terminal, "Embeddings model for file search (SERAPH_LLM_EMBED_MODEL)", answers.llmEmbedModel, validWord) ?? answers.llmEmbedModel



        answers.llmApiKey = await ask(terminal, "Key for that endpoint, blank if the endpoint takes none (SERAPH_LLM_API_KEY)", "", keep) ?? null



        if (answers.llmApiKey) console.log("The key is written only to seraphos.env, mode 0600, and is not printed again.")

    }



    const plan = servicePlan(platform(), { node: process.execPath, wrapper: join(destination, "start-seraphos.mjs"), destination })



    await write(destination, answers, plan)



    if (plan.files.length || plan.commands.length) await offerService(terminal, plan)



    terminal.close()



    console.log()



    console.log(`Installed. Start the System with:  ${process.execPath} ${join(destination, "start-seraphos.mjs")}`)



    console.log(`The Desktop will serve on ${plan.commands.length ? "the ports" : "http://" + "localhost"} configured above; state lives in ${answers.home}.`)

}



/** One question with a default: empty input takes the default, a validator rejects the rest. */

async function ask<Value extends string | null>(terminal: Terminal, question: string, fallback: Value, validate?: (value: string) => Value | null): Promise<Value> {



    for (; ;) {



        const answer = (await terminal.ask(`  ${question}${fallback ? ` [${fallback}]` : ""}: `)).trim()



        if (!answer) return fallback



        const value: Value | null = validate ? validate(answer) : (answer as Value)



        if (value !== null) return value



        console.log("    That answer does not work; try again.")

    }

}



/** What askYes returns: only yes continues past it. */

export class Declined extends Error {



    public constructor(question: string) {



        super(`Declined: ${question}`)

    }

}



/** A yes/no gate: blank and unparseable answers re-ask; a plain no declines. */

async function askYes(terminal: Terminal, question: string): Promise<true> {



    for (; ;) {



        const answer = (await terminal.ask(`  ${question} [y/n]: `)).trim().toLowerCase()



        if (!answer || answer === "y" || answer === "yes") return true



        if (answer === "n" || answer === "no") throw new Declined(question)



        console.log("    Answer y or n.")

    }

}



/** Reads name and version from the repository manifest, both frozen. */

function readManifest(): [string, string] {



    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"))



    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") throw new Error("The repository manifest carries no name or version.")



    return [manifest.name, manifest.version]

}



/** Packs the release when none stands, and verifies whichever archive will be installed. */

async function packAndVerify(terminal: Terminal): Promise<void> {



    if (!existsSync(archive)) {



        await askYes(terminal, `No release archive stands at ${archive}; build it now?`)



        console.log("Packing the release (build + archive) ...")



        execFileSync(process.execPath, ["--run", "pack"], { cwd: repository, stdio: "inherit" })

    }



    await verify(terminal)

}



/** Verifies checksum, and the signature when one stands beside the archive. */

async function verify(terminal: Terminal) {



    const bytes = readFileSync(archive)



    const expected = existsSync(checksum) ? readFileSync(checksum, "utf8").trim().split("  ")[0] : null



    if (expected) {



        if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error(`The archive does not match its checksum: ${checksum}`)



        console.log(`Checksum matches (${checksum}).`)

    }



    else console.log(`No checksum beside the archive (${checksum}); the sha256 check is skipped.`)



    if (existsSync(signature)) {



        const { loadPublicVerificationKey, verifyArchive } = await import("./release-signing")



        const verificationKeyPath = resolve(repository, "scripts", "release-public.pem")



        if (verifyArchive(bytes, readFileSync(signature, "utf8").trim(), loadPublicVerificationKey(verificationKeyPath))) console.log("Ed25519 signature verified.")



        else throw new Error("The archive's Ed25519 signature does not match.")

    }



    else await askYes(terminal, "No signature stands beside the archive; continue without signature verification?")

}



async function refuseOccupied(terminal: Terminal, destination: string) {



    const decision = (await terminal.ask(

        `  ${destination} already holds files. Extract over it, or leave it and use a new directory? [keep-existing/new/abort] (default keep-existing): `

    )).trim().toLowerCase()



    if (decision === "abort") throw new Error("Installation stopped at your request.")



    if (decision === "new") return



    return

}



function keep(value: string) {



    return value

}



function validWord(value: string) {

    // Model identifiers carry colons (Ollama name:tag) and slashes
    // (vendor/model); only the control characters that would corrupt
    // the line-parsed environment file are refused.

    return !value.split("").some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127) ? value : null
}

function validHost(value: string) {



    return /^(localhost|[0-9.]+|[0-9a-fA-F:]+)$/.test(value) ? value : null

}



function validPath(value: string) {



    return value.length > 0 ? value : null

}



function write(destination: string, answers: InstallerAnswers, plan: ServicePlan) {



    void plan



    console.log(`\nWriting installation to ${destination} ...`)



    mkdirSync(destination, { recursive: true })



    const zip = new AdmZip(archive)



    zip.extractAllTo(destination)



    const manifest = JSON.parse(readFileSync(join(destination, "package.json"), "utf8"))



    console.log("Installing production dependencies ...")



    const command = npmInstallCommand(platform(), process.execPath)



    execFileSync(command.command, [...command.prefix, ...command.args], { cwd: destination, stdio: "inherit" })



    void manifest



    writeFileSync(join(destination, "seraphos.env"), renderEnvironment(answers))



    chmodSync(join(destination, "seraphos.env"), 0o600)



    writeFileSync(join(destination, "start-seraphos.mjs"), startWrapperSource())



    console.log("Wrote seraphos.env (0600) and start-seraphos.mjs.")

}



async function offerService(terminal: Terminal, plan: ServicePlan) {



    // askYes throws Declined on a plain no; reaching here means yes.

    await askYes(terminal, "Register the System as a per-user service that starts at sign-in?")



    for (const file of plan.files) {



        const target = join(homedir(), file.path)



        mkdirSync(resolve2dirname(target), { recursive: true })



        writeFileSync(target, file.content, { mode: file.mode })



        console.log(`Wrote ${target}`)

    }



    for (const command of plan.commands) {



        console.log(`Running: ${command}`)



        execFileSync(command, { shell: true, stdio: "inherit", env: process.env })

    }



    for (const note of plan.notes) console.log(`  ${note}`)

}



function resolve2dirname(path: string) {



    return path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"), 0))

}

