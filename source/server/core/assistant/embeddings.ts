import { type AssistantConfigurationValues } from "./assistant"

/**
 * Embeddings come from the same OpenAI-compatible provider as the model:
 * POST {baseUrl}/embeddings { model, input: string[] } -> data[].embedding.
 * One instance serves one account-space.
 */
export default class Embedder {

    private readonly configuration: AssistantConfigurationValues

    private constructor(configuration: AssistantConfigurationValues) {

        this.configuration = configuration
    }

    public static open(configuration: AssistantConfigurationValues | null): Embedder | null {

        return configuration ? new Embedder(configuration) : null
    }

    /** Embeds the texts in one request; preserves input order. */
    public async embed(texts: string[]): Promise<Float32Array[]> {

        if (texts.length === 0) return []

        const response = await fetch(`${this.configuration.baseUrl}/embeddings`, {

            method: "POST",

            headers: {
                "content-type": "application/json",
                ...(this.configuration.apiKey ? { authorization: `Bearer ${this.configuration.apiKey}` } : {})
            },

            body: JSON.stringify({
                model: this.configuration.embedModel,
                input: texts
            }),

            signal: AbortSignal.timeout(120_000)
        })

        if (!response.ok) throw new Error(`The embedding endpoint answered ${response.status}`)

        const parsed = await response.json() as { data?: Array<{ embedding?: number[], index?: number }> }

        const data = parsed.data ?? []

        // The wire may or may not carry index; order by index when present.
        const ordered: Float32Array[] = new Array(texts.length)

        data.forEach((entry, position) => {

            const index = typeof entry.index === "number" ? entry.index : position

            ordered[index] = new Float32Array(entry.embedding ?? [])
        })

        if (ordered.some(vector => !vector || vector.length === 0)) throw new Error("The embedding endpoint returned a broken vector")

        return ordered
    }

    public embedOne(text: string): Promise<Float32Array> {

        return this.embed([text]).then(ordered => ordered[0]!)
    }
}
