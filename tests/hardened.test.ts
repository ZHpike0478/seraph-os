import assert from "node:assert/strict"
import { Hono } from "hono"
import { test } from "vitest"
import hardened from "@server/view/http/hardened"

test("every answer carries the security wall", async () => {

    const app = new Hono()

    app.use("*", hardened())

    app.get("/text", c => c.text("plain"))

    app.get("/json", c => c.json({ ok: true }))

    app.get("/wallpaper", c => {

        // A door that brings its own policy keeps it.
        c.header("Content-Security-Policy", "default-src 'none'; sandbox allow-scripts")

        return c.text("wallpaper")
    })

    const plain = await app.request("http://system/text")

    assert.equal(plain.headers.get("X-Content-Type-Options"), "nosniff")
    assert.equal(plain.headers.get("Referrer-Policy"), "no-referrer")
    assert.equal(plain.headers.get("X-Frame-Options"), "SAMEORIGIN")
    assert.match(plain.headers.get("Content-Security-Policy") ?? "", /default-src 'self'/)
    assert.match(plain.headers.get("Content-Security-Policy") ?? "", /frame-ancestors 'self'/)
    assert.match(plain.headers.get("Content-Security-Policy") ?? "", /object-src 'none'/)

    const json = await app.request("http://system/json")

    assert.equal(json.headers.get("X-Content-Type-Options"), "nosniff")

    const wallpaper = await app.request("http://system/wallpaper")

    assert.equal(wallpaper.headers.get("Content-Security-Policy"), "default-src 'none'; sandbox allow-scripts")
    // The wall still adds what the wallpaper policy does not carry.
    assert.equal(wallpaper.headers.get("X-Content-Type-Options"), "nosniff")
})