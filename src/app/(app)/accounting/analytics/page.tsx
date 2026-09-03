import Link from "next/link";
import { prisma } from "@/lib/server/prisma";
import { getSession } from "@/lib/server/session";
import { listRecords } from "@/lib/server/store";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  ledgerAnalytics,
  type LedgerAnalytics,
  type Finding,
  type FindingEntry,
  type Severity,
  type TestRun,
  type Outcome,
} from "@/lib/server/ledger/analytics";
import { Figure, PageHead, Panel, ErrorNote, Empty } from "@/components/ledger/primitives";

/**
 * Ledger analytics.
 *
 * The screen is built around one refusal: it will not show only the findings.
 * A page of red flags with nothing beside them teaches its reader that flags
 * are normal and that a quiet week means the software found nothing — when it
 * may equally mean the software never looked. So "What ran" is not an appendix
 * at the bottom; it is the same size as the findings, it lists every test
 * whatever the outcome, and it says what each one read.
 *
 * Rendered on the server and filtered through the URL, like the audit trail and
 * the attention list, because a finding has to be quotable. "The duplicate in
 * the second quarter" only means something to a colleague if the link they are
 * sent reproduces exactly what was on screen.
 *
 * Every entry named by a finding links to the audit trail, filtered to that
 * entry's own date and anchored to it. That is the one screen in the product
 * that shows a single posted entry with its provenance beside it, which is what
 * somebody following up a finding actually needs — the register shows the
 * newest hundred and would not contain a finding from March.
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

/**
 * Severity is carried three ways at once — the group it sits under, the word in
 * the chip, and the chip's border colour — and colour is the last of the three
 * rather than the first. Falu red on a chip is the *status* meaning of
 * `--sw-neg`, which is the use the stylesheet allows on chrome; the amounts
 * beside it keep the value meaning, parentheses and all.
 */
const GROUPS: { severity: Severity; heading: string; chip: string; blurb: string }[] = [
  {
    severity: "high",
    heading: "Look at these first",
    chip: "sw-chip sw-chip-bad",
    blurb: "Money that may be recoverable, or something the ledger says should not be possible.",
  },
  {
    severity: "medium",
    heading: "Worth an explanation",
    chip: "sw-chip sw-chip-warn",
    blurb: "Nothing is wrong. Somebody should be able to say why each of these is as it is.",
  },
  {
    severity: "low",
    heading: "Prompts, not findings",
    chip: "sw-chip",
    blurb: "Patterns worth a glance. None of them is evidence of anything on its own.",
  },
];

const OUTCOME: Record<Outcome, { chip: string; word: string }> = {
  found: { chip: "sw-chip sw-chip-warn", word: "found something" },
  clean: { chip: "sw-chip sw-chip-ok", word: "ran, found nothing" },
  skipped: { chip: "sw-chip", word: "could not look" },
  failed: { chip: "sw-chip sw-chip-bad", word: "did not run" },
};

/**
 * A basis-point figure. Negatives take parentheses as well as the colour,
 * because roughly one man in twelve cannot use the colour — the same rule the
 * money figures follow, applied to a value that is not money.
 */
function Bp({ value }: { value: number }) {
  const s = String(Math.abs(value)).padStart(3, "0");
  const body = `${s.slice(0, -2)}.${s.slice(-2)}%`;
  return <span className={value < 0 ? "sw-num-neg" : ""}>{value < 0 ? `(${body})` : body}</span>;
}

/** The audit trail, narrowed to the day of this entry and anchored to it. */
function entryHref(entityId: string, e: FindingEntry): string {
  const q = new URLSearchParams({ entityId, from: e.date, to: e.date });
  return `/accounting/audit?${q.toString()}#entry-${e.id}`;
}

