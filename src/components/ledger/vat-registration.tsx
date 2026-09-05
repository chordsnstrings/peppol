"use client";

import * as React from "react";
import { Panel } from "./primitives";

/**
 * The FTA registration, recorded rather than inferred.
 *
 * `tax-periods.ts` derives every VAT period and every VAT deadline in the
 * product from this one record, and where it is missing it falls back to
 * calendar quarters ending in March — the stagger the Authority happens to
 * assign to one registrant in three. `recordRegistration` has existed since
 * that module was written and the route has accepted it since it was routed;
 * nothing in a browser ever sent one. So the fallback was permanent, and the
 * attention list's own advice — recording the registration fixes it everywhere
 * at once — pointed at a screen that had no control on it.
 *
 * The panel therefore says which of the two the reader is looking at before it
 * says anything else. An assumed period and a recorded one are identical on a
 * screen that does not distinguish them, and only one of them is a fact.
 */

/**
 * The regime this screen keeps.
 *
 * The ledger records one registration per entity per regime, and the two others
 * — corporate tax and excise — have their own periods, their own returns and no
 * screen of their own. Offering them in a picker here would let somebody file a
 * VAT screen's form against an excise registration this screen then could not
 * read back, so the regime is stated rather than chosen.
 */
export const REGIME = "VAT";

const FREQUENCIES = ["MONTHLY", "QUARTERLY", "ANNUAL"] as const;
export type TaxFrequency = (typeof FREQUENCIES)[number];

const FREQUENCY_LABEL: Record<string, string> = {
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  ANNUAL: "Annual",
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** The registration as `getRegistration` answers with it. */
export interface RecordedRegistration {
  regime: string;
  trn: string | null;
  frequency: string;
  firstPeriodEndMonth: number;
  registeredOn: string | null;
  deregisteredOn: string | null;
}

/** What the register verb takes. Every field is sent on every save — see below. */
export interface RegistrationToRecord {
  regime: string;
  trn: string | null;
  frequency: string;
  firstPeriodEndMonth: number;
  registeredOn: string | null;
  deregisteredOn: string | null;
}

/**
 * How the periods run, in a sentence — the same sentence `ruleInWords` builds
 * server-side, so the preview under the form and the note under the outstanding
 * list cannot describe the same registration two different ways.
 */
export function periodsInWords(frequency: string, firstPeriodEndMonth: number): string {
  const month = MONTHS[firstPeriodEndMonth - 1] ?? "an unrecorded month";
  if (frequency === "MONTHLY") {
    return "Monthly periods, each ending on the last day of the month";
  }
  if (frequency === "ANNUAL") {
    return `An annual period ending on the last day of ${month}`;
  }
  const ends = [0, 1, 2, 3].map((i) => MONTHS[(firstPeriodEndMonth - 1 + i * 3) % 12]);
  return `Quarterly periods ending in ${ends.slice(0, 3).join(", ")} and ${ends[3]}`;
}

/** The TRN as the FTA issues it: fifteen digits, however they were pasted in. */
const digitsOf = (raw: string) => raw.replace(/\D/g, "");

export function RegistrationPanel({
  registration,
  busy,
  onRecord,
}: {
  registration: RecordedRegistration | null;
  busy: boolean;
  onRecord: (r: RegistrationToRecord) => Promise<boolean>;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <Panel className="mb-4 overflow-hidden">
      <div
        className="flex flex-wrap items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}
      >
        <span className="sw-label">FTA registration</span>
        {registration ? (
          <span className="sw-chip sw-chip-ok" data-testid="vat-periods-recorded">periods recorded</span>
        ) : (
          <span className="sw-chip sw-chip-warn" data-testid="vat-periods-assumed">periods assumed</span>
        )}
        <button
          type="button"
          className="sw-btn sw-btn-sm ms-auto"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          data-testid="record-registration"
        >
          {open ? "Cancel" : registration ? "Amend the registration" : "Record the registration"}
        </button>
      </div>

      <div className="p-3">
        {registration ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="TRN" value={registration.trn ?? <span className="sw-sub">not recorded</span>} code={Boolean(registration.trn)} />
              <Stat label="Returns" value={FREQUENCY_LABEL[registration.frequency] ?? registration.frequency} />
              <Stat
                label="First period ends"
                value={MONTHS[registration.firstPeriodEndMonth - 1] ?? String(registration.firstPeriodEndMonth)}
              />
              <Stat label="Registered" value={registration.registeredOn ?? <span className="sw-sub">not recorded</span>} />
            </div>
            <p className="sw-sub mt-3 max-w-[80ch]">
              {periodsInWords(registration.frequency, registration.firstPeriodEndMonth)}. Every VAT period and every
              VAT deadline in this product is derived from that — the periods offered above, the return this screen
              computes, the reminders and the cash forecast — so nothing here is a calendar quarter unless the
              Authority said so.
              {registration.deregisteredOn && (
                <>
                  {" "}This registration was given up on {registration.deregisteredOn}, so no period beginning after
                  it is listed as outstanding.
                </>
              )}
            </p>
          </>
        ) : (
          <p className="sw-sub max-w-[80ch]" data-testid="vat-registration-assumed">
            No VAT registration is recorded for this entity, so nothing here knows what its tax periods are. The
            periods offered above are calendar quarters and months this screen made up, and every VAT deadline
            elsewhere in the product — the attention list, the reminders, the cash forecast — assumes quarterly
            periods ending in March. The Authority assigns the period when it registers a taxable person and does not
            give everybody the same one: a registrant on the February, May, August and November stagger has no
            calendar quarter at all, and for them each of those dates is a month out at both ends. Record what the
            registration certificate says and the assumption is replaced everywhere at once.
          </p>
        )}
      </div>

      {open && (
        <div className="border-t p-3" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
          {/* Closed only once it is recorded. A registration the server
              refused — a TRN a digit short is the usual one — has to stay on
              screen to be corrected. */}
          <RegistrationForm
            registration={registration}
            busy={busy}
            onRecord={async (r) => { if (await onRecord(r)) setOpen(false); }}
          />
        </div>
      )}
    </Panel>
  );
}

