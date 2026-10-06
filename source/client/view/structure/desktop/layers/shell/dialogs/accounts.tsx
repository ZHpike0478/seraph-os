import type { AccountView } from "@server/core/link-manager/auth-manager/auth-manager"
import { surfaceLifecyclePose, surfacePresenceTransition } from "@client/view/appearance/surface-presence"
import { useReducedMotion } from "@libs/react-motion"
import { motion } from "motion/react"
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type SyntheticEvent } from "react"
import { AuthManagerContext } from "@client/view/contexts"
import ShellSurface, { shellSurfaceClassName } from "../shell-surface"
import TaskbarButton from "../taskbar/taskbar-button"
import Alert from "@client/view/components/alert"
import usePromise from "@libs/react-promise"
import { Button, Input, SegmentedControl, Text, useAppearance, useScale, useTiming } from "@phreshos/react-ui"

/**
 * Whether the Accounts surface is open, held outside React so the Taskbar's
 * trigger and the Shell's dialog stay free siblings of the default Shell.
 */
let requested = false

const watchers = new Set<() => void>()

/** Opens the administrator's Accounts surface. */
export function openAccounts() {

    setRequested(true)
}

function setRequested(open: boolean) {

    requested = open

    for (const watcher of watchers) watcher()
}

function useRequested() {

    return useSyncExternalStore(collectWatchers, collectRequested, collectRequested)
}

function collectWatchers(watcher: () => void) {

    watchers.add(watcher)

    return function () {

        watchers.delete(watcher)
    }
}

function collectRequested() {

    return requested
}

/** The Taskbar's entry into account management, shown only to administrators. */
export function AccountsButton() {

    const auth = AuthManagerContext.useValue()

    if (auth.role !== "admin") return null

    return <TaskbarButton

        icon={<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="block size-full">

            <circle cx="8" cy="5.25" r="2.5" />

            <path d="M2.75 13.5c.75-2.75 2.75-4 5.25-4s4.5 1.25 5.25 4" />

        </svg>}

        label="Accounts"

        aria-label="Accounts"

        aria-haspopup="dialog"

        onPress={() => setRequested(true)}

    />
}

/**
 * The administrator's Accounts surface: who uses this System, and what may
 * change about them. It renders nothing while closed and for anyone but an
 * administrator; its listing and its changes all ride the accounts routes.
 */
export function AccountsDialog() {

    const auth = AuthManagerContext.useValue()

    const open = useRequested()

    const role = auth.role ?? "user"

    const visible = open && role === "admin"

    const surface = useRef<HTMLDialogElement>(null)

    const title = useId()

    const reducedMotion = useReducedMotion()

    const transaction = useTiming()("change")

    const space = useScale(useAppearance().spacing)

    const [accounts, setAccounts] = useState<AccountView[]>([])

    const [failure, setFailure] = useState<string | null>(null)

    const [resetting, setResetting] = useState<string | null>(null)

    const [resetPassword, setResetPassword] = useState("")

    const [newUsername, setNewUsername] = useState("")

    const [newPassword, setNewPassword] = useState("")

    const [newRole, setNewRole] = useState<"admin" | "user">("user")

    const begun = useRef(false)

    const refresh = useCallback(function () {

        auth.accounts("list").then(function (value) {

            setAccounts(Array.isArray(value) ? value as AccountView[] : [])

            setFailure(null)
        }, function (reason) {

            setAccounts([])

            setFailure(String(reason))
        })

    }, [auth])

    const change = usePromise(async function (operation: "set-role" | "set-disabled" | "reset-credentials", username: string, extra?: unknown) {

        await auth.accounts(operation, username, ...(extra === undefined ? [] : [extra]))

        refresh()

        return true
    })

    const creation = usePromise(async function (username: string, password: string, role: "admin" | "user") {

        await auth.accounts("create", username, password, role)

        setNewUsername("")

        setNewPassword("")

        setNewRole("user")

        refresh()

        return true
    })

    const busy = change.isPending || creation.isPending

    const error = change.exception?.current ?? creation.exception?.current ?? failure

    useEffect(function () {

        const element = surface.current

        if (!visible || !element || element.open) return

        element.showModal()

        return function () {

            if (element.open) element.close()
        }

    }, [visible])

    function clearErrors() {

        change.reset()

        creation.reset()

        setFailure(null)
    }

    function close() {

        setRequested(false)
    }

    function submitCreation(event: SyntheticEvent<HTMLFormElement>) {

        event.preventDefault()

        if (busy || !newUsername.trim() || !newPassword) return

        clearErrors()

        void creation.safeExecute(newUsername, newPassword, newRole)
    }

    if (!visible) {

        begun.current = false

        return null
    }

    // The first listing happens while the surface is born, so it opens with
    // the accounts rather than one effect round-trip after.
    if (!begun.current) {

        begun.current = true

        refresh()
    }

    return <motion.dialog

        ref={surface}

        aria-modal="true"

        aria-labelledby={title}

        initial={reducedMotion ? surfaceLifecyclePose.visible : surfaceLifecyclePose.hidden}

        animate={surfaceLifecyclePose.visible}

        transition={surfacePresenceTransition(reducedMotion, transaction)}

        onCancel={function (event) { event.preventDefault(); close() }}

        className={`${shellSurfaceClassName} pointer-events-auto fixed inset-0 m-auto h-fit w-[min(32rem,calc(100dvw/var(--desktop-scale)-var(--desktop-gutter)*2))] backdrop:bg-transparent`}

    >

        <ShellSurface material="full" label="Accounts" labelId={title}>

            <div className="grid" style={{ gap: space.large }}>

                <div className="grid" style={{ gap: space.xsmall }}>

                    {accounts.map(function (account) {

                        return <AccountRow

                            key={account.username}

                            account={account}

                            busy={busy}

                            resetting={resetting === account.username}

                            resetValue={resetting === account.username ? resetPassword : ""}

                            onResetValue={setResetPassword}

                            onBeginReset={function () {

                                setResetPassword("")

                                setResetting(account.username)
                            }}

                            onCancelReset={function () { setResetting(null) }}

                            onReset={function () {

                                clearErrors()

                                void change.safeExecute("reset-credentials", account.username, resetPassword).then(function (done: boolean | undefined) {

                                    if (!done) return

                                    setResetting(null)

                                    setResetPassword("")
                                })
                            }}

                            onRole={function () {

                                clearErrors()

                                void change.safeExecute("set-role", account.username, account.role === "admin" ? "user" : "admin")
                            }}

                            onDisabled={function () {

                                clearErrors()

                                void change.safeExecute("set-disabled", account.username, !account.disabled)
                            }}

                        />
                    })}

                    {accounts.length === 0 && !failure && <Text tone="secondary" size="small">No accounts yet.</Text>}

                </div>

                {error !== null && <Alert className="text-sm">{String(error)}</Alert>}

                <form

                    className="grid border-t pt-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto] sm:items-end"

                    style={{ gap: space.small }}

                    aria-busy={busy}

                    noValidate

                    onSubmit={submitCreation}

                >

                    <Input label="New username" type="text" size="small" autoComplete="off" disabled={busy} required value={newUsername} onChange={setNewUsername} />

                    <Input label="New password" type="password" size="small" autoComplete="new-password" disabled={busy} required value={newPassword} onChange={setNewPassword} />

                    <SegmentedControl label="Role" size="small" value={newRole} onChange={function (value) { setNewRole(value === "admin" ? "admin" : "user") }}>

                        <SegmentedControl.Item id="user">User</SegmentedControl.Item>

                        <SegmentedControl.Item id="admin">Admin</SegmentedControl.Item>

                    </SegmentedControl>

                    <Button type="submit" size="small" color="primary:base" pending={busy}>Create account</Button>

                </form>

                <div className="flex justify-end">

                    <Button size="small" onPress={close}>Close</Button>

                </div>

            </div>

        </ShellSurface>

    </motion.dialog>
}

