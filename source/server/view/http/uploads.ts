import { serveStatic } from "@hono/node-server/serve-static"
import { MissingUploadValueError, UploadTooLargeError, uploadLimit } from "@server/core/upload-manager"
import Hub from "@server/core/hub"
import doors from "./doors"
import { Hono } from "hono"
import { isUploadFile } from "@phreshos/core"
import { readFile } from "node:fs/promises"
import { wallpaperKind, wallpaperSizeLimit } from "@shared/wallpaper"

const immutableCache = "public, max-age=31536000, immutable"

const wallpaperPolicy = [
    "default-src 'none'",
    "script-src 'unsafe-inline' data: blob:",
    "style-src 'unsafe-inline' data: blob:",
    "img-src data: blob:",
    "media-src data: blob:",
    "font-src data:",
    "connect-src 'none'",
    "worker-src data: blob:",
    "object-src 'none'",
    "frame-src data: blob:",
    "base-uri 'none'",
    "form-action 'none'",
    "sandbox allow-scripts"
].join("; ")

/**
 * The door bytes come through, and the one they go back out of.
 *
 * Transport only: making a value public is an authorized operation in the
 * connection's own account-space. Reading the completed file needs no
 * authorization: a completed upload's name is unguessable (random UUID) and
 * its reach belongs to the space that uploaded it.
 *
 * The request body remains a stream all the way into UploadManager. Declared
 * oversize bodies are refused before reading; undeclared ones are counted as
 * they arrive, with incomplete temporary files removed on every failure.
 */
export default function (hub: Hub) {

    const uploads = new Hono()

    uploads.post("/", async function (context) {

        const authorization = context.req.header("authorization")

        const space = await hub.spaceForTokenByHeader(authorization).catch(() => null)

        if (!space) return context.text("Unauthorized", 401)

        if (Number(context.req.header("content-length")) > uploadLimit) return context.text(new UploadTooLargeError().message, 413)

        try {

            const upload = await space.authManager.upload(
                authorization,
                context.req.raw.body,
                extension(filename(context.req.header("content-disposition"))) ?? typeExtension(context.req.header("content-type") ?? null),
                context.req.raw.signal
            )

            return context.json(upload)
        }

        catch (exception) {

            if (exception instanceof MissingUploadValueError) return context.text(exception.message, 400)

            if (exception instanceof UploadTooLargeError) return context.text(exception.message, 413)

            if (exception instanceof Error && exception.message === "Unauthorized") return context.text(exception.message, 401)

            console.error(exception)

            return context.text("The value could not be uploaded", 500)
        }
    })

    uploads.get("/:file/stat", async function (context) {

        const space = await hub.spaceForTokenByHeader(context.req.header("authorization")).catch(() => null)

        if (!space) return context.text("Unauthorized", 401)

        try {

            const upload = space.uploads.stat(context.req.param("file"))

            if (!upload) return context.body(null, 404)

            context.header("Cache-Control", immutableCache)

            return context.json(upload)
        }

        catch (error) {

            return context.text(error instanceof Error ? error.message : "Invalid upload", 400)
        }
    })

    uploads.get("/wallpaper/:file", async function (context) {

        const file = context.req.param("file")

        if (!isUploadFile(file)) return context.text("That is not an upload file", 400)
        if (wallpaperKind(file) !== "html") return context.text("That upload is not an HTML wallpaper", 400)

        const space = await hub.spaceForTokenByHeader(context.req.header("authorization")).catch(() => null)

        if (!space) return context.text("Unauthorized", 401)

        try {

            const upload = space.uploads.stat(file)

            if (!upload) return context.body(null, 404)
            if (upload.size > wallpaperSizeLimit) return context.text("A wallpaper cannot exceed 50 MiB", 413)

            context.header("Content-Security-Policy", wallpaperPolicy)
            context.header("Content-Type", "text/html; charset=utf-8")
            context.header("X-Content-Type-Options", "nosniff")
            context.header("Cache-Control", immutableCache)

            return context.body(Uint8Array.from(await readFile(space.uploads.path(file))))
        }

        catch (error) {
            return context.text(error instanceof Error ? error.message : "Invalid wallpaper", 400)
        }
    })

    uploads.use("/:file", async function (context, next) {

        const file = context.req.param("file")

        if (!isUploadFile(file)) return context.text("That is not an upload file", 400)

        const space = await hub.spaceForTokenByHeader(context.req.header("authorization")).catch(() => null)

        if (!space) return context.text("Unauthorized", 401)

        try {

            if (!space.uploads.stat(file)) return context.body(null, 404)
        }

        catch (error) {

            return context.text(error instanceof Error ? error.message : "Invalid upload", 400)
        }

        await next()

        context.header("Cache-Control", immutableCache)
        context.header("Access-Control-Allow-Origin", "*")
    })

    uploads.use("/:file", serveStaticDynamic(hub))

    return uploads
}

/** Static serving from each account-space's uploads, resolved per request. */
function serveStaticDynamic(hub: Hub) {

    const handlers = new Map<string, ReturnType<typeof serveStatic>>()

    return async function (context: ParameterContext, next: () => Promise<void>) {

        const space = await hub.spaceForTokenByHeader(context.req.header("authorization")).catch(() => null)

        if (!space) return context.text("Unauthorized", 401)

        const root = space.uploads.fileManager.path

        let handler = handlers.get(root)

        if (!handler) {

            handler = serveStatic({

                root,

                rewriteRequestPath: path => path.slice(doors.uploads.length + 1)
            })

            handlers.set(root, handler)
        }

        return await handler(context, next)
    }
}

type ParameterContext = Parameters<ReturnType<typeof serveStatic>>[0]

// The standard place a filename travels when a body is raw bytes.
function filename(disposition: string | undefined) {

    const found = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)

    return found ? decodeURIComponent(found[1]) : null
}

// What a file is, as far as its name says. The name itself is not kept:
// it came from a browser, and the extension is the only part of it that
// identifies anything.
function extension(name: string | null) {

    const found = name?.match(/\.([A-Za-z0-9]+)$/)

    return found?.[1]?.toLowerCase() ?? null
}

function typeExtension(type: string | null) {

    if (type?.split(";", 1)[0]?.toLowerCase() === "text/plain") return "txt"

    if (type?.split(";", 1)[0]?.toLowerCase() === "application/json") return "json"

    return "bin"
}