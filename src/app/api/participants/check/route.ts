import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { getGateway } from "@/lib/gateway/registry";
import { derivePeppolId } from "@/lib/domain/peppol";

export const runtime = "nodejs";

/** Check whether a counterparty is reachable on the Peppol network (SMP lookup). */
export async function POST(req: Request) {
  try {
    await requireSession();
    const { peppolId, trn } = (await req.json()) as { peppolId?: string; trn?: string };
    const id = peppolId || derivePeppolId(trn);
    if (!id) {
      return json({ onNetwork: false, participantId: null, reason: "no-id", checkedAt: new Date().toISOString() });
    }
    const cap = await getGateway().lookupParticipant(id);
    return json({ onNetwork: cap.onNetwork, participantId: cap.participantId, checkedAt: cap.checkedAt });
  } catch (e) {
    return handleError(e);
  }
}
