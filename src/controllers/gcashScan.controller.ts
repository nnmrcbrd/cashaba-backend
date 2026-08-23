import { Request, Response } from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { parseGCashImageText } from "@/utils/gcashParser";
import { z } from "zod";

const imageInputSchema = z.object({
  base64: z.string().min(1).max(7_000_000).regex(/^[A-Za-z0-9+/]*={0,2}$/, "Invalid image data"),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]).default("image/png"),
});

const extractedTransactionSchema = z.object({
  amount: z.coerce.number().positive().finite(),
  description: z.string().trim().min(1).max(200),
  date: z.string().refine((value) => !Number.isNaN(new Date(value).getTime())),
  category: z.enum(["Food & Dining", "Transport", "Utilities", "Shopping", "Entertainment", "Health", "Others"]),
});

/**
 * POST /api/gcash/scan-image
 * Accepts a base64-encoded image, uses Gemini Vision to extract text,
 * parses the text for transaction details, and returns the parsed result.
 * The frontend confirms before logging.
 */
export const scanGCashImage = async (req: Request, res: Response) => {
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

    const genAI = new GoogleGenerativeAI(apiKey);
    // Use vision-capable model
    const model = genAI.getGenerativeModel({ model: "gemini-3.6-flash" });

    const prompt = `This is a GCash or bank payment screenshot. Extract the transaction details and output ONLY a JSON object:
{
  "amount": number,
  "description": "merchant or recipient name",
  "date": "YYYY-MM-DD",
  "category": "Food & Dining" | "Transport" | "Utilities" | "Shopping" | "Entertainment" | "Health" | "Others"
}
If you cannot extract the amount, return null.`;

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
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const parsed = extractedTransactionSchema.safeParse(JSON.parse(jsonMatch[0]));
      if (parsed.success) {
        return res.json({ parsed: parsed.data });
      }
    }

    // Fallback: try regex parsing on the vision text
    const fallback = parseGCashImageText(responseText);
    if (fallback) {
      return res.json({ parsed: { ...fallback, category: "Others" } });
    }

    return res.status(422).json({ message: "Could not extract transaction details from image" });
  } catch (error) {
    console.error("scanGCashImage error:", error);
    res.status(500).json({ message: "Error processing image" });
  }
};
