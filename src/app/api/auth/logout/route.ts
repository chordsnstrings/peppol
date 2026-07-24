import { clearSession } from "@/lib/server/session";
import { json } from "@/lib/server/http";

export const runtime = "nodejs";

export async function POST() {
  await clearSession();
  return json({ ok: true });
}
