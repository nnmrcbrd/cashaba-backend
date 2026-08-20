import { Request, Response } from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { prisma } from "@/lib/prisma";
import { parseBankCSV } from "@/utils/gcashParser";
import { recalculateSafeToSpend } from "@/utils/safeToSpend";
import { detectCategory } from "@/utils/detectCategory";

/**
 * POST /api/transactions/import-csv
 * Accepts a base64-encoded CSV, parses it with bank-specific parser,
 * AI-categorizes each row, and bulk-inserts transactions.
 */
export const importBankCSV = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id || req.user!.userId;
    const { csvBase64, bankType } = req.body;

    if (!csvBase64) {
      return res.status(400).json({ message: "csvBase64 required" });
    }

    const buffer = Buffer.from(csvBase64, "base64");
    const rows = await parseBankCSV(buffer, bankType || "generic");

    if (rows.length === 0) {
      return res.status(422).json({ message: "No valid rows found in CSV" });
    }

    // Categorize using existing detectCategory utility or simple heuristic
    const categorized = rows.map((row) => {
      let category = "Others";
      const desc = (row.description || "").toLowerCase();

      if (/food|jollibee|mcdo|kfc|restaurant|grocery|super|market|save more/i.test(desc)) category = "Food & Dining";
      else if (/grab|angkas|bus|lrt|mrt|taxi|transport|fuel|gas/i.test(desc)) category = "Transport";
      else if (/meralco|maynilad|converge|pldt|globe|smart|electric|water|internet|bill/i.test(desc)) category = "Utilities";
      else if (/lazada|shopee|sm|robinson|ayala|mall|shop/i.test(desc)) category = "Shopping";
      else if (/netflix|spotify|cinema|movie|game|steam/i.test(desc)) category = "Entertainment";
      else if (/clinic|hospital|pharma|medicine|doctor|health/i.test(desc)) category = "Health";

      return {
        userId,
        description: row.description || "Imported Transaction",
        type: "EXPENSE" as const,
        category,
        amount: row.amount,
        date: row.date ? new Date(row.date) : new Date(),
      };
    });

    // Bulk insert (skip duplicates by catching errors per row)
    let imported = 0;
    let skipped = 0;

    for (const row of categorized) {
      try {
        await prisma.transaction.create({ data: row });
        imported++;
      } catch {
        skipped++;
      }
    }

    // Recalculate safe-to-spend after import
    const safeToSpend = await recalculateSafeToSpend(userId);

    res.status(201).json({
      message: `Import complete. ${imported} transactions imported, ${skipped} skipped.`,
      imported,
      skipped,
      safeToSpend,
    });
  } catch (error) {
    console.error("importBankCSV error:", error);
    res.status(500).json({ message: "Error importing CSV" });
  }
};
