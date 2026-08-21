import { Readable } from "stream";
import csv from "csv-parser";

export interface GCashRow {
    amount: number;
    description: string;
    date: string;
}

export const parseGCashCSV = (
    buffer: Buffer
): Promise<GCashRow[]> => {
    return new Promise((resolve, reject) => {
        const rows: GCashRow[] = [];

        Readable.from(buffer)
            .pipe(csv())
            .on("data", (row) => {
                const amountValue =
                    row.amount ??
                    row.Amount ??
                    row.transaction_amount ??
                    row["Transaction Amount"] ??
                    "0";

                const description =
                    row.description ??
                    row.Description ??
                    row.details ??
                    row.Details ??
                    "";

                const date =
                    row.date ??
                    row.Date ??
                    row["Transaction Date"] ??
                    "";

                rows.push({
                    amount: Number(
                        String(amountValue).replace(/,/g, "")
                    ),
                    description: String(description),
                    date: String(date),
                });
            })
            .on("end", () => resolve(rows))
            .on("error", reject);
    });
};

/** Bank imports currently share the normalized CSV shape used by GCash exports. */
export const parseBankCSV = (
    buffer: Buffer,
    _bankType: string = "generic"
): Promise<GCashRow[]> => parseGCashCSV(buffer);

/**
 * parseGCashImageText
 * Parses OCR-extracted text from a GCash screenshot to extract amount, description, and date.
 * Called after Gemini Vision API extracts the text content from the image.
 */
export function parseGCashImageText(ocrText: string): GCashRow | null {
    try {
        // Extract amount — match "₱1,234.56" or "PHP 1,234.56" or plain "1234.56"
        const amountMatch = ocrText.match(/(?:₱|PHP\s*)([\d,]+(?:\.\d{1,2})?)/i);
        if (!amountMatch) return null;
        const amount = parseFloat(amountMatch[1].replace(/,/g, ""));

        // Extract description — look for "to", "from", "at", merchant name patterns
        const descriptionMatch =
            ocrText.match(/(?:sent to|paid to|received from|at|merchant:?)\s*([A-Za-z0-9\s&.'-]{2,40})/i) ||
            ocrText.match(/([A-Z][A-Za-z0-9\s&.'-]{2,30})\s*(?:₱|PHP)/i);
        const description = descriptionMatch
            ? descriptionMatch[1].trim()
            : "GCash Transaction";

        // Extract date — match common date formats
        const dateMatch = ocrText.match(
            /(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\w+ \d{1,2},?\s*\d{4}|\d{4}-\d{2}-\d{2})/i
        );
        const date = dateMatch
            ? new Date(dateMatch[1]).toISOString().split("T")[0]
            : new Date().toISOString().split("T")[0];

        return { amount, description, date };
    } catch {
        return null;
    }
}
