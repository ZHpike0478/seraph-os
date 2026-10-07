/** One page's extracted text, numbered from one as the PDF numbers them. */
export type PdfPage = Readonly<{

    page: number

    text: string
}>

export type PdfExtraction = Readonly<{

    /** Pages with text worth indexing; image-only and drawn-only pages are absent. */
    pages: PdfPage[]

    /** How many pages the PDF actually has, capped or not. */
    totalPages: number
}>

/** Above this page count the rest is left unindexed; a real text PDF fits easily. */
export const MAX_PDF_PAGES = 500

/** Above this size (bytes) a PDF is left unindexed: it parses wholly in memory. */
export const MAX_PDF_BYTES = 16 * 1024 * 1024

/**
 * Extracts per-page text from one PDF's bytes. Only parsing decides
 * success here: a file without the PDF signature is a clean error, and
 * every parser failure (broken structure, password, truncation) surfaces
 * as one readable error the caller can report per file. Pages whose text
 * would be garbage are dropped later by the ingestion layer's own
 * binary check; this module only extracts.
 */
export async function extractPdfPages(bytes: Uint8Array): Promise<PdfExtraction> {

    if (!looksLikePdf(bytes)) throw new Error("not a PDF (no %PDF header)")

    // Loaded on first use: the parser bundle weighs a megabyte and only
    // PDF ingestion ever needs it.
    const { extractText: extract, getDocumentProxy: proxy } = await import("unpdf")

    try {

        const document_ = await proxy(bytes)

        // mergePages: false means one string per page, page N at index N - 1:
        // the page boundary is the lineage a citation needs.
        const extraction = await extract(document_, { mergePages: false })

        const strings = extraction.text as string[]

        const taken = Math.min(strings.length, MAX_PDF_PAGES)

        const pages: PdfPage[] = []

        for (let index = 0; index < taken; index++) {

            const text = strings[index] ?? ""

            if (text.trim().length > 0) pages.push({ page: index + 1, text })
        }

        return { pages, totalPages: extraction.totalPages }
    }

    catch (exception) {

        const message = exception instanceof Error ? exception.message : String(exception)

        throw new Error(`PDF extraction failed: ${message}`)
    }
}

/** The signature every PDF carries; real-world junk before it is tolerated. */
export function looksLikePdf(bytes: Uint8Array): boolean {

    const window = bytes.subarray(0, Math.min(bytes.length, 1024))

    let head = ""

    for (const byte of window) head += String.fromCharCode(byte)

    return head.startsWith("%PDF-")
}