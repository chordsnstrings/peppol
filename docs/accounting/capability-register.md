# What the ledger does

A register of what has been built, what each part guarantees, and — as
importantly — what it does not. It is written to be checked rather than
believed: every claim below points at the module that makes it and the test
that holds it.

Counts as at this revision: **54 server modules**, **54 HTTP endpoints**,
**50 screens**, **56 test files** holding **1,156 tests**, **71 database
models**, **40 migrations**.

---

## The rules the database keeps

These are not conventions the application follows. They are constraints and
triggers in PostgreSQL, so they hold against a script, an import, a future
module, and a mistake.

| Rule | Where |
| --- | --- |
| An entry balances, in the transaction currency and in the functional one | deferred constraint trigger, `ledger_core` |
| A posted entry is immutable and cannot be deleted — correction is by reversal | `gl_entry_guard`, allowlist immutability |
| A posted entry never goes back to draft | `gl_entry_guard` status matrix |
| Numbering is gapless, and survives concurrency | `gl_next_number`, one statement, no read-modify-write |
| A control account refuses a manual journal — including via a source changed after the lines were written | `gl_line_guard` and `gl_entry_guard` |
| Nothing posts into a period that is not open; a locked period never reopens | `gl_entry_guard` |
| A document cannot fall due before it is raised | `JournalEntry_due_after_entry_check` |
| A payment run's approver cannot be its preparer | `PaymentRun_separation_check` |
| A contingency carries no balance — that is what makes it a contingency | `Provision_contingency_check` |
| A revaluation's split into equity and profit always adds to the movement | `AssetRevaluation_split_check` |
| Recognised revenue never exceeds what was allocated to the obligation | `PerformanceObligation_recognised_check` |
| Unpaid leave cannot be recorded as paid | `LeaveRecord_unpaid_check` |
| Two annual-leave records for one person cannot overlap, even under a race | `LeaveRecord_no_overlap`, a gist exclusion |
| A revaluation surplus is a credit balance or nothing — a deficit is an expense | `FixedAsset_surplus_check` |

## Recording

- **Journals** — a spreadsheet-style grid that accepts a paste, announces what
  it read, and never posts silently. Every entry drills to its lines and to the
  document behind it.
- **Chart of accounts** — editable, with each rule following from what the
  field means: a name is a label and always editable; a type is frozen once the
  account carries a posting, because changing it rewrites every statement it
  has appeared in; a code changes by renumbering, which keeps the history.
- **Opening balances**, **recurring journals**, **needs attention** — a
  computed list of what the books are waiting for, each row deep-linking to the
  screen that fixes it.
- **Who may do what** — roles and permissions. A workspace with none configured
  behaves exactly as it did before they existed; conflicts of duty are reported
  with a weight rather than silently imposed.

## Sales

Customers with terms, limits and holds; a statement of account that ties to the
receivables control account or says by how much it does not; a dunning list
ordered worst first with the numbers behind each recommendation. Quotations and
sales orders, which reach no ledger — a promise is not a transaction. Revenue
recognition under IFRS 15, which corrects to a target rather than posting
increments, so running it twice posts nothing and running it after a
modification posts the cumulative catch-up.

## Purchases

Payables and ageing; purchase orders, goods receipts and a three-way match with
tolerances; expense claims with UAE input-tax rules; payment runs where
proposing, approving and releasing are three separate permissions because they
are the three hands a payment is meant to pass through. A run posts one entry —
one bank line for the transfer that actually left the account, and a payables
line per bill naming what it settles.

## Cash

Bank reconciliation; statement import that reads MT940, CAMT.053, OFX and
several CSV dialects, refuses a file whose own lines do not foot to its own
closing balance, and refuses to guess a date order it cannot settle. Petty cash
as an imprest float, where cash on hand plus unreimbursed receipts always
equals the float in force. Payroll with WPS output, gratuity under Article 51,
and annual leave with the untaken-leave provision.

## Assets

Fixed assets with depreciation, disposal, and a register that can be drawn at a
date rather than only as it stands. Revaluation and impairment under IAS 16 and
IAS 36, where the split between equity and profit follows that asset's own
history. Inventory at weighted average or FIFO, carried at the lower of cost
and net realisable value — where the allowance is derived rather than
accumulated, which makes the IAS 2.33 ceiling structural instead of a guard.
Leases under IFRS 16, with the recognition exemptions disclosed because an
exemption nobody can see is an exemption nobody can audit. Provisions and
contingencies under IAS 37.

## Reports

Statements, cash flow, trial balance, budget and variance, cost centres,
projects, segments under IFRS 8, consolidation, intercompany elimination,
equity and the notes, a cash forecast that says how firm each line is, a report
designer that reports which accounts no row claims, an audit trail, and
analytics — the tests an auditor runs looking for what should not be there.

## Tax and close

A month-end checklist that separates what would make the closed month *wrong*
from what would merely be better done first, and counts a check that could not
run against closing rather than as a pass. The VAT return, reconciled to both
control accounts. Corporate tax under
Federal Decree-Law 47/2022 with Small Business Relief. Deferred tax under
IAS 12. The FTA audit file. Periods and the year-end close.

---

## What this does not do

Stated because a list of features with no boundary is a list nobody can rely
on.

- **It does not file anything.** The VAT return and the corporate tax
  computation are prepared here; filing happens at the FTA. Nothing in the
  books records that a return was filed, and the period lock is read as a proxy
  for it, which is an inference and is labelled as one.
- **It does not know which parties are related.** Relatedness is a fact about
  people. The shareholder current account is presented as the one balance
  related by construction; everything else needs a person.
- **It does not know UAE tax depreciation.** Federal Decree-Law 47/2022 starts
  from accounting profit and has no separate capital allowance code, so the
  deferred tax module takes the rate as an input and says so.
- **It does not know which stock came from where** in a group, so the
  unrealised-profit elimination takes the quantities as an input.
- **A trial-balance migration brings balances, not history.** The transactions
  behind them, the open items making up receivables and payables, and the fixed
  asset register all have to be loaded separately, and the import screen says
  so before it runs.
- **Benford's law proves nothing.** It is a prompt to look, and the analytics
  module refuses to report a verdict on a population too small to mean
  anything.

## How it is checked

`node scripts/verify-all.mjs` runs six suites against a real server and a real
database:

1. **unit and database** — the test files above, every one against PostgreSQL.
2. **ledger invariants** — the constraints and triggers, attacked directly.
3. **palette contrast** — every colour pair in the stylesheet against WCAG 2.1 AA.
4. **ledger HTTP** — the API, including that an unauthenticated request is refused.
5. **subledgers HTTP** — receivables, payables and the close, end to end.
6. **browser** — a real browser through the real onboarding, keying entries,
   pasting a block, reaching every screen in the navigation, and checking that
   nothing overflows on a phone. It also holds the typography to its own rules:
   every form control on every screen has an accessible name, every figure is
   right-aligned in tabular numerals, and no negative is ever written with a
   minus sign. That last set caught a column heading sitting left-aligned above
   its own right-aligned figures.

A skipped test counts as a failure. The suites had been passing while skipping
every database test, because nothing loaded the environment file — which is the
kind of green that is worse than red.
