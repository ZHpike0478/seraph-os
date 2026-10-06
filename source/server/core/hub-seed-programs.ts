import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Lays out the fork's one built-in Program (identity "seraph") inside a
 * fresh account-space's programs directory, create-only-if-missing.
 *
 * Upstream seeds nothing: the CLI installs programs, and a space without
 * one simply opens empty. This fork's assistant is a Desktop-native
 * window behind a process of a Program, so every account needs the
 * Program present for `ProgramManager.initialize` to register it
 * installed at space-open — which is why it is laid out here, before
 * Application.initialize scans its programs path.
 *
 * Create-only-if-missing keeps a failure or an owner edit exactly where
 * it was: never rewritten, never deleted by a later opening.
 */
export default function seedPrograms(homePath: string): void {

    try {

        const target = join(homePath, "programs", "seraph")

        if (existsSync(join(target, "program.json"))) return

        mkdirSync(join(target, "client"), { recursive: true })

        // Two-space JSON: exactly what the runtime writes for a
        // hand-installed Program, because nothing distinguishes a
        // seeded file from a person's own.
        writeFileSync(join(target, "program.json"), `{
  "identity": "seraph",
  "name": "Seraph",
  "description": "The assistant built into this desktop.",
  "client": {
    "location": "./client",
    "title": "Seraph"
  }
}
`, "utf-8")

        writeFileSync(join(target, "client", "index.html"), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Seraph</title>
</head>
<body>
  <h1>Seraph</h1>
  <p>The assistant built into this desktop.</p>
</body>
</html>
`, "utf-8")

    }

    catch (exception) {

        console.log(`programs: seraph not seeded — ${exception instanceof Error ? exception.message : "unreadable"}`)
    }
}