import Application from "./application"
import type { JsonValue, SystemLogLevel } from "@phreshos/core"

/**
 * Troubleshooting instrumentation for the System's own surfaces: one call
 * records a durable, queryable fact in the space's logs.sqlite (the same
 * database the Desktop's system-errors dialog reads) and the live /logs/log
 * feed picks it up through the existing subscribe pipeline. Recording never
 * throws and never delays the caller: a failing log write must not make
 * troubleshooting itself the outage.
 */
export function recordInstrumentation(application: Application, level: SystemLogLevel, source: string, kind: string, content: string, data: JsonValue = null): void {

    try { application.logs.record(level, source, kind, content, data) }
    catch { /* Logging is best-effort, exactly as upstream records are. */ }
}

/** A JSON-safe, size-capped view of a value that may be anything. */
export function safeData(value: unknown): JsonValue {

    try {

        const seen = new WeakSet<object>()

        const capped = JSON.parse(JSON.stringify(value, function (_key, entry) {

            if (typeof entry !== "object" || entry === null) return entry

            if (seen.has(entry)) return "[circular]"

            seen.add(entry)

            if (entry instanceof Error) return { name: entry.name, message: entry.message }

            return entry
        }))

        const text = JSON.stringify(capped)

        if (text.length <= 8_000) return capped

        return { truncated: true, preview: text.slice(0, 8_000) }
    }

    catch { return { unserializable: true } }
}
