import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"
import Application, { type ApplicationIcons } from "./application"
import Accounts, { type AccountSnapshot } from "./accounts"
import Authentication from "./authentication/authentication"
import openStore from "./open-store"

/**
 * The multi-user registry above account-spaces.
 *
 * One Application per account: its own home directory, store, programs,
 * processes, storage, uploads, appearance, and sessions. Nothing about one
 * space can name another; the hub only routes sign-ins and sessions.
 *
 * The session index maps a raw token's hash to the account-space that created
 * it, so a returning browser reaches its own space again.
 */
export default class Hub {

    public readonly accounts: Accounts

    public readonly home: string

    private readonly icons: ApplicationIcons

    private readonly spaces = new Map<string, Promise<Application>>()

    private readonly sessions: DatabaseSync

    private constructor(home: string, icons: ApplicationIcons, accounts: Accounts, sessions: DatabaseSync) {

        this.home = home

        this.icons = icons

        this.accounts = accounts

        this.sessions = sessions
    }

    public static open(home: string, icons: ApplicationIcons): Hub {

        const accounts = Accounts.open(join(home, "accounts.sqlite"))

        const sessions = new DatabaseSync(join(home, "sessions-index.sqlite"))

        sessions.exec("pragma journal_mode = wal; pragma busy_timeout = 5000")

        sessions.exec(`

            create table if not exists session_index (

                hash text primary key,

                username text not null
            )
        `)

        return new Hub(home, icons, accounts, sessions)
    }

    /** Whether the System still needs its first administrator. */
    public needsBootstrap(): boolean {

        return this.accounts.needsBootstrap()
    }

    /** Creates the first administrator. Refused once any administrator exists. */
    public async bootstrap(username: string, password: string): Promise<AccountSnapshot> {

        if (!this.needsBootstrap()) throw new Error("This System already has an administrator")

        return await this.accounts.create(username, password, "admin")
    }

    public listAccounts(): AccountSnapshot[] {

        return this.accounts.list()
    }

    /** Resolves one sign-in against the account store. */
    public verifySignIn(username: string, password: string) {

        return this.accounts.verify(username, password)
    }

    /**
     * Opens (once) the Application serving one account, with credentials
     * delegated to the account store.
     */
    public space(username: string): Promise<Application> {

        const normalized = username.trim().normalize("NFKC")

        const held = this.spaces.get(normalized)

        if (held) return held

        const opening = this.openSpace(normalized)

        this.spaces.set(normalized, opening)

        return opening
    }

    private async openSpace(username: string): Promise<Application> {

        const homePath = join(this.home, "users", username)

        const store = openStore(join(homePath, "storage"))

        const authentication = await Authentication.openDelegated(username, this.accounts, store)

        return await Application.initialize(homePath, this.icons, authentication)
    }

    /** Records which account-space created a session token. */
    public registerSession(token: string, username: string) {

        const hash = hashToken(token)

        this.sessions.prepare(`

            insert into session_index (hash, username) values (?, ?)

            on conflict(hash) do update set username = excluded.username
        `).run(hash, username)
    }

    /** Resolves a returning token to its account-space. */
    public sessionUsername(token: string): string | null {

        if (typeof token !== "string" || !token) return null

        const rows = this.sessions.prepare(`

            select username from session_index where hash = ?
        `).all(hashToken(token)) as unknown as { username: string }[]

        return rows[0]?.username ?? null
    }

    /** Drops one token's index entry after its space refused it. */
    public forgetSession(token: string) {

        this.sessions.prepare("delete from session_index where hash = ?").run(hashToken(token))
    }

    /** Drops every index entry of one account (its sessions are ending). */
    public forgetSessionsOf(username: string) {

        this.sessions.prepare("delete from session_index where username = ?").run(username)
    }
}

function hashToken(token: string) {

    return createHash("sha256").update(token).digest("base64url")
}