"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading } from "@/components/ledger/primitives";

/**
 * The notification centre.
 *
 * This is a work queue, not a dashboard. Nobody opens it to admire a number;
 * they open it to find the next thing to do and then close it again. So the
 * density is deliberate — the severity, the sentence that says what to do, the
 * deadline, the size of it and the link that goes there all belong on one row,
 * because the alternative is a beautiful screen that has to be clicked through
 * to be used.
 *
 * Three things about the design follow from that.
 *
 * Severity is carried three ways at once: the word in the chip, the group the
 * row sits under, and the chip's border colour. Colour is never alone — roughly
 * one man in twelve cannot use it — and it is the last of the three here rather
 * than the first.
 *
 * Acknowledging and snoozing open in place, under the row they belong to,
 * rather than in a dialogue. A dialogue takes the sentence you are deciding
 * about off the screen at the moment you decide.
 *
 * Nothing is ever hidden by a filter that does not say so. "Dealt with" is a
 * tab with its own count, and the digest at the top says how many are put away
 * and when each one comes back — a queue where things disappear quietly is a
 * queue nobody trusts twice.
 */

type NoticeSeverity = "blocker" | "warning" | "advisory" | "information";
type NoticeState = "open" | "returned" | "acknowledged" | "snoozed";

interface DealtWith {
  action: "acknowledged" | "snoozed";
  actorId: string;
  actorName: string | null;
  at: string;
  reason: string | null;
  severity: NoticeSeverity;
  itemCount: number | null;
  amountMinor: string | null;
  snoozeUntil: string | null;
}

interface Notice {
  key: string;
  source: string;
  topic: string;
  scope: string | null;
  severity: NoticeSeverity;
  title: string;
  detail: string;
  href: string;
  itemCount: number | null;
  amountMinor: string | null;
  dueOn: string | null;
  daysToDue: number | null;
  statutory: boolean;
  state: NoticeState;
  outstanding: boolean;
  dealtWith: DealtWith | null;
  returnedBecause: string | null;
  mayAcknowledge: boolean;
  mayAcknowledgeBecause: string | null;
  snoozeLimit: string | null;
  snoozeLimitBecause: string | null;
}

interface SourceRun {
  key: string;
  label: string;
  ok: boolean;
  rows: number;
  reason: string | null;
}

interface DigestDeadline {
  key: string;
  title: string;
  severity: NoticeSeverity;
  dueOn: string;
  daysToDue: number;
  statutory: boolean;
}

interface DigestSnooze {
  key: string;
  title: string;
  severity: NoticeSeverity;
  until: string;
  daysToReturn: number;
  by: string | null;
}

interface Digest {
  counts: Record<NoticeSeverity, number>;
  outstanding: number;
  acknowledged: number;
  snoozed: number;
  returned: number;
  dueWithinDays: number;
  dueSoon: DigestDeadline[];
  overdue: DigestDeadline[];
  snoozedUntil: DigestSnooze[];
}

