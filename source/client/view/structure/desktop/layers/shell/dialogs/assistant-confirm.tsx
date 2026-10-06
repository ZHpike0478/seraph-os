import type { AssistantConfirmSnapshot } from "@server/core/assistant-confirm"
import { ReactTunnel } from "@the-link/react"
import { surfaceLifecyclePose, surfacePresenceTransition } from "@client/view/appearance/surface-presence"
import { useReducedMotion } from "@libs/react-motion"
import { motion } from "motion/react"
import { useEffect, useId, useRef } from "react"
import { AuthManagerContext } from "@client/view/contexts"
import ShellSurface, { shellSurfaceClassName } from "../shell-surface"
import usePromise from "@libs/react-promise"
import Alert from "@client/view/components/alert"
import { Button, useTiming } from "@phreshos/react-ui"

/** Default Shell representation of pending assistant write confirmations. */
export default function AssistantConfirmDialog() {

    const manager = AuthManagerContext.useValue().assistantConfirmManager
    const inbound = ReactTunnel.useFactory(manager.$inbound)
    const confirms = inbound.useFirstState("/requests", manager.list())
    const confirm = confirms[0]
    const surface = useRef<HTMLDialogElement>(null)
    const title = useId()
    const description = useId()
    const reducedMotion = useReducedMotion()
    const transaction = useTiming()("change")

    useEffect(() => {

        const element = surface.current

        if (!confirm || !element || element.open) return

        element.showModal()

        return () => { if (element.open) element.close() }
    }, [confirm?.identity])

    if (!confirm) return null

    return <motion.dialog
        ref={surface}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={title}
        aria-describedby={description}
        initial={reducedMotion ? surfaceLifecyclePose.visible : surfaceLifecyclePose.hidden}
        animate={surfaceLifecyclePose.visible}
        transition={surfacePresenceTransition(reducedMotion, transaction)}
        onCancel={event => event.preventDefault()}
        className={`${shellSurfaceClassName} pointer-events-auto fixed inset-0 m-auto h-fit w-[min(28rem,calc(100dvw/var(--desktop-scale)-var(--desktop-gutter)*2))] backdrop:bg-transparent`}
    >
        <ShellSurface material="full" label="Assistant confirmation" labelId={title}>
            <AssistantConfirmView confirm={confirm} description={description} />
        </ShellSurface>
    </motion.dialog>
}

function AssistantConfirmView({ confirm, description }: Readonly<{ confirm: AssistantConfirmSnapshot, description: string }>) {

    const manager = AuthManagerContext.useValue().assistantConfirmManager
    const decision = usePromise((choice: "allow" | "deny") => manager[choice](confirm.identity))

    return <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-5">
        <span aria-hidden="true" className="grid size-8 place-items-center rounded-full border border-sky-600/25 bg-sky-500/15 text-sm font-medium">!</span>
        <div className="grid gap-1">
            <h3 className="text-base font-medium">Seraph asks to make a change</h3>
            <p id={description} className="text-sm leading-6 opacity-60">{confirm.summary}</p>
        </div>
        <div className="col-span-full flex flex-wrap justify-end gap-2">
            <Button size="xsmall" disabled={decision.isPending} onPress={() => decision.safeExecute("deny")}>Deny</Button>
            <Button size="xsmall" autoFocus disabled={decision.isPending} onPress={() => decision.safeExecute("allow")}>Allow</Button>
        </div>
        {decision.exception && <Alert className="col-span-full text-sm">{String(decision.exception.current)}</Alert>}
    </div>
}
