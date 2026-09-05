import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import {
  adjustmentDue,
  assessInterval,
  capitalAssetRegister,
  designatedZoneMatrix,
  disposeCapitalAsset,
  intervalAdjustment,
  marginSchemeSupply,
  registerCapitalAsset,
  type CapitalAssetCategory,
} from "@/lib/server/ledger/vat-schemes";

export const runtime = "nodejs";

/**
 * The capital assets scheme, the profit margin scheme and designated zones.
 *
 * Every handler passes the session's org through to the module alongside the
 * entity the request names. The entity id comes from the client and is never
 * trusted on its own — it is only ever a filter applied inside the caller's
 * org, so a guessed id reads nothing.
 *
 * The margin calculation is a GET rather than a POST: it computes a figure and
 * changes nothing, and the alternative — the client owning the arithmetic —
 * would put a second copy of the VAT rate in the browser.
 */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const params = new URL(req.url).searchParams;
    const entityId = params.get("entityId");
    if (!entityId) return json({ error: "entityId is required." }, 400);
    /* The register, the due list and the margin arithmetic are reports and
     * previews; nothing here writes. Reading the reports is `ledger.read`.
     * The adjustment preview shows what an assessment WOULD post, which is
     * still a read — the posting itself is the POST below, and that is where
     * the tax key belongs. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });

    if (params.get("view") === "margin") {
      const purchase = params.get("purchaseMinor");
      const sale = params.get("saleMinor");
      if (purchase === null || sale === null) {
        return json({ error: "A margin needs both the purchase price and the selling price." }, 400);
      }
      return json(ledgerJson({ margin: marginSchemeSupply({ purchaseMinor: purchase, saleMinor: sale }) }));
    }

    const asOf = params.get("asOf") ?? undefined;

    // What an assessment would post, before anybody posts it. It goes through
    // the module's own `intervalAdjustment` rather than being worked out again
    // for the screen: the figure shown before posting has to be the figure that
    // posts, and one formula in two places is two formulas eventually.
    if (params.get("view") === "adjustment") {
      const code = params.get("code");
      const interval = Number(params.get("interval"));
      const useBps = Number(params.get("useBps"));
      if (!code || !Number.isInteger(interval) || !Number.isInteger(useBps)) {
        return json({ error: "A preview needs the asset, the interval and the taxable use in basis points." }, 400);
      }
      const register = await capitalAssetRegister({ orgId, entityId, asOf });
      const asset = register.assets.find((a) => a.code === code);
      if (!asset) return json({ error: `Capital asset ${code} is not on the register for this entity.` }, 404);
      const row = asset.intervalRows.find((r) => r.interval === interval);
      if (!row) return json({ error: `${code} has ${asset.intervals} intervals, so there is no interval ${interval}.` }, 422);

      return json(
        ledgerJson({
          preview: {
            code: asset.code,
            interval,
            from: row.from,
            to: row.to,
            useBps,
            originalUseBps: asset.originalUseBps,
            changeBps: useBps - asset.originalUseBps,
            perIntervalMinor: asset.perIntervalMinor,
            adjustmentMinor: intervalAdjustment({
              inputTaxMinor: BigInt(asset.inputTaxMinor),
              intervals: asset.intervals,
              originalUseBps: asset.originalUseBps,
              useBps,
            }),
            alreadyAssessed: row.state === "assessed",
          },
        }),
      );
    }

    // The register and the due list are read together because they describe the
    // same intervals. Two round trips is two chances to read them a moment
    // apart and show a screen that contradicts itself.
    const [register, due] = await Promise.all([
      capitalAssetRegister({ orgId, entityId, asOf }),
      adjustmentDue({ orgId, entityId, asOf }),
    ]);

    return json(ledgerJson({ register, due, zones: designatedZoneMatrix() }));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/** Register a capital asset, assess one of its intervals, or dispose of it. */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "register" | "assess" | "dispose";
      entityId?: string;
      code?: string;
      description?: string;
      category?: CapitalAssetCategory;
      acquiredOn?: string;
      firstUsedOn?: string;
      costMinor?: string;
      inputTaxMinor?: string;
      originalUseBps?: number;
      interval?: number;
      useBps?: number;
      on?: string;
      supplyIsTaxable?: boolean;
      expenseAccount?: string;
    };
    if (!b.entityId) return json({ error: "entityId is required." }, 400);
    /* The capital assets scheme is VAT work, so `tax.file`.
     *
     * "Capital asset" here is not the fixed asset register. This register
     * carries input tax and the taxable-use proportion it was claimed at, and
     * every figure it produces lands in the adjustment column of a VAT 201
     * box: registering an asset fixes the intervals a later return adjusts
     * over, and assessing or disposing of one posts the adjustment itself.
     * `asset.manage` is the wrong shelf — its holder maintains what the
     * accounts say a thing is worth, which nothing here touches. All three
     * actions are the one duty, so the guard is one. */
    await requirePermission({ orgId, userId, entityId: b.entityId, permission: "tax.file" });

    switch (b.action) {
      case "register": {
        if (!b.code || !b.description || !b.acquiredOn || !b.firstUsedOn) {
          return json(
            { error: "A capital asset needs a code, a description, the date it was acquired and the date it was first used." },
            400,
          );
        }
        if (b.costMinor === undefined || b.inputTaxMinor === undefined || b.originalUseBps === undefined) {
          return json(
            { error: "A capital asset needs its cost, the input tax on it, and the taxable-use proportion claimed at the outset." },
            400,
          );
        }
        return json(
          ledgerJson(
            await registerCapitalAsset({
              orgId,
              entityId: b.entityId,
              asset: {
                code: b.code,
                description: b.description,
                category: b.category === "BUILDING" ? "BUILDING" : "OTHER",
                acquiredOn: b.acquiredOn,
                firstUsedOn: b.firstUsedOn,
                costMinor: b.costMinor,
                inputTaxMinor: b.inputTaxMinor,
                originalUseBps: b.originalUseBps,
              },
            }),
          ),
        );
      }

      case "assess": {
        if (!b.code || b.interval === undefined || b.useBps === undefined || !b.on) {
          return json(
            { error: "An assessment needs the asset, the interval, the taxable use over it, and the date to post on." },
            400,
          );
        }
        return json(
          ledgerJson(
            await assessInterval({
              orgId,
              entityId: b.entityId,
              code: b.code,
              interval: b.interval,
              useBps: b.useBps,
              on: b.on,
              expenseAccount: b.expenseAccount,
              actorId: userId,
            }),
          ),
        );
      }

      case "dispose": {
        if (!b.code || !b.on) return json({ error: "A disposal needs the asset and the date." }, 400);
        return json(
          ledgerJson(
            await disposeCapitalAsset({
              orgId,
              entityId: b.entityId,
              code: b.code,
              on: b.on,
              // Absent, the disposal is taken as a taxable supply — the case
              // Executive Regulation Article 58(12) deems wholly taxable use
              // for. An exempt disposal has to say so, because the answer is
              // the whole of the remaining input tax.
              supplyIsTaxable: b.supplyIsTaxable !== false,
              expenseAccount: b.expenseAccount,
              actorId: userId,
            }),
          ),
        );
      }

      default:
        return json(
          {
            error:
              'Unknown action. Use "register" to put a capital asset on the register, "assess" to adjust one of its ' +
              'intervals, or "dispose" to make the final adjustment.',
          },
          400,
        );
    }
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