interface Centre {
  entityId: string;
  asOf: string;
  currency: string;
  notices: Notice[];
  sources: SourceRun[];
  digest: Digest;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The four words, what each means, and the chip that carries it. Falu red on a
 * chip is the status meaning of `--sw-neg`, which is the use the stylesheet
 * allows on chrome; the amounts beside it keep the value meaning.
 */
const SEVERITY: Record<NoticeSeverity, { chip: string; blurb: string }> = {
  blocker: {
    chip: "sw-chip sw-chip-bad",
    blurb: "Something is wrong now, or a deadline set by law has gone by. These cannot be acknowledged away.",
  },
  warning: {
    chip: "sw-chip sw-chip-warn",
    blurb: "It will be wrong, or a deadline is coming, or a check that might have said either could not run.",
  },
  advisory: {
    chip: "sw-chip",
    blurb: "Work somebody started and has not finished. Nothing here is late and nothing is wrong.",
  },
  information: {
    chip: "sw-chip",
    blurb: "Worth knowing. There is nothing to do about it.",
  },
};

const ORDER: NoticeSeverity[] = ["blocker", "warning", "advisory", "information"];

const STATE_LABEL: Record<NoticeState, string> = {
  open: "open",
  returned: "back",
  acknowledged: "seen",
  snoozed: "snoozed",
};

/** How a deadline reads in a cell: never a bare date when the days matter more. */
function dueLabel(dueOn: string | null, daysToDue: number | null): string {
  if (dueOn === null || daysToDue === null) return "";
  if (daysToDue < 0) return `${dueOn} · ${-daysToDue} ${-daysToDue === 1 ? "day" : "days"} ago`;
  if (daysToDue === 0) return `${dueOn} · today`;
  return `${dueOn} · in ${daysToDue} ${daysToDue === 1 ? "day" : "days"}`;
}

type Tab = "outstanding" | "dealt" | "all";

const TABS: { id: Tab; label: string; blurb: string }[] = [
  {
    id: "outstanding",
    label: "Outstanding",
    blurb:
      "Everything nobody has dealt with, plus anything that has come back because it got worse or its snooze ran out.",
  },
  {
    id: "dealt",
    label: "Dealt with",
    blurb:
      "Seen or put off. Nothing here is deleted: a row returns on its own the moment the finding is worse than the one that was acknowledged.",
  },
  { id: "all", label: "Everything", blurb: "Both lists, in one order." },
];

/* --------------------------------------------------------------- the row --- */

function Row({
  n,
  currency,
  busy,
  openForm,
  setOpenForm,
  act,
}: {
  n: Notice;
  currency: string;
  busy: boolean;
  openForm: { key: string; mode: "acknowledge" | "snooze" } | null;
  setOpenForm: (v: { key: string; mode: "acknowledge" | "snooze" } | null) => void;
  act: (action: "acknowledge" | "snooze" | "clear", key: string, extra: { reason?: string; until?: string }) => void;
}) {
  const form = openForm && openForm.key === n.key ? openForm.mode : null;
  const id = n.key.replace(/[^a-zA-Z0-9]+/g, "-");

  return (
    <>
      <tr data-testid={`notice-${n.key}`}>
        <th scope="row" style={{ fontWeight: 400, verticalAlign: "top" }} className="py-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className={SEVERITY[n.severity].chip} data-testid={`notice-${n.key}-severity`}>
              {n.severity}
            </span>
            {n.state !== "open" && (
              <span className="sw-chip sw-chip-accent" data-testid={`notice-${n.key}-state`}>
                {STATE_LABEL[n.state]}
              </span>
            )}
            {n.statutory && <span className="sw-chip sw-chip-warn">by law</span>}
            <span className="font-semibold">{n.title}</span>
          </div>
          <p className="sw-sub mt-1 max-w-[80ch]">{n.detail}</p>
          {n.returnedBecause && (
            <p className="sw-sub mt-1 max-w-[80ch]" data-testid={`notice-${n.key}-returned`}>
              <strong>Back on the list.</strong> {n.returnedBecause}{" "}
              {n.dealtWith &&
                `${n.dealtWith.actorName ?? n.dealtWith.actorId} ${n.dealtWith.action} it on ${n.dealtWith.at.slice(0, 10)}.`}
            </p>
          )}
          {!n.returnedBecause && n.dealtWith && (
            <p className="sw-sub mt-1 max-w-[80ch]" data-testid={`notice-${n.key}-dealt`}>
              {n.dealtWith.actorName ?? n.dealtWith.actorId} {n.dealtWith.action} this on{" "}
              {n.dealtWith.at.slice(0, 10)}
              {n.dealtWith.snoozeUntil ? `, back on ${n.dealtWith.snoozeUntil}` : ""}
              {n.dealtWith.reason ? ` — “${n.dealtWith.reason}”` : ""}.
            </p>
          )}
        </th>
        <td className="sw-sub" style={{ verticalAlign: "top", width: "11rem" }} data-testid={`notice-${n.key}-due`}>
          <span className="py-2 inline-block">
            {n.dueOn === null ? <span className="sw-zero">no deadline</span> : dueLabel(n.dueOn, n.daysToDue)}
          </span>
        </td>
        <td className="sw-num" style={{ verticalAlign: "top", width: "4.5rem" }}>
          <span className="py-2 inline-block">{n.itemCount ?? <span className="sw-zero">–</span>}</span>
        </td>
        <td className="sw-num" style={{ verticalAlign: "top", width: "var(--sw-col-amount)" }}>
          <span className="py-2 inline-block" data-testid={`notice-${n.key}-amount`}>
            {n.amountMinor === null ? (
              <span className="sw-zero">–</span>
            ) : (
              <Figure minor={n.amountMinor} currency={currency} zero="zero" />
            )}
          </span>
        </td>
        <td style={{ verticalAlign: "top", width: "17rem" }}>
          <div className="flex flex-wrap items-center gap-1.5 py-1.5">
            <Link href={n.href} className="sw-btn sw-btn-sm" data-testid={`notice-${n.key}-link`}>
              Go
              <span className="sr-only"> to the screen that fixes: {n.title}</span>
            </Link>

            {n.outstanding && (
              <>
                {/* A blocked action is never silently dead: it stays focusable
                    and carries the reason, so a keyboard user finds out what is
                    wrong rather than finding nothing. */}
                <button
                  type="button"
                  className="sw-btn sw-btn-sm"
                  data-testid={`notice-${n.key}-ack`}
                  aria-disabled={!n.mayAcknowledge || undefined}
                  aria-expanded={form === "acknowledge"}
                  aria-controls={form === "acknowledge" ? `form-${id}` : undefined}
                  aria-describedby={n.mayAcknowledge ? undefined : `why-ack-${id}`}
                  title={n.mayAcknowledgeBecause ?? undefined}
                  onClick={() =>
                    n.mayAcknowledge && setOpenForm(form === "acknowledge" ? null : { key: n.key, mode: "acknowledge" })
                  }
                >
                  Acknowledge
                  <span className="sr-only"> {n.title}</span>
                </button>
                {!n.mayAcknowledge && (
                  <span id={`why-ack-${id}`} className="sr-only">
                    {n.mayAcknowledgeBecause}
                  </span>
                )}
                <button
                  type="button"
                  className="sw-btn sw-btn-sm"
                  data-testid={`notice-${n.key}-snooze`}
                  aria-disabled={n.snoozeLimit === null || undefined}
                  aria-expanded={form === "snooze"}
                  aria-controls={form === "snooze" ? `form-${id}` : undefined}
                  aria-describedby={n.snoozeLimit === null ? `why-snooze-${id}` : undefined}
                  title={n.snoozeLimitBecause ?? undefined}
                  onClick={() =>
                    n.snoozeLimit !== null && setOpenForm(form === "snooze" ? null : { key: n.key, mode: "snooze" })
                  }
                >
                  Snooze
                  <span className="sr-only"> {n.title}</span>
                </button>
                {n.snoozeLimit === null && (
                  <span id={`why-snooze-${id}`} className="sr-only">
                    {n.snoozeLimitBecause}
                  </span>
                )}
              </>
            )}

            {n.dealtWith && (
              <button
                type="button"
                className="sw-btn sw-btn-sm"
                data-testid={`notice-${n.key}-clear`}
                disabled={busy}
                onClick={() => act("clear", n.key, {})}
              >
                Put back
                <span className="sr-only"> on the queue: {n.title}</span>
              </button>
            )}
          </div>
        </td>
      </tr>

      {form && (
        <tr data-testid={`notice-${n.key}-form`}>
          <td colSpan={5} style={{ paddingBlock: "0.5rem" }}>
            <form
              id={`form-${id}`}
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                act(form, n.key, {
                  reason: String(data.get("reason") ?? "").trim() || undefined,
                  until: form === "snooze" ? String(data.get("until") ?? "") : undefined,
                });
              }}
            >
              {form === "snooze" && (
                <label className="grid gap-1">
                  <span className="sw-label">Bring it back on</span>
                  <input
                    type="date"
                    name="until"
                    required
                    max={n.snoozeLimit ?? undefined}
                    className="sw-input sw-input-sm"
                    style={{ width: "9.5rem" }}
                    aria-label={`The day to bring back: ${n.title}`}
                    aria-describedby={`limit-${id}`}
                    data-testid={`notice-${n.key}-until`}
                  />
                </label>
              )}
              <label className="grid gap-1" style={{ flex: "1 1 22rem" }}>
                <span className="sw-label">Why {form === "snooze" ? "it can wait" : "it is being left"} — optional</span>
                <input
                  type="text"
                  name="reason"
                  className="sw-input sw-input-sm"
                  aria-label={`Reason for ${form === "snooze" ? "snoozing" : "acknowledging"}: ${n.title}`}
                  data-testid={`notice-${n.key}-reason`}
                />
              </label>
              <button type="submit" className="sw-btn sw-btn-sm sw-btn-primary" disabled={busy}>
                {form === "snooze" ? "Snooze it" : "Acknowledge it"}
                <span className="sr-only"> — {n.title}</span>
              </button>
              <button type="button" className="sw-btn sw-btn-sm" onClick={() => setOpenForm(null)}>
                Cancel
                <span className="sr-only"> — {n.title}</span>
              </button>
              <p id={`limit-${id}`} className="sw-sub" style={{ flexBasis: "100%" }}>
                {form === "snooze"
                  ? n.snoozeLimitBecause
                  : "It stays on the dealt-with list and comes back on its own if the finding gets worse than the one you are looking at."}
              </p>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}

/* -------------------------------------------------------------- the page --- */

export default function NotificationsPage() {
  const entityId = useEntityId();
  const [asOf, setAsOf] = React.useState(() => isoDay(new Date()));
  const [tab, setTab] = React.useState<Tab>("outstanding");
  const [openForm, setOpenForm] = React.useState<{ key: string; mode: "acknowledge" | "snooze" } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const { data, error, loading, reload } = useLedgerQuery<Centre>(
    entityId ? `/api/ledger/notifications?entityId=${entityId}&asOf=${asOf}` : null,
    [asOf],
  );

  const act = async (
    action: "acknowledge" | "snooze" | "clear",
    key: string,
    extra: { reason?: string; until?: string },
  ) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await api<Centre>("/api/ledger/notifications", {
        method: "POST",
        body: JSON.stringify({ action, entityId, key, asOf, ...extra }),
      });
      setOpenForm(null);
      setMsg(
        action === "clear"
          ? "Put back on the queue."
          : action === "snooze"
            ? `Snoozed until ${extra.until}. It comes back on its own that morning, and sooner if it gets worse.`
            : "Acknowledged. It moves to the dealt-with list and returns on its own if it gets worse.",
      );
      reload();
    } catch (e) {
      // The refusals are the point of this screen — a snooze past a statutory
      // deadline, an acknowledgement of a blocker — so the message from the
      // server is shown as it was written rather than replaced.
      setErr(e instanceof ApiError ? e.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;

  const shown =
    data === null
      ? []
      : data.notices.filter((n) => (tab === "all" ? true : tab === "outstanding" ? n.outstanding : !n.outstanding));

  const digest = data?.digest;
  const quiet = data !== null && data.digest.outstanding === 0;

  return (
    <>
      <PageHead
        title="Notifications"
        sub={
          "Everything eight parts of the books are trying to say, in one queue. Nothing here is stored: the rows " +
          "are worked out fresh on every read from the modules that own each fact, so a row goes when the thing " +
          "behind it is fixed. What is stored is what people have said about them."
        }
        actions={
          <label className="flex items-center gap-1.5">
            <span className="sw-label">As at</span>
            <input
              type="date"
              className="sw-input"
              style={{ width: "9.5rem" }}
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              aria-label="The date the notifications are read as at"
              data-testid="notifications-asof"
            />
          </label>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {error && <ErrorNote>{error}</ErrorNote>}
      {msg && (
        <div className="sw-note mb-3" role="status" data-testid="notifications-result">
          {msg}
        </div>
      )}
      {loading && !data && <Loading />}

      {data && digest && (
        <>
          {/* The one line that changes when anything is dealt with, announced
              politely rather than interrupting — WCAG 2.2 SC 4.1.3, the same
              pattern the other ledger screens use for a result. */}
          <div className="sw-note mb-4" role="status" data-testid="notifications-digest">
            {quiet ? (
              <>
                <strong>Nothing is outstanding.</strong> All {data.sources.length} sources were read against{" "}
                {data.entityId} as at {data.asOf} and none of them has anything waiting.
              </>
            ) : (
              <>
                {ORDER.filter((s) => digest.counts[s] > 0)
                  .map((s) => `${digest.counts[s]} ${s}${digest.counts[s] === 1 ? "" : "s"}`)
                  .join(", ")}{" "}
                outstanding as at {data.asOf}, from {data.sources.length} sources.
                {digest.overdue.length > 0 && (
                  <>
                    {" "}
                    <strong>
                      {digest.overdue.length} deadline{digest.overdue.length === 1 ? " has" : "s have"} already passed
                    </strong>{" "}
                    ({digest.overdue.map((d) => `${d.title.toLowerCase()}, ${d.dueOn}`).join("; ")}).
                  </>
                )}{" "}
                {digest.dueSoon.length > 0 ? (
                  <>
                    {digest.dueSoon.length} fall{digest.dueSoon.length === 1 ? "s" : ""} due within{" "}
                    {digest.dueWithinDays} days:{" "}
                    {digest.dueSoon.map((d) => `${d.title.toLowerCase()} on ${d.dueOn}`).join("; ")}.
                  </>
                ) : (
                  <>Nothing falls due in the next {digest.dueWithinDays} days.</>
                )}{" "}
                {digest.snoozed > 0 && (
                  <>
                    {digest.snoozed} snoozed —{" "}
                    {digest.snoozedUntil.map((s) => `${s.title.toLowerCase()} comes back ${s.until}`).join("; ")}.
                  </>
                )}
                {digest.returned > 0 && (
                  <>
                    {" "}
                    {digest.returned} {digest.returned === 1 ? "row is" : "rows are"} back on the list because{" "}
                    {digest.returned === 1 ? "it" : "they"} got worse or the snooze ran out.
                  </>
                )}
              </>
            )}
          </div>

          <nav className="sw-tabs mb-1" aria-label="Which notifications to show">
            {TABS.map((t) => {
              const count =
                t.id === "all"
                  ? data.notices.length
                  : t.id === "outstanding"
                    ? digest.outstanding
                    : data.notices.length - digest.outstanding;
              return (
                <button
                  key={t.id}
                  type="button"
                  className="sw-tab"
                  aria-current={tab === t.id ? "page" : undefined}
                  onClick={() => setTab(t.id)}
                  data-testid={`notifications-tab-${t.id}`}
                >
                  {t.label} — {count}
                </button>
              );
            })}
          </nav>
          <p className="sw-sub mb-3 max-w-[80ch]">{TABS.find((t) => t.id === tab)!.blurb}</p>

          {shown.length === 0 && (
            <div className="sw-note mb-4">
              {tab === "outstanding"
                ? "Nothing outstanding. This is what a set of books in good order looks like — there is no list because there is nothing on it."
                : tab === "dealt"
                  ? "Nobody has acknowledged or snoozed anything yet."
                  : "Nothing at all."}
            </div>
          )}

          {ORDER.map((severity) => {
            const rows = shown.filter((n) => n.severity === severity);
            if (rows.length === 0) return null;
            const headingId = `notifications-${severity}`;
            return (
              <section key={severity} aria-labelledby={headingId} className="mb-5">
                <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h2 id={headingId} className="sw-label">
                    {severity} — {rows.length}
                  </h2>
                  <p className="sw-sub">{SEVERITY[severity].blurb}</p>
                </div>
                <Panel className="overflow-hidden">
                  <div className="sw-scroll">
                    <table className="sw-table" data-testid={`notifications-group-${severity}`}>
                      <caption className="sr-only">
                        {severity}: {SEVERITY[severity].blurb}
                      </caption>
                      <thead>
                        <tr>
                          <th>What it is</th>
                          <th style={{ width: "11rem" }}>Due</th>
                          <th className="sw-num" style={{ width: "4.5rem" }}>
                            Items
                          </th>
                          <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>
                            Amount
                          </th>
                          <th style={{ width: "17rem" }}>What can be done</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((n) => (
                          <Row
                            key={n.key}
                            n={n}
                            currency={data.currency}
                            busy={busy}
                            openForm={openForm}
                            setOpenForm={setOpenForm}
                            act={act}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              </section>
            );
          })}

          <section aria-labelledby="notifications-sources" className="mb-5">
            <h2 id="notifications-sources" className="sw-label mb-2">
              Where this came from — {data.sources.length} sources
            </h2>
            <Panel className="overflow-hidden">
              <div className="sw-scroll">
                <table className="sw-table" data-testid="notifications-sources">
                  <caption className="sr-only">
                    The modules this queue was gathered from, how many rows each gave, and the reason any could not be
                    read
                  </caption>
                  <thead>
                    <tr>
                      <th style={{ width: "16rem" }}>Source</th>
                      <th className="sw-num" style={{ width: "4.5rem" }}>
                        Rows
                      </th>
                      <th>How it went</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sources.map((s) => (
                      <tr key={s.key} data-testid={`notifications-source-${s.key}`}>
                        <th scope="row" style={{ fontWeight: 400 }}>
                          <span className={`sw-chip ${s.ok ? "sw-chip-ok" : "sw-chip-warn"} me-2`}>
                            {s.ok ? "read" : "not read"}
                          </span>
                          {s.label}
                        </th>
                        <td className="sw-num">{s.rows}</td>
                        <td className="sw-sub">
                          {s.ok ? (s.rows === 0 ? "Nothing to report." : "Reported the rows above.") : s.reason}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
            <p className="sw-sub mt-2 max-w-[80ch]">
              Each source runs on its own, so one of them failing costs its own row rather than the page. A source that
              could not be read is a warning and not a note: it might have been hiding the worst thing on the list, and
              a check that did not run is not a check that passed.
            </p>
          </section>

          <p className="sw-sub mt-4 max-w-[80ch]">
            A row is the same row across two reads when it is about the same thing — which module said it, which of its
            checks, and which month, quarter or item it is about. Never the wording, because every sentence here is
            written from the figures behind it and would change identity every time a number moved. The figures live on
            the acknowledgement instead: acknowledging three unreconciled bank lines does not put forty-seven of them
            out of sight. Nothing with a deadline can be snoozed up to it, and the rule is kept by the database in{" "}
            <span className="sw-code">NotificationAck_snooze_before_due_check</span> rather than by this screen.
          </p>
        </>
      )}
    </>
  );
}
