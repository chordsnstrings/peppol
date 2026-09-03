# What the ledger does

A register of what has been built, what each part guarantees, and — as
importantly — what it does not. It is written to be checked rather than
believed: every claim below points at the module that makes it and the test
that holds it.

The counts below are derived, not maintained: `node scripts/capabilities.mjs`
enumerates them from the source, so this section is either right or it is a bug
in that script. A register kept by hand stops agreeing with the code the first
week nobody updates it.

A **capability** is one thing a user or an integration can ask the product to
do, or one guarantee it makes and holds:

| Kind | What it counts | Now |
| --- | --- | --- |
| operation | an exported function in a ledger module — the unit of work | 470 |
| endpoint | an HTTP verb, or a named action within one | 351 |
| rule | a constraint or trigger PostgreSQL enforces itself | 277 |
| screen | a page somebody navigates to | 87 |
| | **capabilities** | **1,185** |
| check | an assertion in the verification suites | 1,806 |

An operation reached over HTTP is counted once as each, because they are
different things: one is what the code can do, the other is what is reachable
over the wire, and a product with the first and not the second has a gap.
Checks are counted apart from capabilities — an assertion is how a capability
is held, not another capability.

Also as at this revision: **70 server modules**, **71 test files**,
**103 database models**, **54 migrations**.

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
| One item at one quantity break cannot be priced twice over the same days | `PriceListEntry_no_overlap`, a gist exclusion |
| Only one default price list may be in force at a time, per kind | `PriceList_one_default_in_force`, a gist exclusion |
| A delivery note cannot be signed for before it has been dispatched | `DeliveryNote_signed_check` |
| A delivered cost with no movement behind it is refused — it could not be traced | `DeliveryNoteLine_movement_check` |
| Time is recorded in minutes, and a day holds no more than 1,440 of them | `TimeEntry_minutes_check` |
| Written-off time has to say why; invoiced time has to name the invoice | `TimeEntry_writeoff_check`, `TimeEntry_invoiced_check` |
| Non-billable time can never be invoiced | `TimeEntry_billable_check` |
| Work in progress is an asset or it is nothing — never a negative | `WipPosting_balance_check` |

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

**Credit control** — limits, holds, dunning and a statement of account that
foots and ties. Exposure is computed from the ledger and the open orders, never
stored, because a stored total drifts the first time somebody posts by hand.

**Price lists** answer one question — what does this item cost this party, in
this quantity, on this date — and answer it with the derivation attached. Two
gist exclusions stop that question ever having two answers. A list in another
currency is refused rather than converted, because a rate chosen there ends up
inside the selling price. What was charged is measured against what the list
says, which is the only way a discount nobody recorded as a discount becomes a
number.

**Delivery notes** sit where the lorry is. Dispatching moves cost out of stock
and nothing else; the revenue stays on the invoice. Delivered-and-not-invoiced
is reported at the order price as a memorandum figure, not posted as accrued
income — whether a delivery satisfies a performance obligation is an IFRS 15
question and it is answered on the revenue screen. Goods coming back are
received at the cost they left at, never at today's average.

**Subscriptions** raise one invoice per scheduled period, held by a unique
index rather than by a check, so an interrupted run can simply be run again.

## Purchases

Payables and ageing; purchase orders, goods receipts and a three-way match with
tolerances; expense claims with UAE input-tax rules; payment runs where
proposing, approving and releasing are three separate permissions because they
are the three hands a payment is meant to pass through. A run posts one entry —
one bank line for the transfer that actually left the account, and a payables
line per bill naming what it settles.

## Cash

**Trade finance** — letters of credit, bank guarantees and trust receipts. A
guarantee that has not been called is not a liability: the obligation depends
on a future event outside the entity's control, so IAS 37.27 disclosed rather
than recognised. The margin the bank holds is an asset and is deliberately not
cash, because it cannot be spent while the facility is open.

**Post-dated cheques** — the normal way a UAE business gets paid — with their
own account outside cash and cash equivalents, because IAS 7.7 wants an
insignificant risk of a change in value and a ninety-day cheque is nothing but
that risk. Taking the cheque discharges the invoice; a bounce puts the customer
back on the same open item rather than on a fresh one that looks new.

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
Stock locations, batches, expiry dates and reorder levels — where a transfer
posts nothing at all, because it changes neither the quantity on hand nor its
cost. Landed cost under IAS 2.10, apportioned per charge on its own basis —
freight by weight, duty by value — with the share of stock already sold going
to cost of sales rather than being loaded onto the units that survive.
Borrowings at amortised cost under IFRS 9, where a flat-rate loan's effective
rate is solved rather than quoted, and the current portion is posted so a
statement can present it. Leases under IFRS 16, with the recognition exemptions disclosed because
an exemption nobody can see is an exemption nobody can audit. Provisions and
contingencies under IAS 37.

## Reports

