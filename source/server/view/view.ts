import { type ApplicationIcons } from "@server/core/application"
import Hub from "@server/core/hub"
import { serveStatic } from "@hono/node-server/serve-static"
import { createAdaptorServer } from "@hono/node-server"
import { WebSocketServer } from "ws"
import doors from "./http/doors"
import gateway from "./gateway/gateway"
import gatewayAddress from "./gateway/address"
import program from "./http/program/program"
import proxy from "./http/proxy"
import storage from "./http/storage"
import uploads from "./http/uploads"
import link from "./http/link"
import cfonts from "cfonts"
import { Hono } from "hono"
import hardened from "./http/hardened"
import { resolve } from "node:path"
import { writeFile } from "node:fs/promises"
import { styleText } from "node:util"
import { listenOnPorts } from "./configuration"
import { name, version } from "@/source/identity"

export default async function (config: Config) {

    const debugging = config.mode === "development"

    // A banner needs a terminal to draw on; a service, a pipe, or a runner
    // has none, and must never fail the System for wanting one.
    if (process.stdout?.isTTY) {

        try {

            cfonts.say(`${name} v${version}`, {

                colors: ["blue", "white"],

                font: "simple"
            })
        }

        catch { }
    }

    const icons: ApplicationIcons = { system: resolve("assets/logo.png"), defaultProgram: resolve("assets/default-icon.png") }

    const hub = Hub.open(config.home, icons)

    observeHubLifecycle(hub)

    // One server, five doors, each at its own name. The link door is the
    // multi-user gate; the other doors resolve the caller's token to its own
    // account-space before answering. Every door answers inside one wall.
    const server = new Hono()

    server.use("*", hardened())

    server.route(doors.link, link(hub, debugging))

    server.route(doors.proxy, proxy(hub))

    server.route(doors.storage, storage(hub))

    server.route(doors.uploads, uploads(hub))

    server.route(doors.program, program(hub))

    if (config.assets) server.use("*", serveStatic({ root: config.assets }))

    const hostname = config.hostname ?? "localhost"

    const listener = createAdaptorServer({

        fetch: server.fetch,

        websocket: {

            server: new WebSocketServer({ noServer: true })
        }
    })

    const port = await listenOnPorts(listener, hostname, config.ports)

    const origin = `http://localhost:${port}`

    await writeFile(resolve(config.home, "desktop"), `${origin}\n`, { mode: 0o600 })

    try { hub.logs.record("info", "system", "started", `The System listens on ${hostname}:${port}`, { hostname, port, mode: config.mode }) }
    catch { /* Logging never obstructs boot. */ }

    const localGateway = await gateway(hub, gatewayAddress(config.home))

    if (config.assets) console.log(`  ➜  ${styleText("bold", "Desktop:")} ${origin}`)

    console.log(`  ➜  ${styleText("bold", "Gateway:")} ${localGateway.path}`)

    return { origin }
}

// Crashes and shutdowns survive their own process: these run BEFORE any
// teardown a handler could skip, and the hub logger opens lazily on write.
const exitLogs = new Map<Hub, () => void>()

export function observeHubLifecycle(hub: Hub): void {

    if (exitLogs.has(hub)) return

    const write = (level: "info" | "error", kind: string, content: string) => {

        try { hub.logs.record(level, "system", kind, content, null) }
        catch { /* A dying process logs best-effort or not at all. */ }
    }

    const crash = (origin: string) => (error: unknown) => {

        write("error", kind(origin), `${origin}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    }

    const kind = (origin: string) => origin === "unhandledRejection" ? "unhandledRejection" : "uncaughtException"

    const stop = (origin: string) => () => write("info", "shutdown", `The System is stopping (${origin})`)

    const listeners = [
        ["uncaughtException", crash("uncaughtException")] as const,
        ["unhandledRejection", crash("unhandledRejection")] as const,
        ["SIGINT", stop("SIGINT")] as const,
        ["SIGTERM", stop("SIGTERM")] as const,
        ["exit", stop("exit")] as const
    ]

    for (const [event, handler] of listeners) {

        if (event === "uncaughtException") process.on("uncaughtException", handler as (error: unknown) => void)

        else if (event === "unhandledRejection") process.on("unhandledRejection", handler as (reason: unknown) => void)

        else process.once(event, handler as () => void)

        // uncaughtException/unhandledRejection keep listening; a Map entry per
        // hub stays for the process's life, so removal is only for signals.
    }

    exitLogs.set(hub, () => undefined)
}

export interface Config {

    mode: "development" | "production"

    /** Absolute authoritative state root selected by Main. */
    home: string

    assets?: string

    hostname?: string

    /** Ordered public port candidates. Omit to let the operating system assign one. */
    ports?: readonly number[]
}