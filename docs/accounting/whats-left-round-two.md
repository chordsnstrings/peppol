# What is left — the second survey

The first survey (`whats-left.md`) has been worked through; its own Status
section records what closed. This is a fresh sweep run afterwards, across seven
lenses deliberately different from the first eight: what the first round's own
commits deferred, IFRS and IAS coverage, UAE regulation beyond VAT, concurrency
and data integrity, behaviour at scale, what a user still cannot reach, and the
operational surface.

Everything below was checked against the code as it stands. Where a claim was
raised and did not survive that check, it is listed at the end under "Raised and
refuted" rather than dropped, so nobody spends a day on it twice.

Read the ranking as consequence, not effort. The order is: what the product
tells a user that is not true, then what it cannot do at all, then wrong
figures, then controls that do not hold, then the ways it can post twice, then
where it falls over, then regulation, then everything smaller.

---

## Status

This survey is a snapshot of what was true when it ran. It has since been
worked through, and the sections below are kept exactly as written rather than
edited, for the reason the first survey gives: a description of a defect is the
clearest statement of why the fix is shaped the way it is, and a survey
rewritten to agree with the code is a survey nobody can check.

**Closed.** All nine sections.

§1, the gateway. `LIVE` is refused server-side in the store route that is the
only path persisting an entity, and again in the send pipeline, so an entity
somehow marked live on a simulator gets a refusal rather than a rehearsal
reported as a filing. The mock stamps `simulated` on every outcome it invents
and the flag travels with the event, so the timeline, the notifications and the
status chips all say the same thing. The evidence bundle opens with an
attestation and reports `NOT_TRANSMITTED` for a rehearsal, with the simulator's
own claims quarantined under `simulation`. Retention is stated at seven years
citing Article 56 of FDL 47/2022, and the account reset keeps `Transmission`
rows inside that window unless the caller says in as many words that it is
destroying records.

§2, the subledgers. Posting an invoice, seeing which invoices have reached the
books, recording a receipt, entering and coding a supplier bill, and paying one
are all actions on the screens. The capability register's new join is what
holds this: it reports the endpoints no page, component or hook reaches, it
found exactly the four this section named, and `--check` ratchets the count so
it can fall and cannot rise.

§3, the wrong figures. The general ledger reports the account's balance from an
aggregate over every matching line, pages from the newest end, opens at the
balance brought forward and says when it is truncated. Trade finance posts in
the facility's currency at a rate looked up the way revaluation looks one up,
refused outright when there is none. The IFRS 9 provision matrix posts the
movement onto 1150 and the policy note says what is true. The lease liability's
twelve-month portion is posted onto 2460 the way borrowings' is onto 2450.
Deferred tax is classified from the chart's own hierarchy rather than the code
band. The balance sheet has its IAS 1.60 split with net current assets. The
consolidation caveats are unconditional. The payables maturity table is cut on
`dueDate`, with the past-due ageing kept beside it as the different report it
is. A subscription's billed total is a `groupBy`.

§4, the controls. The approval queue is seeded from the open registers, so
writing the rule the screen invites no longer makes bills permanently
unpostable. Candidates come from open subjects rather than from the oldest
5,000 decisions. `subjectFacts` resolves all five subject types, so a decision
is guarded and recorded against the entity on the subject rather than the one
the client named. The self-approval bar reaches every type. Eleven new
permission keys, ten routes re-keyed, `fx.rate` separated from `ledger.post`
and reported as a conflict with proposing a payment run. Roles are editable.
The credit gate binds at finalisation and in the send pipeline. And there is a
test that runs a guard in its enforcing state, which no test had ever done.

§5, posting twice. `reverse()` is keyed and transactional; the manual journal
is keyed on a token minted when the form opens; a payroll month accepts a late
payslip as its own keyed supplement and pays it; inventory increments inside a
transaction; a cheque's transitions are conditional on the status they leave; a
payment run re-reads the ageing at release; petty cash resolves an instant to
the business day at UTC+4, which is what stopped the month-end refusal.

§6, scale. The bind lists are chunked at 5,000 and the ledger reads bounded;
`reconcile` is split into a summary and an itemised page, and both loop callers
read the summary's real count rather than the page's length; `grniReport` asks
about open orders; `openItemsOf` buckets once; `ledgerBalances` and
`trialBalance` sum in the database.

