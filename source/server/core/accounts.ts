import { DatabaseSync } from "node:sqlite"
import { randomBytes, scrypt as derive, timingSafeEqual } from "node:crypto"

const parameters = {

    cost: 16_384,

    blockSize: 8,

    parallelization: 1,

    keyLength: 64
} as const

const requirements = {

    username: { minimumLength: 1, maximumLength: 64 },

    password: { minimumLength: 8, maximumLength: 1_024 }
} as const

export type AccountRole = "admin" | "user"

export type AccountSnapshot = Readonly<{

    username: string

    role: AccountRole

    disabled: boolean

    createdAt: Date
}>

type VerifyOutcome = Readonly<{ username: string, role: AccountRole }> | null

/**
 * Persistent accounts for one installation, in SQLite.
 *
 * One row per person. Passwords hold to the same scrypt shape as the
 * owner credential record, so a later migration of the owner file into
 * this table needs no rehash. The store is transactional; writes go
 * through one serialized queue in the order callers asked for them.
 */
export default class Accounts {

    private readonly database: DatabaseSync

    private queue: Promise<unknown>

    private constructor(database: DatabaseSync, queue: Promise<unknown>) {

        this.database = database

        this.queue = queue
    }

    public static open(path: string) {

        const database = new DatabaseSync(path)

        database.exec("pragma journal_mode = wal; pragma busy_timeout = 5000")

        database.exec(`

            create table if not exists accounts (

                username text primary key,

                role text not null check (role in ('admin', 'user')),

                algorithm text not null,

                salt text not null,

                hash text not null,

                cost integer not null,

                block_size integer not null,

                parallelization integer not null,

                key_length integer not null,

                disabled integer not null default 0,

                created_at integer not null
            )
        `)

        return new Accounts(database, Promise.resolve())
    }

    /** Whether anyone can administer the System yet. */
    public needsBootstrap(): boolean {

        return this.first("role = 'admin'") === null
    }

    /** Every account, without credential material. */
    public list(): AccountSnapshot[] {

        return this.all().map(public_ => snapshot(public_))
    }

    /** One account by name, without credential material. */
    public find(username: string): AccountSnapshot | null {

        const found = this.byUsername(username)

        return found ? snapshot(found) : null
    }

    public create(username: string, password: string, role: AccountRole): Promise<AccountSnapshot> {

        return this.serialize(async () => {

            const normalized = normalizeUsername(username)

            const invalid = validate(normalized, password)

            if (invalid) throw new Error(`The credentials are invalid: ${invalid}`)

            const existing = this.byUsername(normalized)

            if (existing) throw new Error("An account with that username already exists")

            const record = await createRecord(normalized, password, role)

            this.insert(record)

            return snapshot(record)
        })
    }

    /** Replaces one account's password. Role and disability are untouched. */
    public resetCredentials(username: string, password: string): Promise<void> {

        return this.serialize(async () => {

            const normalized = normalizeUsername(username)

            const invalid = validate(normalized, password)

            if (invalid) throw new Error(`The credentials are invalid: ${invalid}`)

            const found = this.byUsername(normalized)

            if (!found) throw new Error("No account with that username exists")

            const next = await createRecord(found.username, password, found.role as AccountRole)

            this.database.prepare(`

                update accounts

                set algorithm = ?, salt = ?, hash = ?, cost = ?, block_size = ?, parallelization = ?, key_length = ?

                where username = ?
            `).run(next.algorithm, next.salt, next.hash, next.cost, next.blockSize, next.parallelization, next.keyLength, found.username)
        })
    }

    public setRole(username: string, role: AccountRole): Promise<void> {

        return this.serialize(() => {

            const normalized = normalizeUsername(username)

            const found = this.byUsername(normalized)

            if (!found) throw new Error("No account with that username exists")

            if (found.role === role) return

            if (found.role === "admin" && role === "user" && this.countAdministrators() === 1) {

                throw new Error("The last administrator cannot be demoted")
            }

            this.database.prepare("update accounts set role = ? where username = ?").run(role, found.username)
        })
    }

    public setDisabled(username: string, disabled: boolean): Promise<void> {

        return this.serialize(() => {

            const normalized = normalizeUsername(username)

            const found = this.byUsername(normalized)

            if (!found) throw new Error("No account with that username exists")

            if (disabled && found.role === "admin" && this.countAdministrators() === 1) {

                throw new Error("The last administrator cannot be disabled")
            }

            this.database.prepare("update accounts set disabled = ? where username = ?").run(disabled ? 1 : 0, found.username)
        })
    }

