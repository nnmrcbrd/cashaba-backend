import { Request, Response } from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { parseGCashImageText } from "@/utils/gcashParser";

/**
 * POST /api/gcash/scan-image
 * Accepts a base64-encoded image, uses Gemini Vision to extract text,
 * parses the text for transaction details, and returns the parsed result.
 * The frontend confirms before logging.
 */
export const scanGCashImage = async (req: Request, res: Response) => {
  try {
    const { base64, mimeType } = req.body;

    if (!base64) {
      return res.status(400).json({ message: "base64 image data required" });
    }

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
          mimeType: mimeType || "image/png",
        },
      },
    ]);

    const responseText = result.response.text().trim();
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed && parsed.amount > 0) {
        return res.json({ parsed });
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