§7, regulation. Both parties' addresses, the AED tax figure and the
reverse-charge statement are on the document and in the UBL, computed once so
the two cannot disagree; the credit note is a credit note. There is a corner 4.
Retention is seven years. The mandatory-registration threshold is watched on
the rolling twelve months the law uses, and the statutory reserve under CCL
Article 103 is computed.

§8, unreachable. Every operation this section named is reachable, and the
register's join is what will notice the next one that is not.

§9, operational. `TRUSTED_PROXY_HOPS` is documented, the nine suites run in CI,
`parseCsv` has a test, `itemHistory` and `priceListRegister` behave, the equity
page renders whatever the server sends, and the capability register joins its
lists.

**What this left behind.** The work generated its own tail — a count that
became a page size when a read was bounded, an AED figure that reached only the
document computing it, a store route with no sanitizer for the inbound records
corner 4 had just started writing, `todayISO()` returning UTC under a comment
claiming local. Those are closed too, and they are the argument for the join
and the ratchet: the register now reports the shape of gap that produced this
survey, so the next one can be found by running a command rather than by
reading the product for a day.

---

## 1. It can tell a business the FTA accepted an invoice that never left the machine

`getGateway()` returns `mockGateway` unless `GATEWAY_DRIVER=taxilla` **and**
`TAXILLA_BASE_URL` are set (`src/lib/gateway/registry.ts:10-13`). The mock
fabricates terminal success on both legs — exchange accepted, C2 reporting
accepted (`src/lib/gateway/mock-gateway.ts:34-41`) — and `applyGatewayEvents`
reads that as `COMPLETED`.

Nothing in the send path consults `gatewayIsLive()`. That function exists
(`registry.ts:17`) and is called by one health endpoint and nowhere else. Going
live is instead two self-attested checkboxes on the dashboard, after which
`goLive()` writes `einvoicingStatus: "LIVE"` and announces "Real invoices will
transmit across the Peppol network"
(`src/app/(app)/dashboard/activation-card.tsx:46-55`). The sandbox banner then
disappears from the invoice editor, and the send pipeline notifies
"delivered & reported — Exchange and FTA reporting both succeeded"
(`src/lib/server/send.ts:142-144`). The evidence bundle a user is told to hand
to an FTA auditor asserts `transmitted: true`, `DELIVERED`, `ACCEPTED`, read off
the mock's own row (`src/app/api/invoices/[id]/evidence/route.ts:51-53`).

There is exactly one honest string in the whole path: the timeline's
*submission* event appends "(sandbox)" (`send.ts:125`). The acceptance line, the
notification, the status chips and the evidence bundle do not.

Under the DCTCE mandate an unreported tax data document is a penalty the user
has no signal about. **The fix is an interlock, not a feature: `LIVE` must be
unreachable while `gatewayIsLive()` is false, and the evidence bundle must
refuse to assert transmission it cannot prove.** One condition, one guard.

---

## 2. The sales and purchase ledgers cannot be fed from any screen

`postInvoice`, `postReceipt`, `postBill` and `postSupplierPayment` are complete,
tested, routed at `/api/ledger/ar/post` and `/api/ledger/ap/post` — and **no
screen calls them**. Grepping every `/api/ledger/...` literal under
`src/app/(app)` and `src/components` returns no hit for either route; the only
non-route consumers of the functions themselves are `payment-runs.ts` (which
posts its own batch entry) and `subscriptions.ts:421` (`issueDue`).

So the daily loop an accounting product exists for — raise an invoice, post it,
receive against it, enter a supplier bill, pay it — is reachable only through
the API or a subscription schedule. And the manual-journal escape is closed on
purpose: `post()` refuses a control account on `source: "manual"`
(`src/lib/server/ledger/post.ts:282`) with "Raise the underlying document
instead of a manual journal."

Everything downstream is therefore fed by nothing: the ageing, the statements,
the VAT return, credit control, the trial balance. The receivables screen is a
read-only ageing whose empty state reads "Every invoice raised has been settled"
— which is also what an empty ledger looks like.