    /** Resolves one sign-in, or null for any failure. Disabled accounts never sign in. */
    public async verify(username: string, password: string): Promise<VerifyOutcome> {

        const normalized = normalizeUsername(username)

        if ([...password].length > requirements.password.maximumLength) return null

        const found = this.byUsername(normalized)

        if (!found || found.disabled) return null

        const candidate = await hashPassword(password, Buffer.from(found.salt, "base64"), {

            cost: found.cost,

            blockSize: found.blockSize,

            parallelization: found.parallelization,

            keyLength: found.keyLength
        })

        const expected = Buffer.from(found.hash, "base64")

        const matches = candidate.length === expected.length && timingSafeEqual(candidate, expected)

        return matches ? { username: found.username, role: found.role as AccountRole } : null
    }

    /** Closes the underlying database; Windows needs this before deleting the directory. */
    public close() {

        this.database.close()
    }

    private serialize<Result>(change: () => Promise<Result> | Result): Promise<Result> {

        const next = this.queue.then(change, change)

        this.queue = next.then(() => undefined, () => undefined)

        return next
    }

    private all(): AccountRecord[] {

        return this.database.prepare(`

            select username, role, salt, hash, cost, block_size as blockSize, parallelization, key_length as keyLength, disabled, created_at as createdAt

            from accounts order by created_at asc, username asc
        `).all() as unknown as AccountRecord[]
    }

    /** Rows keep snake_case columns; the select aliases them onto the record shape. */
    private byUsername(username: string): AccountRecord | null {

        const rows = this.database.prepare(`

            select username, role, salt, hash, cost, block_size as blockSize, parallelization, key_length as keyLength, disabled, created_at as createdAt

            from accounts where username = ?
        `).all(username) as unknown as AccountRecord[]

        return rows[0] ?? null
    }

    private first(where: string): AccountRecord | null {

        const rows = this.database.prepare(`

            select username, role, salt, hash, cost, block_size as blockSize, parallelization, key_length as keyLength, disabled, created_at as createdAt

            from accounts where ${where} limit 1
        `).all() as unknown as AccountRecord[]

        return rows[0] ?? null
    }

    private countAdministrators(): number {

        const row = this.database.prepare("select count(*) as total from accounts where role = 'admin' and disabled = 0").get() as { total: number | bigint }

        return Number(row.total)
    }

    private insert(record: AccountRecord) {

        const createdAt = record.createdAt instanceof Date ? record.createdAt.getTime() : record.createdAt

        this.database.prepare(`

            insert into accounts

                (username, role, algorithm, salt, hash, cost, block_size, parallelization, key_length, disabled, created_at)

            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(record.username, record.role, record.algorithm, record.salt, record.hash, record.cost, record.blockSize, record.parallelization, record.keyLength, record.disabled ? 1 : 0, createdAt)
    }
}

async function createRecord(username: string, password: string, role: AccountRole): Promise<AccountRecord> {

    const salt = randomBytes(16)

    const hash = await hashPassword(password, salt, parameters)

    return {

        username,

        role,

        algorithm: "scrypt",

        salt: salt.toString("base64"),

        hash: hash.toString("base64"),

        cost: parameters.cost,

        blockSize: parameters.blockSize,

        parallelization: parameters.parallelization,

        keyLength: parameters.keyLength,

        disabled: false,

        createdAt: new Date()
    }
}

function hashPassword(password: string, salt: Buffer, shape: ScryptParameters) {

    return new Promise<Buffer>(function (resolve, reject) {

        derive(password, salt, shape.keyLength, {

            cost: shape.cost,

            blockSize: shape.blockSize,

            parallelization: shape.parallelization,

            maxmem: 64 * 1_024 * 1_024

        }, function (exception, key) {

            if (exception) reject(exception)

            else resolve(key)
        })
    })
}

function normalizeUsername(username: string) {

    return username.trim().normalize("NFKC")
}

function validate(username: string, password: string): string | null {

    const usernameLength = [...username].length

    if (usernameLength < requirements.username.minimumLength) return "username-required"

    if (usernameLength > requirements.username.maximumLength || /\p{Cc}/u.test(username)) return "username-invalid"

    const passwordLength = [...password].length

    if (passwordLength < requirements.password.minimumLength) return "password-too-short"

    if (passwordLength > requirements.password.maximumLength) return "password-too-long"

    if (password.normalize("NFKC").toLowerCase() === username.toLowerCase()) return "password-matches-username"

    return null
}

function snapshot(record: AccountRecord): AccountSnapshot {

    const created = record.createdAt instanceof Date ? record.createdAt : new Date(record.createdAt)

    return Object.freeze({

        username: record.username,

        role: record.role as AccountRole,

        disabled: Boolean(record.disabled),

        createdAt: created
    })
}

interface AccountRecord {

    username: string

    role: string

    algorithm: string

    salt: string

    hash: string

    cost: number

    blockSize: number

    parallelization: number

    keyLength: number

    disabled: number | boolean

    createdAt: number | Date
}

interface ScryptParameters {

    cost: number

    blockSize: number

    parallelization: number

    keyLength: number
}