import type { AssistantConfirmManagerSnapshot, AssistantConfirmSnapshot } from "@server/core/assistant-confirm"
import { Publish, Subscribe } from "@the-link/core/decorators"
import { TheLink } from "@the-link/core"
import type AuthManager from "./auth-manager"

/** Synchronized Desktop view of authoritative pending assistant write confirmations. */
export default class AssistantConfirmManager extends TheLink {

    public readonly confirms: Map<string, AssistantConfirmSnapshot>

    public constructor(authManager: AuthManager, payload: AssistantConfirmManagerSnapshot) {

        super()

        this.confirms = new Map(payload.requests)

        this.connectTo(authManager, "/assistant-confirm")
    }

    public list() {

        return [...this.confirms.values()]
    }

    public pending(identity: string) {

        return this.confirms.has(identity)
    }

    public async allow(identity: string) {

        await this.$outbound.publishFirst("/allow", identity)
    }

    public async deny(identity: string) {

        await this.$outbound.publishFirst("/deny", identity)
    }

    @Subscribe("/request")
    @Publish("/requests", "inbound")
    protected async requested(request: AssistantConfirmSnapshot) {

        this.confirms.set(request.identity, request)

        return this.list()
    }

    @Subscribe("/resolve")
    @Publish("/requests", "inbound")
    protected async resolved(request: AssistantConfirmSnapshot) {

        this.confirms.delete(request.identity)

        return this.list()
    }
}