**Fix: a "Post to the ledger" action on a finalised invoice, and a "Record a
receipt" row action on Receivables; the same pair on the purchase side.** Four
controls. This is the largest functional gap in the product and it is not large
work.

---

## 3. Wrong figures on statements somebody reads

**The general ledger's "Closing balance" is the balance as at the 200th
posting.** `generalLedger` takes `limit ?? 500` lines oldest-first and computes
the running total from zero with no `truncated` flag
(`src/lib/server/ledger/reports.ts:120-129`); the route defaults `limit` to 200
(`src/app/api/ledger/accounts/[code]/route.ts:26`); the screen labels the last
row's running total "Closing balance"
(`src/app/(app)/accounting/accounts/[code]/page.tsx:35,108`). The bank account,
1100, 4000 and 2000 all cross 200 lines inside the first year. Second defect in
the same function: with a date range set, the running balance still starts at
zero rather than at the opening balance. **Fix: a `truncated` flag, an
`aggregate` for the closing figure, and page from the newest end.**

**Trade finance records a currency and then posts as though everything were
dirhams.** `openFacility` validates and stores `currency`
(`src/lib/server/ledger/trade-finance.ts:144-155`) and the screen parses amounts
at that currency's exponent — but every `post()` call in the module passes lines
with no `currency` and no `fxRate` (`:163-181`, `:281-296`, `:347-357`, `:408`),
and `post()` then treats the line as functional at rate 1
(`post.ts:266-267`). A USD 100,000 import LC with a 10% margin debits restricted
cash and credits the bank with **AED 100,000** instead of about AED 36,725 —
cash the entity never paid and restricted cash it does not hold. A KWD facility
is out by a further factor of ten on the exponent. The IAS 37 note beside it
labels the exposure in the facility's real currency, so the note and the balance
sheet disagree and nothing reconciles them. **Fix: pass `currency`/`fxRate` on
those lines, plus a rate lookup.**

**No allowance for doubtful debts is ever raised, and the policy note asserts
the standard that requires one.** Account 1150 is seeded and read in three
places, and no code path credits it — `write-offs.ts` only ever debits it
(`:501`), and its own test raises the allowance with a hand-keyed manual
journal. There is no provision matrix and no simplified-approach ECL, so trade
receivables are carried gross and profit is overstated by the whole
unrecognised allowance. The accounting policy note then prints "Trade
receivables are stated at the amount invoiced. No allowance for doubtful debts
has been recognised" under `basis: "IFRS 9.5.5.15"`
(`src/lib/server/ledger/equity.ts:1194-1200`) — the paragraph that makes a
lifetime ECL allowance mandatory. The note asserts compliance while describing
its absence. **Fix: a provision-matrix module feeding a posted allowance; the
ageing bands and the write-off consumer already exist.**

**The whole lease liability is non-current, forever.** Account 2600 sits in the
2500–2999 band every classifier reads as non-current, and nothing reclassifies
the twelve-month portion — `leases.ts` contains no "current" logic at all.
`borrowings.ts:872-1050` does exactly this job correctly, posts rather than
notes it, and writes down why. A five-year AED 500k/yr lease puts about AED 420k
in the wrong bucket and inflates the current ratio. **Fix: a 2650 account and a
copy of `reclassifyCurrentPortion`.**

**Deferred tax is classified as current.** 1320 and 2320 are seeded under
non-current parents and `deferred-tax.ts:110` says IAS 1.56 requires it — but
`kpi.ts:83-86` and `layouts.ts:794-801` classify on the code band, so both land
in current. The `unclassified` warning cannot fire because both codes match a
band. It feeds the current ratio, the quick ratio and working capital. **Fix: a
renumber plus a migration, or band-aware exceptions.**

**Consolidation double-counts the investment and grosses up intragroup trade,
silently.** The module states in a comment that it eliminates neither
(`consolidation.ts:52-60`), but the warnings the screen renders cover only a
partly-owned parent, a currency mismatch and an unbalanced member — and the
panel is conditional on there being any, so an AED-parent/AED-subsidiary group
(the common UAE structure) sees no caveat at all. `intercompany.ts` already
computes the elimination schedule and it is never fed back. **Fix: make the two
caveats unconditional — small. Real IFRS 3 acquisition accounting is large and
separate.**

