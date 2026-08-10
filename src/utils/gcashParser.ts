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