import assert from "node:assert/strict"
import type { ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { defaultAppearance } from "@phreshos/core"
import { UIProvider } from "@phreshos/react-ui"
import { beforeEach, expect, test, vi } from "vitest"
import AccountsDialog, { AccountsButton, openAccounts } from "@client/view/structure/desktop/layers/shell/dialogs/accounts"

const fixture = vi.hoisted(() => ({
    role: "admin" as "admin" | "user" | null,
    accounts: vi.fn((..._operations: unknown[]) => Promise.resolve([
        { username: "root", role: "admin" as const, disabled: false, createdAt: 1_700_000_000_000 },
        { username: "alice", role: "user" as const, disabled: false, createdAt: 1_700_000_100_000 }
    ]))
}))

vi.mock("@client/view/contexts", () => ({
    ApplicationContext: { useValue: () => ({}) },
    LinkManagerContext: {
        useValue: () => ({
            appearance: {
                value: { taskbar: { position: "bottom" } },
                tunnel: { subscribe: () => () => undefined }
            }
        })
    },
    AuthManagerContext: {
        useValue: () => ({ role: fixture.role, username: "root", accounts: fixture.accounts })
    }
}))

beforeEach(function () {

    fixture.role = "admin"

    fixture.accounts.mockClear()
})

function render(children: ReactNode) {

    return renderToStaticMarkup(<UIProvider appearance={defaultAppearance} preferences={{ theme: "light", animations: true }}>{children}</UIProvider>)
}

test("an administrator sees the Accounts surface and its create form", function () {

    openAccounts()

    const markup = render(<AccountsDialog />)

    assert.match(markup, /<h2[^>]*>Accounts<\/h2>/)

    assert.match(markup, /New username/)

    assert.match(markup, /New password/)

    assert.match(markup, /Create account/)

    assert.match(markup, /No accounts yet/)

    // The surface asked the shared accounts for its first listing as it mounted.
    expect(fixture.accounts.mock.lastCall?.[0]).toBe("list")
})

test("a non-administrator sees no Accounts surface at all", function () {

    fixture.role = "user"

    openAccounts()

    assert.equal(render(<AccountsDialog />), "")

    assert.equal(render(<AccountsButton />), "")

    // Nothing was asked of the accounts routes on a non-admin's behalf.
    assert.equal(fixture.accounts.mock.calls.length, 0)
})

test("the Accounts Taskbar entry belongs to administrators alone", function () {

    fixture.role = "admin"

    openAccounts()

    assert.match(render(<AccountsButton />), /aria-label="Accounts"/)
})