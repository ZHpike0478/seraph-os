import assert from "node:assert/strict"
import { homedir } from "node:os"
import { join } from "node:path"
import { test } from "vitest"
import {
    type InstallerAnswers,
    assistantEndpoint,
    chooseArchive,
    defaultAnswers,
    destinationDefault,
    destinationVerdict,
    homeDefault,
    npmInstallCommand,
    renderEnvironment,
    servicePlan,
    startWrapperSource,
    validPorts
} from "../scripts/installation"

const answers: InstallerAnswers = {

    home: "/home/operator/.seraphos",
    host: "localhost",
    ports: "6400-6499",
    llmBaseUrl: "http://localhost:11434/v1",
    llmApiKey: null,
    llmModel: "llama3.2",
    llmEmbedModel: "nomic-embed-text"
}

test("defaults carry the runbook's production shape", () => {

    const base = defaultAnswers()

    assert.equal(base.home, homeDefault())

    assert.equal(base.home, join(homedir(), ".seraphos"))

    assert.equal(base.host, "localhost")

    assert.equal(base.ports, "6400-6499")

    assert.equal(base.llmBaseUrl, null, "the assistant stays off unless asked for")

    assert.equal(base.llmModel, "llama3.2")

    assert.equal(destinationDefault(), join(homedir(), ".seraphos", "system"))

    // Defaults validate through their own rules.

    assert.equal(validPorts(base.ports), base.ports)
})

test("port answers validate through the System's own parser", () => {

    assert.equal(validPorts("6400-6499"), "6400-6499")

    assert.equal(validPorts("7105,7106"), "7105,7106")

    assert.equal(validPorts(""), null, "blank is not a selection")

    assert.equal(validPorts("   "), null)

    assert.equal(validPorts("99999"), null, "an invalid port refuses")

    assert.equal(validPorts("7106-7105"), null, "an inverted range refuses")

    assert.equal(validPorts("http://x"), null, "nonsense refuses")
})

test("assistant endpoint answers trim, strip trailing slashes, and blank to off", () => {

    assert.equal(assistantEndpoint("  http://localhost:11434/v1/// "), "http://localhost:11434/v1")

    assert.equal(assistantEndpoint(""), null)

    assert.equal(assistantEndpoint("   "), null)
})

test("the environment file carries SERAPHOS values and the assistant block only when on", () => {

    const text = renderEnvironment(answers)

    assert.match(text, /^# /m, "the file says what it is")

    assert.match(text, /SERAPHOS_HOME=\/home\/operator\/\.seraphos/)

    assert.match(text, /SERAPHOS_HOST=localhost/)

    assert.match(text, /SERAPHOS_PORT=6400-6499/)

    assert.match(text, /SERAPH_LLM_BASE_URL=http:\/\/localhost:11434\/v1/)

    assert.match(text, /SERAPH_LLM_MODEL=llama3\.2/)

    assert.match(text, /SERAPH_LLM_EMBED_MODEL=nomic-embed-text/)

    assert.doesNotMatch(text, /SERAPH_LLM_API_KEY/, "no key line when no key was given")

    const keyed = renderEnvironment({ ...answers, llmApiKey: "sk-local" })

    assert.match(keyed, /SERAPH_LLM_API_KEY=sk-local/)

    // With the assistant off, no SERAPH_LLM line appears at all.

    const off = renderEnvironment({ ...answers, llmBaseUrl: null })

    assert.doesNotMatch(off, /SERAPH_LLM/)
})

test("the start wrapper loads the environment file and starts the server", () => {

    const source = startWrapperSource()

    assert.match(source, /seraphos\.env/)

    assert.match(source, /server\/main\.js/)

    assert.match(source, /process\.env\[match\[1\]\] = match\[2\]/, "file values win only when unset")

    assert.match(source, /cwd: here/)
})

test("service plans register per-user services on the three supported platforms", () => {

    const installation = { node: "/usr/bin/node", wrapper: "/home/o/.seraphos/system/start-seraphos.mjs", destination: "/home/o/.seraphos/system" }

    const linux = servicePlan("linux", installation)

    assert.equal(linux.files.length, 1)

    assert.match(linux.files[0].path, /systemd\/user\/seraphos\.service$/)

    assert.match(linux.files[0].content, /ExecStart=\/usr\/bin\/node \/home\/o\/\.seraphos\/system\/start-seraphos\.mjs/)

    assert.match(linux.files[0].content, /WantedBy=default\.target/, "user units want default.target, not multi-user.target")

    assert.deepEqual(linux.commands, [
        "systemctl --user daemon-reload",
        "systemctl --user enable --now seraphos.service"
    ])

    const darwin = servicePlan("darwin", installation)

    assert.match(darwin.files[0].path, /Library\/LaunchAgents\/app\.seraphos\.system\.plist$/)

    assert.match(darwin.files[0].content, /RunAtLoad/)

    assert.match(darwin.files[0].content, /KeepAlive/)

    const win32 = servicePlan("win32", installation)

    assert.equal(win32.files.length, 0)

    assert.equal(win32.commands.length, 1)

    assert.match(win32.commands[0], /^schtasks \/create \/f \/tn SeraphOS \/sc onlogon/)

    // cmd quotes /tr as ONE argument whose inner quotes double.
    assert.ok(win32.commands[0].includes("tr \"\\\"/usr/bin/node\\\" \\\"/home/o/.seraphos/system/start-seraphos.mjs\\\"\""))
    })

test("the npm install command matches the distribution contract on every platform", () => {

    const flags = ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock"]

    const windows = npmInstallCommand("win32", "C:\\\\Program Files\\\\node\\\\node.exe")

    assert.equal(windows.command, "C:\\\\Program Files\\\\node\\\\node.exe")

    assert.equal(windows.prefix.length, 1, "the Windows npm CLI path arrives whole")

    assert.equal(windows.prefix[0].lastIndexOf("npm-cli.js"), windows.prefix[0].length - "npm-cli.js".length)

    assert.ok(windows.prefix[0].includes("npm"))

    assert.deepEqual(windows.args, flags)

    const unix = npmInstallCommand("linux", "/usr/bin/node")

    assert.equal(unix.command, "npm")

    assert.deepEqual(unix.prefix, [])

    assert.deepEqual(unix.args, flags)
})

test("the freshest archive wins, and non-archives are ignored", () => {

    assert.equal(chooseArchive([]), null)

    assert.equal(chooseArchive(["README.md", "seraphos@0.2.0.zip.sha256", "seraphos@0.2.0.zip.ed25519.sig"]), null, "checksums and signatures are not archives")

    assert.equal(chooseArchive(["seraphos@0.1.117.zip", "seraphos@0.2.0.zip"]), "seraphos@0.2.0.zip")

    assert.equal(chooseArchive(["seraphos@0.2.0.zip", "seraphos@0.2.10.zip", "seraphos@0.2.9.zip"]), "seraphos@0.2.10.zip", "versions compare numerically, not lexically")

    assert.equal(chooseArchive(["seraphos@1.0.0.zip", "seraphos@0.9.9.zip"]), "seraphos@1.0.0.zip")
})

test("a destination is judged from what the caller saw on the disk", () => {

    assert.equal(destinationVerdict(false, 0), "fresh")

    assert.equal(destinationVerdict(true, 0), "empty")

    assert.equal(destinationVerdict(true, 3), "occupied")
})