**The balance sheet has no current/non-current split.** Three flat sections, no
subtotals, no net current assets (`statements.ts:366-418`). The classification
exists in the chart's parent hierarchy and in the code bands and reaches neither
statement. Note this compounds the two findings above: adding the split without
fixing them makes two wrong numbers visible. **Fix: medium.**

**A payables "maturity" table that is a past-due ageing.** Both ageings are
presented under `basis: "IFRS 7.35, IFRS 7.39"` with bands like "Not more than
30 days" (`equity.ts:1706`), but `payablesAgeing` buckets on days since the bill
was *raised* (`ap.ts:401-410`), not days to maturity. A reader takes the
entity's short-term liquidity exactly backwards. The `dueDate` is captured per
document and unused. **Fix: small — re-cut the bands on `dueDate`.**

**A subscription's `billedMinor` is the sum of its last six invoices.**
`subscriptionRegister` takes `issued: { take: 6 }` and reduces it
(`subscriptions.ts:473,491`) beside `issuedCount`, which is the true counter. At
seven invoices the API answers "48 issued, AED 30,000 billed" against a real AED
240,000. The screen renders the count and not the amount, so today this is wrong
only for API consumers. **Fix: a `groupBy` with `_sum`.**

---

## 4. Controls that do not hold

**Writing a supplier-bill approval rule makes bills permanently unpostable.**
This is a regression introduced by wiring `assertApproved` into the posting
paths. `pendingFor` seeds the queue from submitted expense claims plus subjects
that *already carry a decision* (`approvals.ts:1130-1155`), and the only screen
that records a decision is the queue itself. A bill can therefore enter the
queue only if it is already in it. An organisation that writes the rule the
screen invites — "every supplier bill needs one signature" — stops being able to
post bills at all, and the month-end stops with it. Before the guard was wired
that configuration was decorative; now it is destructive. **Fix first: seed the
queue from the bill, payment and payroll registers, or give each subledger
screen its own approve control.**

**The approval queue stops showing new work at 5,000 lifetime decisions.**
`pendingFor` reads `approvalDecision` with `take: 5000` ordered `decidedAt asc`
and no open/closed filter (`approvals.ts:1104-1107`); for every subject type but
an expense claim the candidate set is derived entirely from those rows. Past
5,000 the oldest are kept and nothing recent can enter. Two approvers at ~100
documents a month reach it in about two years, and the control then silently
stops working. **Fix: derive candidates from open subjects and order `desc`.**

**Decisions on a bill, journal, payment or payroll are guarded against the
entity the client named.** `subjectFacts` resolves only `EXPENSE_CLAIM`
(`src/app/api/ledger/approvals/route.ts:24-25`), so `decide` guards on
`facts?.entityId ?? b.entityId` and records the decision under that same
client-chosen entity; `withdraw` falls back to org-wide. The decisions are then
read back org-wide at posting time. Somebody holding `expense.approve` on entity
A can approve — and un-approve — a payroll run in entity B, and if they are a
director on A they satisfy B's two-director rule. This is the same cross-entity
hole closed everywhere else in commit `4a0206d`. **Fix: one `subjectEntity()`
helper covering all five types.**

**The self-approval bar operates only on an expense claim.** `decide` refuses
self-approval only when `submittedBy` is supplied (`approvals.ts:872`), and the
route supplies it only from `subjectFacts` — null for every other subject. The
module header calls this "the one thing here that is not negotiable". Under the
shipped roles nobody holds both `ap.manage` and `expense.approve`, so it is not
reachable out of the box; a custom "office manager" role holding both is the
obvious thing a small business writes, and that pair is not in `CONFLICTS`
either, so it is not even reported. **Fix: carry the raiser onto the subject,
plus one `CONFLICTS` entry.**

**Writing an FX rate moves approval thresholds.** `set-rate` is guarded by
`ledger.post` (`src/app/api/ledger/revaluation/route.ts:74`);
`convertForThresholds` reads the latest rate to compute the figure thresholds
are tested against (`approvals.ts:655-658`). A low EUR rate drops a foreign bill
out of the band that would have demanded a second director — and the shipped
Bookkeeper and Accountant both hold `ledger.post` *and* `payment_run.propose`,
so the person proposing the payment can move the limit governing it. **Fix: a
distinct `fx.rate` key, or refuse a rate that would revalue an existing
decision.**

