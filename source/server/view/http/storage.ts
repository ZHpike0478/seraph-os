import { MissingAreaEntryError, NotFileError } from "@libs/file-area"
import { type StorageRequest } from "@server/core/protocol/storage"
import { unframe } from "@libs/framing"
import Hub from "@server/core/hub"
import { Hono } from "hono"

/** The authorized byte-stream door for System and Program storage, per account-space. */
export default function (hub: Hub) {

    const storage = new Hono()

    storage.post("/", async function (context) {

        const authorization = context.req.header("authorization")

        const space = await hub.spaceForTokenByHeader(authorization).catch(() => null)

        if (!space) return context.text("Unauthorized", 401)

        let request: Awaited<ReturnType<typeof unframe<StorageRequest>>>

        try {

            request = await unframe<StorageRequest>(context.req.raw.body)

            validate(request.metadata)
        }

        catch (exception) {

            return context.text(exception instanceof Error ? exception.message : "The storage request is invalid", 400)
        }

        try {

            const metadata = request.metadata

            const { operation, path } = metadata

            if (operation === "stream") {

                await request.body.cancel()

                const body = metadata.scope === "system"
                    ? space.home.stream(path, [metadata.offset, metadata.length])
                    : space.authManager.streamArea(authorization, metadata.program, metadata.area, path, [metadata.offset, metadata.length])

                return new Response(body, {

                    headers: {

                        "cache-control": "no-store",

                        "content-type": "application/octet-stream"
                    }
                })
            }

            if (metadata.operation === "append") {

                if (metadata.scope === "system") await space.home.append(path, request.body, context.req.raw.signal)

                else await space.authManager.appendArea(authorization, metadata.program, metadata.area, path, request.body, context.req.raw.signal)
            }

            else if (metadata.scope === "system") await space.home.write(path, request.body, context.req.raw.signal, metadata.overwrite)

            else await space.authManager.writeArea(authorization, metadata.program, metadata.area, path, request.body, context.req.raw.signal, metadata.overwrite)

            return new Response(null, { status: 204 })
        }

        catch (exception) {

            if (exception instanceof MissingAreaEntryError) return context.text(exception.message, 404)

            if (exception instanceof NotFileError) return context.text(exception.message, 400)

            if (exception instanceof Error && exception.message === "Unauthorized") return context.text(exception.message, 401)

            if (exception instanceof Error && (exception.message.includes("may not leave its area") || exception.message.includes("Writing takes"))) {

                return context.text(exception.message, 400)
            }

            console.error(exception)

            return context.text("The storage operation failed", 500)
        }
    })

    return storage
}

function validate(request: StorageRequest) {

    if (!request || typeof request !== "object") throw new Error("A storage request is required")

    if (request.scope !== "system" && request.scope !== "program") throw new Error("A storage request scope is system or program")

    if (request.scope === "program" && !isProgramAddress(request.program)) throw new Error("A Program storage request needs a Program handle")

    if (request.scope === "program" && request.area !== "data" && request.area !== "cache") throw new Error("A storage area is data or cache")

    if (request.operation !== "stream" && request.operation !== "write" && request.operation !== "append") throw new Error("A storage operation is stream, write, or append")

    if (!Array.isArray(request.path) || request.path.some(part => typeof part !== "string")) throw new Error("A storage path is a list of names")

    if (request.operation === "stream") {

        if (request.offset !== undefined && (!Number.isSafeInteger(request.offset) || request.offset < 0)) throw new Error("A Storage read offset must be a non-negative safe integer")

        if (request.length !== undefined && (!Number.isSafeInteger(request.length) || request.length < 0)) throw new Error("A Storage read length must be a non-negative safe integer")

        if (request.offset !== undefined && request.length !== undefined && !Number.isSafeInteger(request.offset + request.length)) throw new Error("A Storage byte range must use safe integers")
    }
}

function isProgramAddress(value: unknown) {

    return typeof value === "object" && value !== null && typeof (value as { identity?: unknown }).identity === "string"
}