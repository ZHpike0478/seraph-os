import type { Context, Next } from "hono"

/**
 * The baseline a door answers with, whatever it serves.
 *
 * The Desktop is one origin serving one app: resources come from the System
 * itself, scripts do not arrive from anywhere else, and no other site may
 * put the Desktop in a frame. Doors that must loosen a directive (program
 * assets for the hidden probe, wallpaper documents with their own policy)
 * override the single header afterwards; the rest of the wall stands.
 */
const headers: [string, string][] = [

    ["X-Content-Type-Options", "nosniff"],

    ["Referrer-Policy", "no-referrer"],

    ["X-Frame-Options", "SAMEORIGIN"]

]

const frameAncestors = "frame-ancestors 'self'"

const contentSecurity = [

    "default-src 'self'",

    "script-src 'self'",

    "style-src 'self' 'unsafe-inline'",

    "img-src 'self' data: blob:",

    "media-src 'self' data: blob:",

    "font-src 'self' data:",

    "connect-src 'self'",

    "worker-src 'self' blob:",

    "object-src 'none'",

    "base-uri 'none'",

    "form-action 'self'",

    frameAncestors

].join("; ")

/** Applies the wall to every answer of one Hono app. */
export default function hardened() {

    return async function (context: Context, next: Next) {

        await next()

        for (const [name, value] of headers) {

            if (!context.res.headers.has(name)) context.res.headers.set(name, value)
        }

        if (!context.res.headers.has("Content-Security-Policy")) {

            context.res.headers.set("Content-Security-Policy", contentSecurity)
        }
    }
}