/** One account of the store, with everything an administrator may change. */
function AccountRow({ account, busy, resetting, resetValue, onResetValue, onBeginReset, onCancelReset, onReset, onRole, onDisabled }: Readonly<AccountRowProps>) {

    const space = useScale(useAppearance().spacing)

    return <div

        className={`grid items-start rounded-lg border p-2 ${account.disabled ? "opacity-50" : ""}`}

        style={{

            borderColor: "color-mix(in srgb, currentColor 15%, transparent)",

            gap: space.xsmall,

            gridTemplateColumns: "minmax(0, 1fr) auto"
        }}

    >

        <div className="grid min-w-0" style={{ gap: 2 }}>

            <Text className="truncate font-medium">{account.username}</Text>

            <Text className="truncate" size="small" tone="secondary">

                {account.role === "admin" ? "Administrator" : "User"} · {account.disabled ? "Disabled" : "Active"} · {new Date(account.createdAt).toLocaleDateString()}

            </Text>

        </div>

        <div className="flex flex-wrap justify-end gap-2">

            <Button size="xsmall" disabled={busy} onPress={onRole}>{account.role === "admin" ? "Make user" : "Make admin"}</Button>

            <Button size="xsmall" disabled={busy} onPress={onDisabled}>{account.disabled ? "Enable" : "Disable"}</Button>

            <Button size="xsmall" disabled={busy || resetting} onPress={onBeginReset}>Reset password</Button>

        </div>

        {resetting && <form

            className="col-span-full grid sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"

            style={{ gap: space.xsmall }}

            noValidate

            onSubmit={function (event) {

                event.preventDefault()

                if (!busy && resetValue) onReset()
            }}

        >

            <Input

                label="New password"

                type="password"

                size="small"

                autoComplete="new-password"

                disabled={busy}

                required

                value={resetValue}

                onChange={onResetValue}

            />

            <Button type="submit" size="small" pending={busy}>Set password</Button>

            <Button type="button" size="small" disabled={busy} onPress={onCancelReset}>Cancel</Button>

        </form>}

    </div>
}

interface AccountRowProps {

    account: AccountView

    busy: boolean

    resetting: boolean

    resetValue: string

    onResetValue: (value: string) => void

    onBeginReset: () => void

    onCancelReset: () => void

    onReset: () => void

    onRole: () => void

    onDisabled: () => void
}

export default AccountsDialog