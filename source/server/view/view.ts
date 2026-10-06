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

    const localGateway = await gateway(hub, gatewayAddress(config.home))

    if (config.assets) console.log(`  ➜  ${styleText("bold", "Desktop:")} ${origin}`)

    console.log(`  ➜  ${styleText("bold", "Gateway:")} ${localGateway.path}`)

    return { origin }
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