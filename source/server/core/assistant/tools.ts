import Application from "../application"
import type { AssistantTool } from "./assistant"

/**
 * The tools Seraph may use as one signed-in user, inside that user's own
 * account-space: its programs, its System storage, its desktop settings, and
 * its memory. Nothing here can name another space.
 */
export default function assistantTools(application: Application): AssistantTool[] {

    const storage = application.home

    return [

        {
            name: "files_list",
            description: "List the user's system files in one directory. Pass an empty list for the root.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "array",
                        items: { type: "string" },
                        description: "Directory path as a list of names, newest last"
                    }
                },
                required: []
            },
            async execute({ path }: { path?: string[] }) {

                const entries = storage.list(path ?? [])

                return entries.map(entry => ({ path: [...entry.path], kind: entry.kind }))
            }
        },

        {
            name: "files_read",
            description: "Read one text file from the user's system storage.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "array",
                        items: { type: "string" },
                        description: "File path as a list of names"
                    }
                },
                required: ["path"]
            },
            async execute({ path }: { path: string[] }) {

                const chunks: Uint8Array[] = []

                const body = storage.stream(path ?? [])

                const reader = body.getReader()

                let size = 0

                while (true) {

                    const { done, value } = await reader.read()

                    if (done) break

                    size += value.byteLength

                    if (size > 256 * 1024) {

                        await reader.cancel()

                        return { content: chunksToText(chunks), truncated: true }
                    }

                    chunks.push(value)
                }

                return { content: chunksToText(chunks), truncated: false }
            }
        },

        {
            name: "files_write",
            description: "Write one text file into the user's system storage, replacing it when it exists.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "array",
                        items: { type: "string" },
                        description: "File path as a list of names"
                    },
                    content: { type: "string", description: "The complete file content" }
                },
                required: ["path", "content"]
            },
            async execute({ path, content }: { path: string[], content: string }) {

                const target = [...path ?? []]

                const joined = target.join("/")

                const bytes = new TextEncoder().encode(content).byteLength

                const confirmed = await application.authManager.assistantConfirmManager.request("files_write", `Write ${joined} (${bytes} bytes)`)

                if (!confirmed) return { error: "The user did not confirm this write" }

                await storage.write(target, new Blob([content]).stream())

                return { written: joined, bytes }
            }
        },

        {
            name: "programs_list",
            description: "List the programs installed in the user's desktop.",
            parameters: { type: "object", properties: {}, required: [] },
            async execute() {

                return [...application.programManager.programs.values()].map(entry => ({

                    identity: entry.program.identity,

                    name: entry.program.name
                }))
            }
        },

        {
            name: "desktop_set_theme",
            description: "Set the desktop theme for this user: light or dark.",
            parameters: {
                type: "object",
                properties: {
                    theme: { type: "string", enum: ["light", "dark"], description: "The theme to apply" }
                },
                required: ["theme"]
            },
            async execute({ theme }: { theme: string }) {

                if (theme !== "light" && theme !== "dark") return { error: "The theme is light or dark" }

                const confirmed = await application.authManager.assistantConfirmManager.request("desktop_set_theme", `Set desktop theme to ${theme}`)

                if (!confirmed) return { error: "The user did not confirm this write" }

                // The desktop's look-and-feel preference is the user's own
                // Desktop choice; a theme ask applies there, on the asking
                // connection, once allowed.
                await application.authManager.assistantConfirmManager.pushDesktopPreference({ theme })

                return { theme }
            }
        },

        {
            name: "memory_remember",
            description: "Save one fact to remember about the user across conversations.",
            parameters: {
                type: "object",
                properties: {
                    fact: { type: "string", description: "The fact, one sentence, self-contained" }
                },
                required: ["fact"]
            },
            async execute({ fact }: { fact: string }) {

                const identity = application.assistantMemory.remember(String(fact))

                return { remembered: identity }
            }
        },

        {
            name: "memory_recall",
            description: "Recall saved facts about the user by keyword.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Keywords to recall with" }
                },
                required: ["query"]
            },
            async execute({ query }: { query: string }) {

                const facts = application.assistantMemory.recall(String(query))

                return { facts }
            }
        }
    ]
}

function chunksToText(chunks: Uint8Array[]) {

    return chunks.map(chunk => new TextDecoder().decode(chunk)).join("")
}