**A Viewer can clear findings off everybody's queue.** `POST
/api/ledger/notifications` — acknowledge, snooze, clear — is guarded by
`ledger.read`, the key the shipped Viewer holds and whose description is "reads
the books and changes nothing". `NotificationAck` is a shared upsert. Blockers
are exempt, so covenant breaches are safe; VAT deadlines and register mismatches
are not. `verify-permissions.mjs` cannot catch this: it asserts only that a
mutating route calls *some* guard. **Fix: a `notifications.manage` key.**

**Ten acts borrow a permission key that does not describe them**, each said
plainly in the source: approving a journal or bill under `expense.approve`,
notifications under `ledger.read`, consolidation membership under
`setup.manage`, inventory master data under `ledger.post`, a three-way-match
override under `ap.manage`, a project under `chart.edit`, a leave record under
`payroll.run`, related-party disclosure and timesheet entry and attachments
under `ledger.post`. **Fix: seven new keys, a catalogue edit and a migration for
existing roles.**

**Three narrower cross-entity holes.** The expenses POST passes `b.entityId`,
which only `create` supplies, so approve/post/pay resolve org-wide
(`src/app/api/ledger/expenses/route.ts:86`) — four lines to fix, the GET two
functions above already does it right. `layouts` `duplicate` guards the source
and writes to `toEntityId` unchecked (`:102,122`) — one line. The attachments
POST guards a client-named entity while GET and DELETE correctly read it off the
row (`attachments/route.ts:109` against `:59,161`) — one lookup.

**The credit gate binds only on the sales-order path.** `creditCheck` has one
enforcing call site, `creditGate` in `sales-orders.ts:698`. An invoice raised
any other way is never checked, and `postInvoice` deliberately does not check
(correctly, and the reasoning is written down). For a business that does not use
sales orders, the gate does not exist. **Fix: call it at invoice finalisation.**

**No test has ever executed a permission guard in its enforcing state.** There
*are* three route-level harnesses — the two HTTP suites and the browser suite —
but each registers exactly one user, and a workspace with no `RoleAssignment`
rows short-circuits to "allowed". `test/ledger-permissions.test.ts:277-285` says
so about itself. **Fix: one HTTP fixture that seeds roles and a second user.**

---

## 5. Ways to post twice, and to lose an update

**`reverse()` passes no `externalKey`, and nothing else stops a second
reversal.** It reads the original, checks `status === "posted"`, posts the
mirror, and only then marks the original reversed — outside any transaction
(`post.ts:357-428`). There is no unique index on `reversalOfId`, and the
immutability trigger permits `reversed → reversed` because that is not a status
change. Two clicks on Reverse post two mirrors and the entry is applied *minus
once* instead of zero. The balance cache records the same wrong figure, so the
trial balance still ties. **Fix: an `externalKey` of `reversal:${entryId}` — one
line.**

**The manual journal route passes no `externalKey`.** Of 63 `post()` call sites
these two are the only ones without a key; every subledger path is keyed on
document identity and genuinely retry-safe. A double-submitted form or a browser
retry after a slow post makes two identical balanced entries with two gapless
numbers, and nothing can distinguish that from two legitimate journals. This is
the most likely wrong number in the system because it needs no second user.
**Fix: key it on a client-supplied idempotency token.**

**Every inventory movement writes an absolute quantity from a read taken outside
the transaction.** `issue`, `receive` and `adjust` load the item, compute
`newQty`/`newValue`, post, then `update({ data: { quantityMilli, valueMinor } })`
— a SET, not an increment (`inventory.ts:955-959`). Two clerks issuing from one
SKU both post real COGS entries and the item card ends at one of the two values,
so the stock ledger and account 1200 disagree permanently while the journal
still balances. Worse with equal quantities: both compute the same `newQty`, so
`balanceKey()` produces the same `externalKey`, the second issue never posts, and
two movements point at one entry — two despatches, one COGS charge. **Fix:
`$transaction` around the read and the write, or an increment.**

**A trade facility can be drawn past its face value.** `drawFacility` reads
`drawnMinor`, checks the total against the face, posts, then SETs `drawnMinor`
from the stale read with no transaction at all
(`trade-finance.ts:232-300`). Two concurrent drawings on a 1,000,000 LC of
700,000 and 600,000 both pass the check and both post. Equal amounts collide on
the `externalKey` instead, giving two register events against one journal, after
which `settleFacility` sizes a settlement off the doubled register.

**A cheque can be cleared and bounced at the same time.** Both transitions are
legal from `held`, both are checked in application code against a row read
earlier, and both write `where: { id }` rather than `where: { id, status }`
(`cheques.ts:703,763`). The keys differ, so both entries post: the bank is
debited and the receivable reinstated for the same cheque, and cheques-in-hand
ends at a credit balance. The same-action double-click is safe; it is the two
different legal transitions that get through.

**A payroll period is sealed by the first post.** `postPayroll` keys on the
period and returns early if that entry exists, then posts the drafts it read
(`payroll.ts:1003-1017`). A payslip that reaches draft afterwards is stranded:
the next call hits the early return and reports a gross that *includes* the
employee the ledger never received, and `payPayroll` reads only posted payslips
so they are never paid. Salaries payable is understated with no error anywhere.

**A bill can sit on two payment runs.** The exclusion of already-claimed bills is
an unlocked read with no unique index behind it (`payment-runs.ts:400-408`).
Separately and more likely: `releaseRun` never re-reads the ageing, so a bill
paid directly after Monday's run was proposed is paid again when that run is
released on Wednesday.

**The ledger runs on UTC and the users are at UTC+4.** Three petty-cash paths
default to a raw `new Date()` (`petty-cash.ts:365,602,745`). Because entry dates
and period bounds are `@db.Date`, a timestamp at 21:00 UTC on the last day of a
period matches no period at all and the posting is refused outright — on the
busiest day of the month. And between 00:00 and 03:59 Dubai time, `new Date()`
is still yesterday, so a reimbursement at 01:00 on 1 July is dated 30 June, in
the previous VAT quarter. `cheques.ts` normalises to UTC midnight, which fixes
the refusal and keeps the off-by-a-day.

---

## 6. Where it falls over, or gets slow

**Three reads pass a bind list of every AR document ever raised.**
`counterparties.ts:659`, `credit-control.ts:284` and `faf.ts:298` each do
`id: { in: ids }` where `ids` comes from an unbounded read of the AR control
account with no lower date bound. PostgreSQL refuses past 65,535 binds — about
1,100 sales documents a month for five years — and it takes down the customer
statement, credit control and the FTA audit file. `exports.ts:390-398` already
solved this with a 5,000-id chunk. **Fix: chunk, and bound the ledger read.**

**`reconcile` reads the entire life of a bank account and returns all of it.**
No `take`, no lower bound, an `in` over matched lines, and the full matched and
unmatched lists in the response (`bank.ts:443-485`). At 2,000 transactions a
month that is ~120,000 rows each after five years. It is called in loops from
`attention.ts:303` and `month-end.ts:395-407`, and the notification centre
triggers both.

**`grniReport` loads every purchase order ever, with lines, receipts and receipt
lines, on a dashboard** (`procurement.ts:1257`), and returns them all.

**`stockValuation` at a past date reads every movement ever to keep the last one
per SKU** (`inventory.ts:1237`), passing the full SKU list as an `in` twice.

**One notification-centre load reads the AR control account three times.** Twelve
sources fan out; `attentionList` runs both ageings, `monthEnd` runs both again,
`dunningPlan` does its own full AR read, plus `ledgerAnalytics` pulling 10,000
entries with their lines, `grniReport`, and `reconcile` per bank account twice.
Well over a hundred queries per page load.

**The customers screen is O(customers × lifetime documents) in JavaScript.**
`openItemsOf` walks the whole document map once per party
(`counterparties.ts:690`); 1,000 customers against 100,000 documents is 100
million comparisons on the event loop. **Fix: bucket by `partyId` once — two
lines.**

**Smaller, same family.** `ledgerBalances` sums every line ever posted to an
account in JavaScript (`balances.ts:46-53`) and is the primitive behind ten
reconciliations — a `groupBy` with `_sum` is identical semantics and one row.
`trialBalance` sums the whole balance cache in JS. The VAT return reads every
line in the quarter and discards most, with an existing `taxCode` index unused.
`claimList` loads every claim ever so `attention.ts` can read a summary that a
different query already computed. And `BankStatementLine`'s only index leads with
`entityId`, which `reconcile` does not filter on, so only the `orgId` prefix is
usable.

---

## 7. UAE regulation

**The tax invoice is missing three Article 59 particulars**, and this bites now,
independently of the e-invoicing mandate. The supplier's address is collected at
onboarding and never rendered (`src/components/invoice/invoice-preview.tsx:20-33`)
— ER Article 59(1)(b)-(c) requires the address of both parties. A
foreign-currency invoice never shows the tax in AED: `vatMinorAED` and
`payableMinorAED` are declared (`src/lib/domain/types.ts:152-153`) and computed
nowhere, so the document prints the CBUAE rate with no AED figure after it,
against Article 69 and ER 59(1)(k). And there is no reverse-charge statement
anywhere — the profile exists and the document renders a bare "VAT 0%" row,
against ER 59(1)(l). Each makes it an incorrect tax document.

**The generated PINT AE UBL would not validate, and a credit note is not
schema-valid.** `generateUBL` omits `cac:PostalAddress` for both parties
(`src/lib/domain/ubl.ts:77-93`), failing BR-08/09/10 on every document; drops the
line-level exemption reason that validation collects; and emits
`cbc:TaxCurrencyCode` with no second `cac:TaxTotal`, a direct BR-53 failure — the
same missing AED number as above, in the machine-readable copy. A credit note is
built by swapping the root element only, so it keeps `cbc:InvoiceTypeCode` and
`cac:InvoiceLine` inside a `CreditNote-2` root and fails the XSD before
schematron is reached, and it never emits the `cac:BillingReference` that
`precedingInvoices` exists to supply. No test exercises `generateUBL` or
`buildTDD` at all, which is why none of this is caught.

**There is no corner 4.** `GatewayEvent` has three variants, all status
(`src/lib/gateway/port.ts:41-44`), and the webhook drops anything without a
matching transmission the org itself sent. `InboundDoc` is defined and the inbox
reads it; nothing anywhere writes one. Under the five-corner model every
mandated business must be reachable and must accept or reject what arrives. The
product is C1 with a port to C2 and no C4.

**Retention is stated once, at five years, and is wrong for corporate tax.** The
only statement is a field on the evidence manifest
(`src/app/api/invoices/[id]/evidence/route.ts:54`); Article 56 of FDL 47/2022
requires seven years for CT records. Meanwhile `/api/account/reset` hard-deletes
every `Transmission` row — the only home of `ublXml` and `tddXml` — with no
retention interlock.

**Two watches worth adding.** Nothing warns as rolling turnover approaches the
AED 375,000 mandatory VAT registration threshold, though the corporate tax
module already warns at 90% of the Small Business Relief ceiling — the product
has proved it will watch a threshold and watches the wrong one first. And
nothing computes the Commercial Companies Law statutory reserve (10% of profit
to a 50%-of-capital ceiling); account 3200 is seeded and the transfer is
reported correctly when somebody makes it, but nothing prompts.

---

## 8. What a user still cannot reach

Beyond §2, which is the large one:

- **A VAT registration and a filed return cannot be recorded**, though the VAT
  screen tells the user to do both and the "Filed" chip can never turn green.
  `recordRegistration` and `recordFiling` are routed and called by nothing.
- **A rejected document can never be unblocked.** `withdraw` is routed; no
  screen sends it; four places tell the user to use it, including the blocker
  the approvals gate returns on every posting path.
- **A customer record is write-once.** `update` and `restore` are routed and
  unsent; there is no archived view. A mistyped TRN is permanent, and two
  refusals name operations with no control.
- **A recurring journal template cannot be edited, paused or stopped.** All four
  actions are routed; the table has no actions column. A rent accrual keeps
  posting after the lease ends.
- **A fixed asset cannot be disposed of.** `disposeAsset` is routed and unsent;
  a sold van depreciates forever.
- **An expense claim sent back to draft cannot be fixed** — there is no claim
  detail view at all, though the rejection dialog says it can be.
- **A quotation or sales order cannot be edited**, forcing cancel-and-rekey.
- **The bad-debt write-off screen is in no menu** — one nav entry.
- Smaller: a role's permissions cannot be changed after creation; a project's
  budget cannot be revised; the IFRS 15.116-120 contract-balance disclosures
  have no route; the cheque screen has no currency field, so the server's
  foreign-cheque path is unreachable.

---

## 9. Smaller, and operational

- **`TRUSTED_PROXY_HOPS` is undocumented.** It is absent from `.env.example` and
  decides how far from the right of `X-Forwarded-For` to count. A deployer
  behind a load balancer has no way to know it exists, and the rate limiter is
  either bypassable or over-strict without it.
- **Nothing runs the verification suites automatically.** Nine suites, 2,030
  checks, no `.github/workflows` at all.
- **`parseCsv` has no test**, and it is the reader behind both the FTA audit
  file and the ledger export's own verification. It is correct as written; a
  future edit breaks the round trip silently.
- **`itemHistory` shows the oldest 200 movements under a header carrying the
  current quantity and value**, with no `truncated` flag — misleading rather
  than wrong.
- **`priceListRegister` with an unknown list code lists every list's prices**
  rather than refusing. Unreachable from the screen; an API caller hits it.
- **The equity page mirrors the note union by hand**, so a note added on the
  server renders as a bare heading. The crash this used to cause is fixed; the
  silent omission is not.
- **`docs/accounting/capabilities.tsv` counts operations, endpoints and screens
  as three lists with no join**, which is structurally why a screen can be
  missing for an endpoint that is otherwise complete and tested.

---

## Raised and refuted

- **`postInvoice` not consulting credit control** is a stated decision with its
  reasoning written down in `credit-control.ts:1021-1031`. The live gap is that
  `creditGate` binds only on the sales-order path, which is §4.
- **A trade facility drawn past expiry** — fixed in `47c3a96`.
- **An account opened on hold not being on hold** — fixed; `createCounterparty`
  now writes the `CreditHold` row.
- **The `partyKey` case-folding split across three modules** — real
  inconsistency, no live defect: `resolveParty` matches case-insensitively and
  canonicalises afterwards.
- **The approvals API taking `amountMinor` from the client** — literally true and
  contained: every posting path recomputes the real figure server-side and
  `computeState` discards a decision whose amount differs, so a fabricated
  amount makes the signature count for nothing rather than letting something
  through. Cosmetic.
- **The `AccountBalance` cache** is maintained only inside the posting
  transaction via an `upsert` with `{ increment }` against a unique key. Two
  entries either serialise or roll back; there is no torn increment.
- **Approvals' own double-decision path**, petty-cash movements, asset
  revaluation, provisions and credit holds are all protected by unique indexes
  with the pre-check kept only for the message — the model the inventory and
  trade-finance paths should copy.
- **Landed cost apportionment** uses largest-remainder and the shares add to the
  charge exactly; **`post.ts` is bigint end to end** and no `Number()` reaches a
  minor-unit value on a write path.
- **The year-end close** cannot let an ordinary posting slip into the reopened
  adjustment period: the period lookup lands on the hard-closed trading month
  first and refuses.
- **IAS 33 EPS**, **IAS 36 cash-generating units** and **IAS 21 foreign-operation
  translation** are correct omissions for this product today — the first does not
  apply to a private LLC, and the other two only become real after indefinite-life
  intangibles and IFRS 3 acquisition accounting respectively.
- **ESR, the UBO register and goAML** are not an accounting ledger's job. The one
  edge worth telling a user about rather than building: a DNFBP must report a
  cash transaction at or above AED 55,000, and this product handles cash.
- **Bank statement parsing** is genuinely complete — MT940, CAMT.053, OFX and CSV
  with dialect and date-order detection, and a refusal when the file does not
  foot to its own closing balance.
- **Qualifying Free Zone Person** is explicitly out of scope and says so on
  screen, which is the right place for it.