function Entries({ entityId, entries, currency }: { entityId: string; entries: FindingEntry[]; currency: string }) {
  return (
    <div className="sw-scroll">
      <table className="sw-table">
        <caption className="sr-only">The entries behind this finding, largest first</caption>
        <thead>
          <tr>
            <th style={{ width: "9rem" }}>Reference</th>
            <th style={{ width: "7rem" }}>Dated</th>
            <th>Memo</th>
            <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} data-testid={`analytics-entry-${e.reference}`}>
              <th scope="row" style={{ fontWeight: 400 }}>
                <Link href={entryHref(entityId, e)} className="sw-link sw-code sw-link-btn">
                  {e.reference}
                </Link>
              </th>
              <td className="sw-code">{e.date}</td>
              <td style={{ color: e.memo ? undefined : "var(--sw-fg-faint)" }}>{e.memo ?? "no memo"}</td>
              <td className="sw-num">
                <Figure minor={e.amountMinor} currency={currency} zero="zero" colour={false} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FindingPanel({
  f,
  chip,
  entityId,
  currency,
}: {
  f: Finding;
  chip: string;
  entityId: string;
  currency: string;
}) {
  return (
    <Panel className="mb-2 overflow-hidden">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 pt-2">
        <span className={chip} data-testid={`analytics-${f.key}-severity`}>
          {f.severity}
        </span>
        <h3 className="font-semibold grow" style={{ fontSize: "0.875rem" }}>
          {f.title}
        </h3>
        <span className="sw-sub">{f.count === 1 ? "1 entry" : `${f.count} entries`}</span>
        <span className="sw-num" style={{ minWidth: "var(--sw-col-amount)" }} data-testid={`analytics-${f.key}-amount`}>
          {f.amountMinor === undefined ? (
            <span className="sw-zero">–</span>
          ) : (
            <Figure minor={f.amountMinor} currency={currency} zero="zero" colour={false} />
          )}
        </span>
      </div>
      <p className="sw-sub px-3 pt-1 pb-2 max-w-[92ch]">{f.detail}</p>
      {f.entries.length > 0 ? (
        <details className="px-3 pb-2" data-testid={`analytics-${f.key}-entries`}>
          {/* A button rather than a triangle: it takes the same focus ring as
              every other control on the page, and the open/closed state is
              announced by the element itself. */}
          <summary className="sw-btn sw-btn-sm" style={{ listStyle: "none" }}>
            {f.entries.length === 1 ? "Show the entry" : `Show ${f.entries.length} entries`}
          </summary>
          <div className="mt-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
            <Entries entityId={entityId} entries={f.entries} currency={currency} />
          </div>
        </details>
      ) : (
        <p className="sw-sub px-3 pb-2" style={{ color: "var(--sw-fg-faint)" }}>
          There are no entries to list — see the description above for why.
        </p>
      )}
    </Panel>
  );
}

function Group({
  group,
  findings,
  entityId,
  currency,
}: {
  group: (typeof GROUPS)[number];
  findings: Finding[];
  entityId: string;
  currency: string;
}) {
  const id = `analytics-${group.severity}`;
  return (
    <section aria-labelledby={id} className="mb-5">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={id} className="sw-label">
          {group.heading} — {findings.length}
        </h2>
        <p className="sw-sub">{group.blurb}</p>
      </div>
      {findings.length === 0 ? (
        <p className="sw-sub" data-testid={`analytics-group-${group.severity}-empty`}>
          Nothing at this level. Every test that could look is listed under “What ran” below, with what it read.
        </p>
      ) : (
        <div data-testid={`analytics-group-${group.severity}`}>
          {findings.map((f) => (
            <FindingPanel key={f.key} f={f} chip={group.chip} entityId={entityId} currency={currency} />
          ))}
        </div>
      )}
    </section>
  );
}

function BenfordTable({ b }: { b: LedgerAnalytics["benford"] }) {
  return (
    <section aria-labelledby="analytics-benford" className="mb-5">
      <h2 id="analytics-benford" className="sw-label mb-2">
        Benford — expected against observed
      </h2>
      <Panel className="overflow-hidden">
        <div className="sw-scroll">
          <table className="sw-table" data-testid="analytics-benford">
            <caption className="sr-only">
              The expected first-digit distribution under Benford&rsquo;s law against the one observed in this ledger
            </caption>
            <thead>
              <tr>
                <th style={{ width: "5rem" }}>Digit</th>
                <th className="sw-num" style={{ width: "7rem" }}>
                  Expected
                </th>
                <th className="sw-num" style={{ width: "7rem" }}>
                  Observed
                </th>
                <th className="sw-num" style={{ width: "7rem" }}>
                  Entries
                </th>
                <th className="sw-num" style={{ width: "8rem" }}>
                  Difference
                </th>
                <th />
              </tr>
            </thead>
            <tbody>
              {b.digits.map((d) => (
                <tr key={d.digit} data-testid={`benford-${d.digit}`}>
                  <th scope="row" style={{ fontWeight: 400 }} className="sw-code">
                    {d.digit}
                  </th>
                  <td className="sw-num">
                    <Bp value={d.expectedBp} />
                  </td>
                  <td className="sw-num">
                    <Bp value={d.observedBp} />
                  </td>
                  <td className="sw-num">{d.observed === 0 ? <span className="sw-zero">–</span> : d.observed}</td>
                  <td className="sw-num">
                    <Bp value={d.differenceBp} />
                  </td>
                  <td />
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">All</th>
                <td className="sw-num">100.00%</td>
                <td className="sw-num">{b.population === 0 ? <span className="sw-zero">–</span> : "100.00%"}</td>
                <td className="sw-num">{b.population}</td>
                <td className="sw-num" data-testid="benford-mad">
                  {b.madBp === null ? <span className="sw-zero">no verdict</span> : <Bp value={b.madBp} />}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="sw-sub px-3 py-2 max-w-[92ch]" style={{ borderTop: "1px solid var(--sw-line)" }}>
          {b.note}
        </p>
      </Panel>
    </section>
  );
}

function Runs({ runs }: { runs: TestRun[] }) {
  return (
    <section aria-labelledby="analytics-runs" className="mb-5">
      <h2 id="analytics-runs" className="sw-label mb-2">
        What ran — {runs.length}
      </h2>
      <Panel className="overflow-hidden">
        <div className="sw-scroll">
          <table className="sw-table" data-testid="analytics-runs">
            <caption className="sr-only">
              Every test, what it read and what it found — including the ones that found nothing
            </caption>
            <thead>
              <tr>
                <th style={{ width: "16rem" }}>Test</th>
                <th style={{ width: "11rem" }}>Outcome</th>
                <th className="sw-num" style={{ width: "6rem" }}>
                  Entries
                </th>
                <th className="hidden md:table-cell" style={{ width: "13rem" }}>
                  Over
                </th>
                <th>What it read, and what came of it</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.key} data-testid={`analytics-run-${r.key}`} data-outcome={r.outcome}>
                  <th scope="row" style={{ fontWeight: 400, verticalAlign: "top" }} className="py-1.5">
                    {r.label}
                  </th>
                  <td style={{ verticalAlign: "top" }} className="py-1.5">
                    <span className={OUTCOME[r.outcome].chip}>{OUTCOME[r.outcome].word}</span>
                  </td>
                  <td className="sw-num" style={{ verticalAlign: "top" }}>
                    <span className="py-1.5 inline-block">
                      {r.population === 0 ? <span className="sw-zero">–</span> : r.population}
                    </span>
                  </td>
                  <td className="hidden md:table-cell sw-code" style={{ verticalAlign: "top" }}>
                    <span className="py-1.5 inline-block">
                      {r.from ? `${r.from} → ${r.to}` : <span className="sw-zero">–</span>}
                    </span>
                  </td>
                  <td className="sw-sub py-1.5" style={{ verticalAlign: "top" }}>
                    {r.note}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <p className="sw-sub mt-2 max-w-[88ch]">
        This table is the reason the one above it can be trusted. A test that quietly returns nothing looks exactly
        like a test that never ran, a test whose threshold excluded everything and a test whose account was missing —
        so each one says here what it read, over what dates, and either what it found or why it could not look.
      </p>
    </section>
  );
}

export default async function LedgerAnalyticsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await getSession();
  if (!session) return <Empty>Sign in to run the ledger analytics.</Empty>;
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

  const from = one(sp, "from");
  const to = one(sp, "to");

  const head = (
    <PageHead
      title="Ledger analytics"
      sub="The tests an auditor runs over a whole ledger looking for what should not be there. Nothing here is stored and nothing here is evidence — each test reads the posted ledger on every request and hands back the entries behind what it says, so every line can be gone and looked at."
    />
  );

  const filters = (
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
          <span className="sw-label">From</span>
          <input type="date" name="from" defaultValue={from} className="sw-input" style={{ width: "9.5rem" }} />
        </label>
        <label className="grid gap-1">
          <span className="sw-label">To</span>
          <input type="date" name="to" defaultValue={to} className="sw-input" style={{ width: "9.5rem" }} />
        </label>
        <button type="submit" className="sw-btn" data-testid="analytics-run">
          Run
        </button>
        <Link href="/accounting/analytics" className="sw-link text-[0.8125rem]">
          Whole ledger
        </Link>
      </form>
      <p className="sw-sub mt-2 max-w-[80ch]">
        Leave the dates empty to read everything the ledger holds. Frequency tests — the unusual pairings, an
        actor&rsquo;s usual size — measure against this entity&rsquo;s own history and nothing else, so narrowing the
        window narrows the history they have to compare against.
      </p>
    </Panel>
  );

  if (!entityId) {
    return (
      <>
        {head}
        <Empty>This organisation has no entities yet, so there is no ledger to analyse.</Empty>
      </>
    );
  }

  let result: LedgerAnalytics | null = null;
  let error: string | null = null;
  try {
    result = await ledgerAnalytics({ orgId, entityId, from: from || undefined, to: to || undefined });
  } catch (e) {
    // Only a failure of the whole read lands here — a date that is not a date,
    // or a database that is gone. A test that throws on its own is reported by
    // the module as a row in "What ran", because losing one test is not a
    // reason to show nothing.
    error = e instanceof LedgerError ? e.message : "The ledger analytics could not be run.";
  }

  const findings = result?.findings ?? [];

  return (
    <>
      {head}
      {filters}
      {error && <ErrorNote>{error}</ErrorNote>}

      {result && (
        <>
          {/* The one line that changes when the window does, announced politely
              rather than interrupting — WCAG 2.2 SC 4.1.3, the same pattern the
              other ledger screens use for a result. */}
          <div className="sw-note mb-4" role="status" data-testid="analytics-summary">
            {findings.length === 0 ? (
              <>
                <strong>All {result.checked} tests ran and none of them found anything.</strong> They read{" "}
                {result.population === 1 ? "1 entry" : `${result.population} entries`}
                {result.populationFrom ? ` dated ${result.populationFrom} to ${result.populationTo}` : ""} for{" "}
                {result.entityId}. Every test is listed below with what it read, because &ldquo;found nothing&rdquo;
                is only worth reading when you can see what was looked at.
              </>
            ) : (
              <>
                {result.counts.high > 0 && <strong>{result.counts.high} to look at first</strong>}
                {result.counts.high > 0 && (result.counts.medium > 0 || result.counts.low > 0) && ", "}
                {result.counts.medium > 0 && `${result.counts.medium} worth an explanation`}
                {result.counts.medium > 0 && result.counts.low > 0 && ", "}
                {result.counts.low > 0 && `${result.counts.low} worth a glance`}
                {" — from "}
                {result.checked} tests over{" "}
                {result.population === 1 ? "1 entry" : `${result.population} entries`}
                {result.populationFrom ? ` dated ${result.populationFrom} to ${result.populationTo}` : ""}. None of
                this is evidence of anything; every one of them is a question with the entries attached.
              </>
            )}
          </div>

          {result.truncated && (
            <div className="sw-note mb-4" data-testid="analytics-truncated">
              <strong>Only the most recent entries were read.</strong> This ledger holds more than the{" "}
              {result.population} entries one read will pull, so the oldest were not analysed. Narrow the window to
              analyse an earlier period; every population figure below counts only what was actually read.
            </div>
          )}

          {GROUPS.map((g) => (
            <Group
              key={g.severity}
              group={g}
              findings={findings.filter((f) => f.severity === g.severity)}
              entityId={result!.entityId}
              currency={result!.currency}
            />
          ))}

          <BenfordTable b={result.benford} />

          <Runs runs={result.runs} />

          <p className="sw-sub mt-4 max-w-[88ch]">
            Every test above reads the posted ledger and adds nothing to it. Thresholds — a week between duplicate
            payments, a thousand for a round number, ten times an actor&rsquo;s own median — are constants stated
            beside the code that applies them in <span className="sw-code">analytics.ts</span>, so a finding can
            always be traced back to the rule that produced it. What is unusual is measured against this
            entity&rsquo;s own history rather than against a table of things that are suspicious in general, because
            there is no such table: a pairing that is a fraud in one business is a routine posting in the next.
          </p>
        </>
      )}
    </>
  );
}
