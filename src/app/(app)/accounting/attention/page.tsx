import Link from "next/link";
import { prisma } from "@/lib/server/prisma";
import { getSession } from "@/lib/server/session";
import { listRecords } from "@/lib/server/store";
import { LedgerError } from "@/lib/server/ledger/post";
import { attentionList, type AttentionList, type Finding, type Severity } from "@/lib/server/ledger/attention";
import { Figure, PageHead, Panel, ErrorNote, Empty } from "@/components/ledger/primitives";

/**
 * Needs attention: one screen for everything waiting on somebody.
 *
 * The list is derived on every request rather than stored, so a row here is
 * always a live fact about the books — which is what makes it worth reading a
 * second time. Nothing on this page can be dismissed, because a nag you can
 * dismiss is a nag that outlives its cause.
 *
 * Rendered on the server and filtered through the URL, like Insights, so a row
 * can be sent to somebody: "look at this as at the 3rd" only means something if
 * the link reproduces what was on screen.
 *
 * Density is deliberate. This is a working list, not a summary — the count, the
 * amount, the sentence that says what to do and the link that goes there all
 * belong on one row, because the alternative is a beautiful screen that has to
 * be clicked through to be used.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface EntityRecord {
  id: string;
  legalNameEn?: string;
}

type Search = Record<string, string | string[] | undefined>;
const one = (s: Search, k: string) => {
  const v = s[k];
  return ((Array.isArray(v) ? v[0] : v) ?? "").trim();
};

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Severity is carried three ways at once: the group it sits under, the word in
 * the chip, and the chip's border colour. Colour is never alone — roughly one
 * man in twelve cannot use it — and here it is the last of the three rather
 * than the first. Falu red on a chip is the status meaning of `--sw-neg`, which
 * is the use the stylesheet allows on chrome; the amounts beside it keep the
 * value meaning, parentheses and all.
 */
const GROUPS: { severity: Severity; heading: string; chip: string; blurb: string }[] = [
  {
    severity: "urgent",
    heading: "Urgent",
    chip: "sw-chip sw-chip-bad",
    blurb: "A deadline has passed, or the books say something that should not be possible.",
  },
  {
    severity: "soon",
    heading: "Soon",
    chip: "sw-chip sw-chip-warn",
    blurb: "Nothing is wrong yet. It will be if this week goes by.",
  },
  {
    severity: "note",
    heading: "Worth a look",
    chip: "sw-chip",
    blurb: "Work somebody started and has not finished. None of it is late.",
  },
];

/** Where each row goes, named so the link says its destination rather than "here". */
const DESTINATION: Record<string, string> = {
  "/accounting/trial-balance": "Trial balance",
  "/accounting/vat": "VAT return",
  "/accounting/receivables": "Receivables",
  "/accounting/payables": "Payables",
  "/accounting/periods": "Periods",
  "/accounting/recurring": "Recurring",
  "/accounting/assets": "Fixed assets",
  "/accounting/bank": "Bank",
  "/accounting/procurement": "Purchase orders",
  "/accounting/expenses": "Expense claims",
};
const destinationOf = (href: string) => DESTINATION[href] ?? "Open";

function Row({ f, currency, chip }: { f: Finding; currency: string; chip: string }) {
  return (
    <tr data-testid={`attention-${f.key}`}>
      <th scope="row" style={{ fontWeight: 400, verticalAlign: "top" }} className="py-2">
        <div className="flex items-baseline gap-2">
          <span className={chip} data-testid={`attention-${f.key}-severity`}>
            {f.severity}
          </span>
          <span className="font-semibold">{f.title}</span>
        </div>
        <p className="sw-sub mt-1 max-w-[78ch]">{f.detail}</p>
      </th>
      <td className="sw-num" style={{ verticalAlign: "top", width: "4.5rem" }}>
        <span className="py-2 inline-block">{f.count ?? <span className="sw-zero">–</span>}</span>
      </td>
      <td className="sw-num" style={{ verticalAlign: "top", width: "var(--sw-col-amount)" }}>
        <span className="py-2 inline-block" data-testid={`attention-${f.key}-amount`}>
          {f.amountMinor === undefined ? (
            <span className="sw-zero">–</span>
          ) : (
            <Figure minor={f.amountMinor} currency={currency} zero="zero" />
          )}
        </span>
      </td>
      <td style={{ verticalAlign: "top", width: "10rem" }}>
        <Link href={f.href} className="sw-btn sw-btn-sm my-1.5" data-testid={`attention-${f.key}-link`}>
          {destinationOf(f.href)}
          <span className="sr-only"> — {f.title}</span>
        </Link>
      </td>
    </tr>
  );
}