Statements, cash flow, trial balance, budget and variance, cost centres,
projects, segments under IFRS 8, consolidation, intercompany elimination,
equity and the notes, a cash forecast that says how firm each line is, a report
designer that reports which accounts no row claims, an audit trail, and
analytics — the tests an auditor runs looking for what should not be there.

**Comparatives** put the prior period beside the current one, with common-size
proportions that add up exactly and eleven ratios that each hand back their own
numerator and denominator. A percentage change against a nil or negative base
is left undefined rather than printed: "revenue improved 150%" against a loss
is a sentence with no meaning.

**Cash flow by the direct method** as well as the indirect one, each proved
against the other, with every cash line attributed to the contra accounts of
its own journal entry — and the entries where that attribution had to be
apportioned counted and named rather than hidden.

**A notification centre** that gathers what eight modules already compute,
ranks it, and remembers what has been dealt with. An acknowledgement is keyed
on what makes a finding the same finding, never on its wording, and it lapses
the moment the problem gets worse.

**Timesheets and work in progress** record time in minutes — a quarter of an
hour is 15, and 0.25 of an hour is a float that stops adding up by the third
week — and carry unbilled billable time at what it cost, never at what it will
be billed for. The run measures the movement against what account 1330
actually holds, so running it twice posts once.

## Tax and close

A month-end checklist that separates what would make the closed month *wrong*
from what would merely be better done first, and counts a check that could not
run against closing rather than as a pass. The VAT return, reconciled to both
control accounts. The capital assets scheme under Executive Regulation
Articles 57 and 58, which adjusts input tax over ten years for a building and
five for anything else as actual use turns out differently from what was
expected. The margin scheme, where the tax is 5/105 of the margin and the
invoice shows no tax at all — Executive Regulation Article 43 — and the
liability comes out of the revenue rather than being added to what the customer
pays. Designated zones, which under Article 51 belong on no box of the VAT 201
rather than in the zero-rated box. Corporate tax under
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
- **It does not detect which parties are related** — it records what somebody
  declares. Relatedness is a fact about people and control, and a detector
  would produce a confident, incomplete list whose silence a reader would take
  as a statement. The IAS 24 note therefore reports its own completeness: how
  many counterparties nobody has assessed, which of the five compensation
  categories nobody has answered, and whether anybody has attested to it at
  all.
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
- **A price list never converts a currency.** Which rate — the day's, the
  month's, the one written into the contract? Any answer chosen inside a price
  puts an exchange difference where nobody would find it, so the list says it
  is in the wrong currency and stops.
- **Nothing knows whether expenditure is a capital asset**, what its useful
  life is, or what proportion of its use is taxable. Those are inputs to the
  capital assets scheme, and the screen, the return values and the due list
  each say so. The due list reports a bound — one interval's share — never an
  estimate of the adjustment.
- **A back-dated cheque register is approximate about where a cheque was.**
  With one status and one status date it can tell that a cheque was outstanding
  on a past date but not whether it was in the drawer or with the bank. The
  outstanding total, which is what the reconciliation is against, is exact.
- **The FTA audit file's field names, record letters and date format have not
  been verified** against the FTA's own specification. The figures are derived
  from the ledger; the shape is a reading of the format.
- **Margin-scheme output tax needs the purchase price.** Nothing in the ledger
  holds what a second-hand item cost, so it is an input; without it no tax is
  computed and none is posted, and the invoice says so rather than treating an
  unknown cost as nought.

## How it is checked

`node scripts/verify-all.mjs` runs eight suites against a real server and a
real database:

1. **unit and database** — the test files above, every one against PostgreSQL.
2. **ledger invariants** — the constraints and triggers, attacked directly.
3. **palette contrast** — every colour pair in the stylesheet against WCAG 2.1 AA.
4. **design language** — the rules in `docs/design/swedish-design-language.md`
   that can be asserted from the source: where a colour is allowed to appear,
   what a data surface may look like, whether a screen invented a class, and
   whether any screen formats money itself. It found four real defects the
   first time it ran.
5. **capability count** — the register derived in `scripts/capabilities.mjs`,
   asserted against the target rather than reported. A change that removes
   capabilities fails the build instead of passing quietly.
6. **ledger HTTP** — every route swept: none may answer 5xx, every refusal
   carries a sentence, and not one is readable without a session.
7. **subledgers HTTP** — receivables, payables and the close, end to end.
8. **browser** — a real browser through the real onboarding, keying entries,
   pasting a block, reaching every screen in the navigation, and checking that
   nothing overflows on a phone. It also holds the typography to its own rules:
   every form control on every screen has an accessible name, every figure is
   right-aligned in tabular numerals, and no negative is ever written with a
   minus sign. That last set caught a column heading sitting left-aligned above
   its own right-aligned figures.

A skipped test counts as a failure. The suites had been passing while skipping
every database test, because nothing loaded the environment file — which is the
kind of green that is worse than red.