/**
 * The form.
 *
 * It starts from what is already recorded, every field of it, because
 * `recordRegistration` is an upsert whose update writes the whole row: a form
 * that sent only the fields somebody touched would clear a deregistration date,
 * or a TRN, that nobody meant to touch. Amending a stagger and losing the TRN
 * off every tax invoice is not a failure anybody would notice on the day.
 */
function RegistrationForm({
  registration,
  busy,
  onRecord,
}: {
  registration: RecordedRegistration | null;
  busy: boolean;
  onRecord: (r: RegistrationToRecord) => void;
}) {
  const [f, setF] = React.useState({
    trn: registration?.trn ?? "",
    frequency: registration?.frequency ?? "QUARTERLY",
    firstPeriodEndMonth: String(registration?.firstPeriodEndMonth ?? 3),
    registeredOn: registration?.registeredOn ?? "",
    deregisteredOn: registration?.deregisteredOn ?? "",
  });
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  const trn = digitsOf(f.trn);
  const month = Number(f.firstPeriodEndMonth);

  const blocker =
    f.trn.trim() !== "" && trn.length !== 15
      ? `A TRN is 15 digits and this one has ${trn.length}. A leading zero is usually the one missing — a spreadsheet strips it.`
      : f.deregisteredOn && f.registeredOn && f.deregisteredOn < f.registeredOn
        ? "A registration cannot end before it began."
        : null;

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {/* Stated rather than chosen — see REGIME above. It is not a label
            because there is no control under it to name. */}
        <div>
          <span className="sw-label">Regime</span>
          <p className="sw-sub mt-1">
            VAT. Corporate tax and excise registrations are recorded under their own regime and not from here.
          </p>
        </div>
        <Field label="TRN">
          <input
            className="sw-input"
            inputMode="numeric"
            value={f.trn}
            onChange={(e) => set("trn", e.target.value)}
            placeholder="15 digits"
            data-testid="registration-trn"
          />
        </Field>
        <Field label="Registered on">
          <input type="date" className="sw-input" value={f.registeredOn} onChange={(e) => set("registeredOn", e.target.value)} />
        </Field>
        <Field label="Returns">
          <select
            className="sw-select"
            value={f.frequency}
            onChange={(e) => set("frequency", e.target.value)}
            data-testid="registration-frequency"
          >
            {FREQUENCIES.map((v) => <option key={v} value={v}>{FREQUENCY_LABEL[v]}</option>)}
          </select>
        </Field>
        <Field label="First period ends in">
          <select
            className="sw-select"
            value={f.firstPeriodEndMonth}
            onChange={(e) => set("firstPeriodEndMonth", e.target.value)}
            data-testid="registration-stagger"
          >
            {MONTHS.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
          </select>
        </Field>
        <Field label="Deregistered on">
          <input type="date" className="sw-input" value={f.deregisteredOn} onChange={(e) => set("deregisteredOn", e.target.value)} />
          <span className="sw-sub mt-1 block">Leave it empty while the registration is live.</span>
        </Field>
      </div>

      <p className="sw-sub mt-3 max-w-[80ch]" data-testid="registration-preview">
        {periodsInWords(f.frequency, month)}, each return due on the 28th day after its period ends (Article 64 of
        the Executive Regulation).
        {f.frequency === "MONTHLY" &&
          " The month chosen makes no difference to a monthly filer — every month ends a period — but it is kept as recorded."}
        {" "}Copy the frequency and the stagger from the certificate rather than from the calendar: they are the
        Authority&rsquo;s assignment, not a derivation.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          aria-disabled={blocker !== null || busy || undefined}
          disabled={blocker !== null || busy}
          data-testid="save-registration"
          onClick={() =>
            onRecord({
              regime: REGIME,
              trn: trn || null,
              frequency: f.frequency,
              firstPeriodEndMonth: month,
              registeredOn: f.registeredOn || null,
              deregisteredOn: f.deregisteredOn || null,
            })
          }
        >
          {busy ? "Recording…" : registration ? "Amend" : "Record"}
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="registration-blocker">{blocker}</span>}
        {!blocker && registration && (
          <span className="sw-sub">
            Amending changes the periods from here on. The returns already recorded as filed are left exactly as they
            are — they were filed for the periods that applied then.
          </span>
        )}
      </div>
    </>
  );
}

function Stat({ label, value, code = false }: { label: string; value: React.ReactNode; code?: boolean }) {
  return (
    <div>
      <div className="sw-label">{label}</div>
      <div className={`mt-0.5 text-[1.0625rem] font-semibold tabular-nums${code ? " sw-code" : ""}`}>{value}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="sw-label">{label}</span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}
