import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "vitest"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

/**
 * The Desktop is a touch surface too: phones and tablets open it through
 * the same document. These CSS touch rules live in the appearance sheet and
 * this contract keeps them there - a regression that deletes one silently
 * gives touch users a page that zooms under a double tap, flashes gray on
 * every press, or zooms into the chat input on focus.
 */
const here = dirname(fileURLToPath(import.meta.url))

const sheet = await readFile(resolve(here, "../source/client/view/appearance/appearance.css"), "utf8")

test("the Desktop denies double-tap zoom but keeps taps, pans, and pinch", () => {

    // `manipulation` takes only double-tap zoom away: taps stay taps, a
    // drag stays a pan the Window gesture can own, and pinch (an
    // accessibility act) stays allowed.

    assert.match(sheet, /\[data-desktop\][^}]*touch-action:\s*manipulation/)
})

test("the Desktop paints no tap highlight on the glass", () => {

    assert.match(sheet, /\[data-desktop\][^}]*tap-highlight-color:\s*transparent/)
})

test("typed-into fields inherit type and stay selectable", () => {

    // Selectability was the sheet's pre-existing input rule; inheriting
    // type joins it, so iOS focus-zoom has no small default to latch onto.

    assert.match(sheet, /\[data-desktop\] :is\(input, textarea, \[contenteditable="true"\], \[contenteditable=""\]\)[^}]*user-select:\s*text/)
    assert.match(sheet, /\[data-desktop\] :is\(input, textarea, \[contenteditable="true"\], \[contenteditable=""\]\)[^}]*font:\s*inherit/)
})