// ── parse_receipt (Nebius vision) ──────────────────────────────────────────────
//
// Reliability insurance: browser/voice can fail live, a receipt photo updating
// the balance won't. Send the image to the vision VLM, demand strict JSON, and
// hand the parsed total back to the dispatcher to log against the ledger.

import { nebius, MODELS } from "./llm.js";
import { log } from "./log.js";
import { uploadReceiptImage } from "./db.js";

export interface ReceiptLineItem {
  name: string;
  price: number;
}

export interface ParsedReceipt {
  merchant: string;
  total: number;
  date?: string;
  lineItems: ReceiptLineItem[];
  /** Stored image URL when InsForge storage is configured; absent otherwise. */
  imageUrl?: string;
}

function stripCodeFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

/** Normalize a data: URL or bare base64 into a data URL the API accepts. */
function toDataUrl(imageBase64: string): string {
  return imageBase64.startsWith("data:")
    ? imageBase64
    : `data:image/jpeg;base64,${imageBase64}`;
}

export async function parseReceipt(imageBase64: string): Promise<ParsedReceipt | null> {
  try {
    const res = await nebius.chat.completions.create({
      model: MODELS.vision,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You read receipt photos and return strict JSON only. No markdown, no commentary.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                'Extract this receipt as JSON: {"merchant": string, "total": number, "date": string (ISO if visible else ""), "lineItems": [{"name": string, "price": number}]}. total is the final amount paid including tax/tip.',
            },
            { type: "image_url", image_url: { url: toDataUrl(imageBase64) } },
          ],
        },
      ],
    });

    const raw = res.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(stripCodeFences(raw)) as ParsedReceipt;

    if (typeof parsed.total !== "number" || parsed.total <= 0) {
      log("vision.receipt_no_total", { raw: raw.slice(0, 120) });
      return null;
    }
    parsed.merchant = parsed.merchant || "unknown merchant";
    parsed.lineItems = Array.isArray(parsed.lineItems) ? parsed.lineItems : [];

    // Persist the receipt image to InsForge storage (no-op when unconfigured) so
    // the ledger entry can link back to proof of purchase.
    const imageUrl = await uploadReceiptImage(imageBase64);
    if (imageUrl) parsed.imageUrl = imageUrl;

    log("vision.receipt_parsed", { merchant: parsed.merchant, total: parsed.total, stored: !!imageUrl });
    return parsed;
  } catch (err) {
    log("vision.receipt_failed", { error: String(err) });
    return null;
  }
}
