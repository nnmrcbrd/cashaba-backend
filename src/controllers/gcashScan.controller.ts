import { Request, Response } from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { parseGCashImageText } from "@/utils/gcashParser";
import { parseReceiptModelResponse } from "@/utils/receiptScan";
import { z } from "zod";
import { consumeUsage, refundUsage, UsageLimitError } from '@/services/subscription';

const imageInputSchema = z.object({
  base64: z.string().min(1).max(7_000_000).regex(/^[A-Za-z0-9+/]*={0,2}$/, "Invalid image data"),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]).default("image/png"),
});

/**
 * POST /api/gcash/scan-image
 * Accepts a temporary base64 image of a receipt or payment confirmation,
 * extracts transaction details, and returns a suggestion for user review.
 * The image is not persisted by this application.
 */
export const scanGCashImage = async (req: Request, res: Response) => {
  let usagePeriodId: string | null = null;
  try {
    const input = imageInputSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ message: "A valid PNG, JPEG, or WebP image is required" });
    }
    const { base64, mimeType } = input.data;

    const apiKey = process.env.GEMINI_API_KEY || "";

    if (!apiKey || apiKey === "dummy_gemini_api_key_here") {
      return res.status(400).json({ message: "Gemini API key not configured for image scanning" });
    }
    usagePeriodId = (await consumeUsage(req.user!.userId, 'receiptScans')).id;

    const genAI = new GoogleGenerativeAI(apiKey);
    // Use vision-capable model
    const model = genAI.getGenerativeModel({ model: "gemini-3.6-flash" });

    const prompt = `This image may be a store receipt, invoice, GCash screenshot, bank transfer confirmation, or other payment record.
Extract one transaction and output ONLY a JSON object:
{
  "amount": number,
  "description": "merchant, recipient, or income source",
  "date": "YYYY-MM-DD",
  "category": "Food & Dining" | "Transport" | "Utilities" | "Housing" | "Health" | "Entertainment" | "Education" | "Shopping" | "Savings" | "Debt Payment" | "Others" | "Salary" | "Freelance" | "Business" | "Gift" | "Other",
  "transactionType": "EXPENSE" | "INCOME"
}
Use EXPENSE for purchases and outgoing payments. Use INCOME only when the image clearly shows money received, a deposit, salary, or a refund.
Never invent missing amounts. If the amount cannot be read, return null.`;

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: base64,
          mimeType,
        },
      },
    ]);

    const responseText = result.response.text().trim();
    const parsed = parseReceiptModelResponse(responseText);
    if (parsed) return res.json({ parsed });

    // Fallback: try regex parsing on the vision text
    const fallback = parseGCashImageText(responseText);
    if (fallback) {
      return res.json({ parsed: { ...fallback, category: "Others", transactionType: "EXPENSE" } });
    }

    await refundUsage(req.user!.userId, 'receiptScans', usagePeriodId);
    usagePeriodId = null;
    return res.status(422).json({ message: "Could not extract transaction details from image" });
  } catch (error) {
    if (usagePeriodId) {
      try { await refundUsage(req.user!.userId, 'receiptScans', usagePeriodId); }
      catch (refundError) { console.error('Could not restore failed scan quota:', refundError); }
    }
    if (error instanceof UsageLimitError) return res.status(error.status).json({ message: error.message, code: 'USAGE_LIMIT_REACHED', metric: error.metric, limit: error.limit });
    console.error("scanGCashImage error:", error);
    res.status(500).json({ message: "Error processing image" });
  }
};
