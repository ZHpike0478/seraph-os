import { serveStatic } from "@hono/node-server/serve-static"
import Hub from "@server/core/hub"
import doors from "../doors"
import { isIconSize } from "@server/core/link-manager/auth-manager/program-manager/icon"
import { existsSync } from "node:fs"
import { Hono } from "hono"
import { developmentResponse, developmentSocket, developmentTarget } from "./development"
import { frameTheme, themedFrameDocument } from "./frame-document"

/**
 * The browser representation of one Program domain, inside the caller's
 * account-space.
 *
 * Every Client document uses `/program/<assetId>/assets`, independently of
 * whether its source is an installed directory or a live development server.
 * Icons use the same asset identity beneath `/program/<assetId>/icons`.
 */
export default function (hub: Hub) {

    const program = new Hono()

    const statics = new Map<string, ReturnType<typeof serveStatic>>()

    // The hidden Desktop probe deliberately asks from an opaque origin. Keep
    // this header on every Program response so an outer reverse proxy becomes
    // part of the same observable hosting contract.
    program.use("*", async (context, next) => {

        await next()

        context.header("Access-Control-Allow-Origin", "*")
    })

    program.get("/ping", context => {

        context.header("Cache-Control", "no-store")

        return context.text("Program assets are available")
    })

    program.get("/:assetId{[0-9a-f-]{36}}/assets", context => context.redirect(`${new URL(context.req.url).pathname}/`))

    // A development Client's WebSocket is the same asset source as its HTTP
    // documents. Bridging it here keeps HMR beneath the Program asset address.
    program.use("/:assetId{[0-9a-f-]{36}}/assets/:path{.*}", async (context, next) => {

        if (context.req.header("upgrade")?.toLowerCase() !== "websocket") return await next()

        const space = await spaceOf(hub, context)

        if (!space) return context.text("Unauthorized", 401)

        const found = space.programManager.fromAsset(context.req.param("assetId") ?? "")

        if (!found) return context.text("Unknown program", 404)

        const target = developmentTarget(found, context.req.url)

        if (!target) return context.text("The program has no development Client", 404)

        return developmentSocket(context, target)
    })

    program.all("/:assetId{[0-9a-f-]{36}}/assets/:path{.*}", async context => {

        const space = await spaceOf(hub, context)

        if (!space) return context.text("Unauthorized", 401)

        const assetId = context.req.param("assetId") ?? ""

        const found = space.programManager.fromAsset(assetId)

        if (!found) return context.text("Unknown program", 404)

        const target = developmentTarget(found, context.req.url)

        const theme = frameTheme(context.req.raw)

        if (target) return await themedFrameDocument(await developmentResponse(context, target), theme)

        const root = found.clientPath

        // A retained Program may outlive files removed by uninstall().
        if (!root || !existsSync(root)) return context.text("The program has no assets", 404)

        const prefix = `${doors.program}/${assetId}/assets`

        let serve = statics.get(root)

        if (!serve) {

            serve = serveStatic({

                root,

                rewriteRequestPath: path => path.slice(prefix.length)
            })

            statics.set(root, serve)
        }

        const response = await serve(context, async () => undefined)

        return response ? await themedFrameDocument(response, theme) : response
    })

    program.get("/:assetId{[0-9a-f-]{36}}/icons/:file", async context => {

        const space = await spaceOf(hub, context)

        if (!space) return context.text("Unauthorized", 401)

        const found = space.programManager.fromAsset(context.req.param("assetId") ?? "")

        if (!found) return context.text("Unknown program", 404)

        const file = context.req.param("file") ?? ""

        const size = file.endsWith(".png") ? file.slice(0, -4) : ""

        if (!isIconSize(size)) return context.text("Unknown icon size", 404)

        context.header("Cache-Control", "no-cache")

        context.header("Content-Type", "image/png")

        return context.body(Uint8Array.from(await space.programManager.icon(found, size)))
    })

    return program
}

/** The caller's account-space; program assets belong to the space that owns them. */
async function spaceOf(hub: Hub, context: { req: { header: (name: string) => string | undefined } }) {

    return await hub.spaceForTokenByHeader(context.req.header("authorization")).catch(() => null)
}