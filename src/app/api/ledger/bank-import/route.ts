import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import {
  parseStatement, detectFormat, BankFormatError,
  type StatementFormat, type DateOrder, type CsvRole,
} from "@/lib/server/ledger/bank-formats";

export const runtime = "nodejs";

const FORMATS: StatementFormat[] = ["MT940", "CAMT053", "OFX", "CSV"];
const ORDERS: DateOrder[] = ["DMY", "MDY", "YMD"];

/**
 * Read a statement file. This route parses and nothing else.
 *
 * Importing is left to /api/ledger/bank, which already knows how to do it and
 * how to skip what is already on file. Keeping the two apart is what lets
 * somebody look at the footing proof before a single row is written down —
 * which is the entire reason this exists rather than a one-click upload.
 */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    await requireSession();

    const b = (await req.json().catch(() => ({}))) as {
      text?: unknown;
      format?: unknown;
      dateOrder?: unknown;
      columns?: unknown;
      currency?: unknown;
    };

    if (typeof b.text !== "string" || b.text.trim() === "") {
      return json({ error: "There is nothing to read — paste or upload a statement first." }, 400);
    }
    if (b.format !== undefined && !FORMATS.includes(b.format as StatementFormat)) {
      return json({ error: `Unknown format. This reads ${FORMATS.join(", ")}.` }, 400);
    }
    if (b.dateOrder !== undefined && !ORDERS.includes(b.dateOrder as DateOrder)) {
      return json({ error: "A date order must be DMY, MDY or YMD." }, 400);
    }

    // Column overrides arrive from the confirmation the sniffer asked for, so
    // they are the user's answer and not a guess — but they still have to be
    // column numbers, since they end up indexing rows.
    let columns: Partial<Record<CsvRole, number>> | undefined;
    if (b.columns && typeof b.columns === "object") {
      columns = {};
      for (const [role, index] of Object.entries(b.columns as Record<string, unknown>)) {
        if (index === null || index === undefined || index === "") continue;
        const n = Number(index);
        if (!Number.isInteger(n) || n < 0 || n > 512) {
          return json({ error: `The column chosen for ${role} is not a column number.` }, 400);
        }
        columns[role as CsvRole] = n;
      }
      if (Object.keys(columns).length === 0) columns = undefined;
    }

    const detected = detectFormat(b.text);
    const statement = parseStatement({
      text: b.text,
      format: b.format as StatementFormat | undefined,
      dateOrder: b.dateOrder as DateOrder | undefined,
      columns,
      currency: typeof b.currency === "string" && b.currency ? b.currency : undefined,
    });

    return json(ledgerJson({ detected, statement }));
  } catch (e) {
    // A file this cannot vouch for is a rejected submission, not a fault, and
    // the detail is what lets the page offer the fix instead of a dead end.
    if (e instanceof BankFormatError) return json({ error: e.message, detail: e.detail }, 422);
    return handleError(e);
  }
}
