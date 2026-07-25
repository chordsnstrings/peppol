import { prisma } from "./prisma";
import { sha256Hex } from "./crypto";

/**
 * Replay protection for inbound webhooks. Returns true the FIRST time a given
 * (source, rawBody) is seen and false on any replay — atomic via the unique PK,
 * so concurrent duplicates can't both win. Call only after signature
 * verification, so a forged body can't pollute the ledger.
 */
export async function isFirstDelivery(source: string, rawBody: string): Promise<boolean> {
  const id = sha256Hex(`${source}\n${rawBody}`);
  try {
    await prisma.processedWebhook.create({ data: { id, source } });
    return true;
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return false; // already processed
    throw e;
  }
}
