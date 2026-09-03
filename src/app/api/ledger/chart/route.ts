import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  addAccount, updateAccount, renumberAccount, archiveAccount, restoreAccount,
  deleteAccount, chartWithUsage, type NewAccount, type AccountChange,
} from "@/lib/server/ledger/chart";

export const runtime = "nodejs";

/** The chart, with what each account carries and what it will therefore allow. */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const entityId = new URL(req.url).searchParams.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    return json({ accounts: await chartWithUsage({ orgId, entityId }) });
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "add" | "update" | "renumber" | "archive" | "restore" | "delete";
      entityId?: string;
      code?: string;
      toCode?: string;
      account?: NewAccount;
      change?: AccountChange;
    };
    if (!b.entityId) return json({ error: "entityId required" }, 400);
    const scope = { orgId, entityId: b.entityId };

    switch (b.action) {
      case "add":
        if (!b.account) return json({ error: "There is no account to add." }, 400);
        return json({ account: await addAccount({ ...scope, account: b.account }) });

      case "update":
        if (!b.code || !b.change) return json({ error: "Which account, and what change?" }, 400);
        return json({ account: await updateAccount({ ...scope, code: b.code, change: b.change }) });

      case "renumber":
        if (!b.code || !b.toCode) return json({ error: "A renumber needs the old code and the new one." }, 400);
        return json(await renumberAccount({ ...scope, from: b.code, to: b.toCode }));

      case "archive":
        if (!b.code) return json({ error: "Which account?" }, 400);
        return json({ account: await archiveAccount({ ...scope, code: b.code }) });

      case "restore":
        if (!b.code) return json({ error: "Which account?" }, 400);
        return json({ account: await restoreAccount({ ...scope, code: b.code }) });

      case "delete":
        if (!b.code) return json({ error: "Which account?" }, 400);
        return json(await deleteAccount({ ...scope, code: b.code }));

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
