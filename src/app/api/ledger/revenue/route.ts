import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import {
  createContract, modifyContract, recordBilling, satisfyObligation, setProgress,
  cancelContract, runRecognition, runRecognitionAll, contractRegister, contractDetail,
  type NewContract,
} from "@/lib/server/ledger/revenue";

export const runtime = "nodejs";

/**
 * The contract register with the ledger balances it should agree with, or one
 * contract in full when a code is given.
 */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const params = new URL(req.url).searchParams;
    const entityId = params.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);

    const code = params.get("code");
    if (code) return json(ledgerJson(await contractDetail({ orgId, entityId, code })));
    return json(ledgerJson(await contractRegister({ orgId, entityId })));
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/** Record a contract, what has been billed or delivered, and post the result. */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "create" | "modify" | "bill" | "satisfy" | "progress" | "cancel" | "run" | "runAll";
      entityId?: string;
      contract?: NewContract;
      code?: string;
      seq?: number;
      on?: string;
      progressBps?: number;
      amountMinor?: string;
      priceMinor?: string;
      standalone?: Record<number, string>;
    };
    if (!b.entityId) return json({ error: "entityId required" }, 400);
    const scope = { orgId, entityId: b.entityId };

    switch (b.action) {
      case "create":
        if (!b.contract?.code || !b.contract?.customerName) {
          return json({ error: "A contract needs a code and the customer it is with." }, 400);
        }
        return json(ledgerJson({ contract: await createContract({ ...scope, contract: b.contract }) }));

      case "modify":
        if (!b.code) return json({ error: "Which contract?" }, 400);
        return json(ledgerJson({
          contract: await modifyContract({ ...scope, code: b.code, priceMinor: b.priceMinor, standalone: b.standalone }),
        }));

      case "bill":
        if (!b.code || b.amountMinor === undefined) {
          return json({ error: "Billing needs the contract and the amount charged, net of tax." }, 400);
        }
        return json(ledgerJson({ contract: await recordBilling({ ...scope, code: b.code, amountMinor: b.amountMinor }) }));

      case "satisfy":
        if (!b.code || !b.seq || !b.on) {
          return json({ error: "Satisfying an obligation needs the contract, which obligation, and the day." }, 400);
        }
        return json(ledgerJson({ contract: await satisfyObligation({ ...scope, code: b.code, seq: b.seq, on: b.on }) }));

      case "progress":
        if (!b.code || !b.seq || b.progressBps === undefined) {
          return json({ error: "Progress needs the contract, which obligation, and how far along it is." }, 400);
        }
        return json(ledgerJson({
          contract: await setProgress({ ...scope, code: b.code, seq: b.seq, progressBps: b.progressBps }),
        }));

      case "cancel":
        if (!b.code) return json({ error: "Which contract?" }, 400);
        return json(ledgerJson({ contract: await cancelContract({ ...scope, code: b.code }) }));

      case "run":
        if (!b.code || !b.on) return json({ error: "A run needs the contract and the date to recognise as at." }, 400);
        return json(ledgerJson(await runRecognition({ ...scope, code: b.code, on: b.on })));

      case "runAll":
        if (!b.on) return json({ error: "A run needs the date to recognise as at." }, 400);
        return json(ledgerJson(await runRecognitionAll({ ...scope, on: b.on })));

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