function Group({
  group,
  findings,
  currency,
}: {
  group: (typeof GROUPS)[number];
  findings: Finding[];
  currency: string;
}) {
  if (findings.length === 0) return null;
  const id = `attention-${group.severity}`;
  return (
    <section aria-labelledby={id} className="mb-5">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={id} className="sw-label">
          {group.heading} — {findings.length}
        </h2>
        <p className="sw-sub">{group.blurb}</p>
      </div>
      <Panel className="overflow-hidden">
        <div className="sw-scroll">
          <table className="sw-table" data-testid={`attention-group-${group.severity}`}>
            <caption className="sr-only">
              {group.heading}: {group.blurb}
            </caption>
            <thead>
              <tr>
                <th>What needs doing</th>
                <th className="sw-num" style={{ width: "4.5rem" }}>
                  Items
                </th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>
                  Amount
                </th>
                <th style={{ width: "10rem" }}>Goes to</th>
              </tr>
            </thead>
            <tbody>
              {findings.map((f) => (
                <Row key={f.key} f={f} currency={currency} chip={group.chip} />
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </section>
  );
}

export default async function AttentionPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await getSession();
  if (!session) return <Empty>Sign in to see what needs attention.</Empty>;
  const { orgId, userId } = session;

  const sp = await searchParams;

  // The entity: whatever the URL says, else whichever one the user last chose
  // elsewhere in the app, else the first this organisation has.
  const entities = await listRecords<EntityRecord>(orgId, "entities");
  const chosen = await prisma.userMeta
    .findUnique({ where: { userId_key: { userId, key: "currentEntityId" } } })
    .then((r) => (r ? (JSON.parse(r.data) as string | undefined) : undefined))
    .catch(() => undefined);
  const entityId =
    one(sp, "entityId") || (chosen && entities.some((e) => e.id === chosen) ? chosen : entities[0]?.id) || "";

  const asOf = one(sp, "asOf") || isoDay(new Date());

  let list: AttentionList | null = null;
  let error: string | null = null;
  if (entityId) {
    // Only a failure of the whole read lands here — a date that is not a date,
    // or a database that is gone. A check that throws on its own is reported by
    // the module as a failed row, because losing one check is not a reason to
    // show nothing.
    try {
      list = await attentionList({ orgId, entityId, asOf });
    } catch (e) {
      error = e instanceof LedgerError ? e.message : "The attention list could not be read.";
    }
  }

  const clear = list !== null && list.findings.length === 0;

  return (
    <>
      <PageHead
        title="Needs attention"
        sub="Everything the books say is waiting for somebody, worked out fresh on every read. Nothing here is stored and nothing can be ticked off — a row disappears when the thing that caused it is fixed, and not before."
      />

      <Panel className="mb-4 p-3">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1">
            <span className="sw-label">Entity</span>
            <select name="entityId" defaultValue={entityId} className="sw-select" style={{ width: "14rem" }}>
              {entities.length === 0 && <option value="">No entities</option>}
              {entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.legalNameEn ?? e.id}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1">
            <span className="sw-label">As at</span>
            <input type="date" name="asOf" defaultValue={asOf} className="sw-input" style={{ width: "9.5rem" }} />
          </label>
          <button type="submit" className="sw-btn">
            Show
          </button>
        </form>
      </Panel>

      {!entityId && <Empty>This organisation has no entities yet, so there is nothing to check.</Empty>}

      {error && <ErrorNote>{error}</ErrorNote>}

      {list && (
        <>
          {/* The one line that changes when the date does, announced politely
              rather than interrupting — WCAG 2.2 SC 4.1.3, the same pattern the
              other ledger screens use for a result. */}
          <div className="sw-note mb-4" role="status" data-testid="attention-summary">
            {clear ? (
              <>
                <strong>Nothing needs attention.</strong> All {list.checked} checks ran against{" "}
                {list.entityId} as at {list.asOf} and none of them found anything: no debt past its
                terms, no return waiting to be filed, no month left open behind you, and the trial
                balance balances. This is what a set of books in good order looks like — there is no
                list because there is nothing on it.
              </>
            ) : (
              <>
                {list.counts.urgent > 0 && <strong>{list.counts.urgent} urgent</strong>}
                {list.counts.urgent > 0 && (list.counts.soon > 0 || list.counts.note > 0) && ", "}
                {list.counts.soon > 0 && `${list.counts.soon} due soon`}
                {list.counts.soon > 0 && list.counts.note > 0 && ", "}
                {list.counts.note > 0 && `${list.counts.note} worth a look`}
                {" — from "}
                {list.checked} checks run against the ledger as at {list.asOf}. Every figure below is read
                from the same reports as the screen it links to, so nothing here can disagree with the page
                that fixes it.
              </>
            )}
          </div>

          {GROUPS.map((g) => (
            <Group
              key={g.severity}
              group={g}
              findings={list.findings.filter((f) => f.severity === g.severity)}
              currency={list.currency}
            />
          ))}

          {/* A check that could not run is a hole in the list, and a hole nobody
              is told about is worse than a finding. */}
          {list.failed.length > 0 && (
            <section aria-labelledby="attention-failed" className="mb-5">
              <h2 id="attention-failed" className="sw-label mb-2">
                Could not be checked — {list.failed.length}
              </h2>
              <Panel className="overflow-hidden">
                <div className="sw-scroll">
                  <table className="sw-table" data-testid="attention-failed">
                    <caption className="sr-only">
                      Checks that did not run against these books, and the reason each gave
                    </caption>
                    <thead>
                      <tr>
                        <th>Check</th>
                        <th>Why it could not run</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.failed.map((f) => (
                        <tr key={f.key} data-testid={`attention-failed-${f.key}`}>
                          <th scope="row" style={{ fontWeight: 400, width: "16rem" }}>
                            <span className="sw-chip sw-chip-warn me-2">not checked</span>
                            {f.label}
                          </th>
                          <td className="sw-sub">{f.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
              <p className="sw-sub mt-2 max-w-[74ch]">
                These rows are missing from the list above, not empty in it. Each check runs on its own so
                one of them failing costs its own row rather than the page — an entity whose books were
                never opened has no receivables control account, and that is not a reason to hide the VAT
                deadline.
              </p>
            </section>
          )}

          <p className="sw-sub mt-4 max-w-[80ch]">
            Terms are taken as thirty days from the document date, which is what this product puts on an
            invoice it raises; the ledger itself records what a document did to the books, not the document.
            A VAT return counts as filed once the months it covers have been closed behind it — nothing here
            talks to the FTA, so the period lock is the only evidence the books carry. Both readings are
            stated in{" "}
            <span className="sw-code">attention.ts</span> beside the code that makes them.
          </p>
        </>
      )}
    </>
  );
}
