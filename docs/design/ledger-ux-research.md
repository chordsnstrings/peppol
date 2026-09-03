## 0. What I studied and what each product actually taught us

| Product | The transferable behaviour |
|---|---|
| **Fortnox** (SE) | On the last entry line, **Tab/Enter auto-calculates the balancing amount** into the correct column. Difference between Debet and Kredit sits permanently at the bottom of the voucher. Header-level `Kostnadsställe` / `Projekt` inherit to lines; per-line `KS`/`PR` columns override. Live **account balance shown at the far right** of each entry row. `Ändringsverifikation` creates a linked offsetting voucher — original never disappears. `Radera` only works on the *last* voucher in a series. |
| **Bokio** (SE) | Manual entry searches **account number and account name in one field**. You cannot pick an account that is not in the chart of accounts — no free text. Inline calculator (`20-8` → `12`). Hard gate: "Ett verifikat måste balansera i Debet och Kredit för att kunna bokföras." Two-step commit: `Granska och Bokför` → preview → `Bokför`. Their own post-mortem: the multi-row entry UX was their worst screen and the account boxes were too narrow. |
| **Xero** | Calculator in every Debit/Credit field (`+ - * / ()`, evaluate on Enter/Tab). Date shortcuts (`t`, `+7`, `-1`, `next fri`). `/` opens quick-find. Reconcile screen = **two columns, bank line left (immutable), proposed match right**, tabs Reconcile / Cash coding / Bank statements / Account transactions, plus Find & Match, Split, Transfer, Discuss, Bank rules. |
| **QuickBooks Online / Zoho** | The failure mode to avoid: "The Debits and Credits do not match" thrown *after* submit. |
| **Sage Intacct** | **Dimensions, not account segments.** Eight dimensions tag transactions independently of the code, so the chart of accounts stays lean. Their documented risk: ad-hoc account creation reintroduces bloat. |
| **NetSuite** | Period Close Checklist as the period page: ordered tasks, four states (not started / in progress / done / **locked-with-prerequisite**), "Modified By" column, per-module locks (A/R, A/P, Payroll) as a **pre-closed state**, prior periods must close first, `Override Period Restrictions` as an explicit permission. |
| **Odoo** | Every account is `Code` + `Account Name`; import/export round-trip through spreadsheet is a first-class path. |
| **Modern Treasury** | Posted entries can't be deleted or overwritten. Pending / posted / available are three distinct balances computed from the same rows. |
| **Ramp** | The dashboard shows *work remaining*, not charts. Right-aligned tabular figures, hairline-ruled tables rather than rounded cards, drill-downs that never lose your place. |

---

## 1. The Swedish direction, translated into build decisions

Not mood — five specific references, each with a rule attached.

**`acceptera` (Asplund, Markelius, Åhrén, Paulsson, Gahn, Sundahl, 1931)** — the manifesto of *funkis*, written out of the 1930 Stockholm Exhibition: accept the machine, the standard, the series. **→ The grid is the design.** Ledger surfaces get `border-radius: 0`, no card wrappers, no shadows, no gradient. Rounded corners and elevation stay in the marketing shell and in dialogs; a table of figures is a machine part.

**Ellen Key, *Skönhet för alla* (1899)** — beauty for everyone, not just the wealthy. **→ One screen for the bookkeeper and the owner.** Role changes defaults, vocabulary and which columns are pre-filled — never the layout. Ship a "plain language" toggle that relabels Debit/Credit to *Money in / Money out* per account type, while every column stays in the same place, so an owner and their accountant can point at the same pixel on a call.

**Sigurd Lewerentz at Klippan** — the joints are the ornament. **→ Hairlines are visible and exactly 1px**, never 0.5px blur, never invisible. Rules do the work zebra striping usually does badly.

**Josef Frank's objection** — pure functionalism goes dowdy. **→ Exactly one warm element**: the paper-tinted ground (`40 30% 98%`, not `0 0% 100%`) and the Swedish yellow used *only* as the unposted-document marker — a direct nod to Fortnox's *gula bildmodalen*.

**NCS (Natural Colour System, Swedish Standard SS 019100)** — **→ the palette's source of truth is NCS notation**, hex/HSL derived. Swedish flag blue `NCS 4055-R95B` for interaction and drill-down; flag yellow `NCS 0580-Y10R` for drafts; **Falu red** reserved exclusively for *does not balance* and destructive refusal. Faluröd is the most Swedish colour there is, so spend it on the one thing that must never be ignored. Spruce green for *balanced / reconciled*. Five hues, total.

**Sweden Sans (Söderhavet, 2013)** — commissioned from old Swedish signage; *modern but humble*. **→** UI face stays Inter (already configured with `cv02 cv03 cv04 ss01`), which is the same humanist-grotesque register. **Berling Antikva** (Karl-Erik Forsberg, 1951) is the right face for *exported/printed* statements only — never in the on-screen grid.

**Lagom** — **→ one density.** No "compact/comfortable" toggle. 28px ledger rows, with a single ±2px user nudge and nothing more.

---

## 2. Data density, figures, and the numeric contract

```
--row-h-head    30px   column headers
--row-h-dense   28px   trial balance, GL, chart of accounts, journal list
--row-h-entry   34px   journal grid (has comboboxes)
--row-h-bank    56px   bank reconciliation (two-line left column)
font: 13px / 1.15   figures and body
       11px / 1.2  column headers, uppercase, ls .06em, muted
cell padding-x: 10px · lead column 14px · numeric column padding-right 12px
--col-w-code   4.5rem  (fits 4-digit + 2-char sub)
--col-w-amount 8.75rem (fits 999 999 999,00)
```

**Numerals.** `font-variant-numeric: tabular-nums lining-nums` on every figure, without exception. Account-code columns additionally get `font-feature-settings: "zero" 1` (slashed zero) — `1030` vs `1O30` is a real support ticket.

**Negatives — the ruling.**
- *Statements* (BS, P&L, trial balance, any printed artefact): **parentheses, no colour, no minus.** `(1,250.00)`.
- *Transaction lists and running balances*, where sign flips are ordinary: **U+2212 MINUS SIGN** (not a hyphen), colour permitted as a **secondary** cue only.
- **Never colour alone** (WCAG 1.4.1) — a red figure with no sign glyph is a bug.
- Parentheses must not shift the digits. Every numeric cell reserves a **1ch right gutter**; the closing paren hangs in it:
  ```css
  .num { display:grid; grid-template-columns:1fr 1ch; text-align:right;
         font-variant-numeric: tabular-nums lining-nums; }
  ```
- **Zero** → en dash `–`, muted, in statements. `0.00` only where a zero was genuinely entered on a journal line.
- **Debit and Credit columns never show a sign.** The column *is* the sign.
- Currency **code once in the header** (`AED`), never per row. Symbols only in single-value displays.
- Swedish locale uses U+202F narrow no-break space as the thousands separator so figures never wrap; en-AE uses `,`.

**Rules, not zebra.** 1px `--ledger-rule` bottom borders only. Hover band, and a 2px `--sv-blue` left marker on the focused row. Accounting convention for totals, implemented literally: **single rule above a subtotal, `border-bottom: 3px double` under a grand total.** Sticky header row, sticky code column on horizontal scroll, sticky totals footer.

---

## 3. Chart of accounts at 500+ accounts

**Hierarchy from the code, not from a parent pointer.** Where the scheme is positional (BAS: class `1` → group `19` → account `1930`; UAE 4-digit conventions behave the same), derive levels 1–4 from the code and store an explicit `parentId` only for non-positional schemes. This makes level 5–6 sub-accounts (`4010.02.CC1`) a display concern, not a migration.

**Layout.** Left: level tree, 260px, resizable, expansion state persisted per user, default expanded to level 2. Right: virtualised 28px table — `Code | Name | Type | VAT default | Currency | Required dimensions | YTD | Status`. Indent 12px per level with a 1px vertical guide per level; disclosure chevrons must not change row height.

**Search is the primary path, the tree is secondary.**
- One input, matches code and name simultaneously.
- Results render as a **flat list with a breadcrumb above each hit** (`1 Assets › 19 Cash & bank › 1930 Business account`). Never a filtered tree — orphan parents and phantom depth are the standard failure here.
- Type-ahead in the tree jumps by code: typing `40` scrolls and highlights.
- A permanent **Flat mode** in code order, so an accountant can hit ⌘F on 500 rows and scan them the way you scan the shelves in Asplund's reading room.

**Favourites.** Star per account. A pinned *Favourites* pseudo-node at the top of the tree; in the journal autocomplete, favourites float above a divider, capped at 8, and are suppressed the moment the query is ≥2 characters (they help you start, they must not obstruct you once you're typing).

**Integrity.** An account with postings can be **archived, never deleted, never re-coded** — the code is identity. Archived accounts vanish from pickers but stay resolvable on historic journals, rendered with an `archived` badge. Renames are versioned and the GL shows the name as at the posting date on hover.

**Bulk edit** by multi-select (type, VAT default, dimension requirement) — this is how you keep 500 accounts consistent without 500 round trips. Import/export round-trips through XLSX (`xlsx` is already a dependency).

---

## 4. The journal entry screen

### Column order and tab order

```
#  │ Account          │ Description │ CC │ Proj │ VAT │ [Cur amt │ Rate] │ Debit   │ Credit  │ ⋯
```

1. `#` line number — muted, **not in tab order**.
2. **Account** — combobox, min 280px (Bokio's own retro: their account box was too narrow).
3. **Description** — placeholder shows the inherited header narration in italic; empty means "inherit".
4. **Dimension columns** — one per *enabled* dimension. A tenant with two dimensions never sees six empty columns.
5. **VAT / tax code** — only when tax is enabled on the tenant.
6. **Currency amount + Rate** — only when the journal is multi-currency or the account is a foreign-currency account.
7. **Debit**, **Credit** — right aligned, tabular, 140px.
8. `⋯` row menu — not in tab order; Shift+F10 reaches it.

**Tab** moves left→right, then wraps to the next row's Account. **Enter** commits the row and, on the last row, creates a new one. **Alt+↑/↓** moves the row itself. Arrow keys navigate the suggestion list inside comboboxes and move between rows inside amount cells. **Esc** leaves the grid for the header — it must never discard the journal.

### Account autocomplete

Ranking, in order: exact code → code prefix → name starts-with → name word-starts-with → name contains → alias/synonym; then boost favourites and last-30-days usage. Render `4010 · Purchases — goods` with the matched substring bolded, an account-type badge, **the current balance right-aligned** (Fortnox's *kontosaldo*), and a small badge if the account requires a dimension — so the user learns the requirement *before* choosing, not on blur.

- Typing a complete valid code + **Tab commits without ever opening the list**. Power users type `1930⇥` and never see a dropdown.
- A **unique code prefix ghost-completes inline** (`19` → `1930` in ghost text; Tab accepts).
- **No free text.** On blur with no match, hold focus in the cell in error state — never silently clear what someone typed. (Bokio.)
- **Create account** lives in a divided footer of the dropdown, needs a click or Ctrl+Enter, **never plain Enter**. Plain-Enter creation is precisely how Intacct customers rebuild the bloat they migrated to escape.

### Amount fields

- Evaluate `+ − * / ( )` on Tab/Enter (Xero, Bokio). **Store the expression** next to the value and show it again on re-focus — `1200*1.05` is an audit-relevant thought.
- One parser for `1 234,56`, `1,234.56`, `1234.56`: strip spaces/NBSP/NNBSP; whichever of `.` or `,` occurs **last** is the decimal separator.
- Typing `−` in Debit **moves the value to Credit as a positive**. The ledger never stores a negative debit.
- Entering Debit clears Credit on that line, and vice versa. A line with both is a **hard block**, not a warning.
- **Auto-balancing line (Fortnox):** on the **last row only**, tabbing out of an empty Debit or Credit fills the exact balancing amount in the correct column. Render it with a **dotted underline as a suggestion** until the row is left; typing over it cancels. Never auto-fill an interior row — that silently launders an error into a plug.

### Paste from spreadsheet

- TSV, anchored at the focused cell, tabs = columns, newlines = rows, grow rows as needed.
- Positional mapping from the anchor; if the first pasted row is non-numeric where amounts belong, treat it as a header and map by name — accept `Account`/`Konto`, `Debit`/`Debet`, `Credit`/`Kredit`, `Description`/`Text`, `Amount`.
- A **single signed amount column is legal**: positive → Debit, negative → Credit.
- **A paste never posts.** A review strip appears: `18 rows pasted · 2 accounts unmatched · 1 amount unparsed`, offending cells outlined, **Alt+Enter cycles to the next unresolved cell**, plus a bulk resolver ("map all 6 rows with code 4011 → 4010 Purchases").
- Single-cell → single-cell paste stays a plain text paste.

### Dates

Xero's shortcuts, everywhere, committed on Tab: `t` today, `+7` / `t+7`, `-1`, `eom`, `31` = the 31st of the current month — plus one they don't have and accountants need most: **`p` = last day of the previous open period.**

---

## 5. The must-balance moment

This is the screen's centre of gravity. Build it once as `<BalanceGauge>` and reuse it in the journal, in bank-split, in multi-invoice match, and in import review.

1. **A sticky footer bar whose Debit/Credit cells share the exact grid columns as the entry rows.** The sums must sit under the figures they sum, to the digit. If you build the totals in a separate flex row, you have already lost the screen.
2. Three slots: Σ Debit, Σ Credit, **Difference**. Height is reserved permanently — the balanced state shows a hairline, a check, and "Balanced" in the same slot, so nothing jumps as you type.
3. **Put the difference under the column it is missing from.** Debits exceed credits → the difference renders in the **Credit** column, labelled *Credit short by*. That single placement decision tells the user where to type, without a sentence.
4. **Clicking the difference inserts a balancing line** pre-filled with that amount in the correct column, focus landing in its Account cell.
5. **Colour timing:** neutral/amber while editing, **Falu red only after a post attempt.** Nobody should be shouted at for a journal that is 300ms old.
6. **Never a disabled Post button that says nothing.** Keep it clickable with `aria-disabled="true"`, label it with the single blocking reason — `Post — 1,250.00 out of balance`, `Post — line 4 has no account`, `Post — 14 Aug is in a closed period` — and on click, **scroll to and focus the offending cell.** No toast. No post-hoc error. Zoho's "The Debits and Credits do not match" after submit is the anti-pattern.
7. **Progressive validation:** line-level errors on line blur; header-level errors only on post attempt. Never per keystroke.
8. **Rounding escape hatch:** when `|difference| ≤ smallest currency unit × line count` and a rounding account is configured, offer one click — *Write off 0.02 to 3740 Rounding differences* (BAS 3740 *Öres- och kronutjämning* is exactly this account). Log it as a system-generated line.
9. **Warn, don't block**, on: posting to a non-postable header account; posting directly to an AR/AP control account; a date more than 30 days future; a probable duplicate (same date + amount + account set) posted within 24h.
10. `role="status" aria-live="polite"` on the gauge, **debounced 600ms**, announcing "Out of balance by 1,250.00, debit". Undebounced, it chatters on every keystroke and screen-reader users turn it off.

---

## 6. Dimensions that don't slow entry

- **Columns in the grid. Never a modal, never a drawer.** A modal per line is the single most common way accounting products destroy their own entry speed.
- Each dimension cell is the *same component* as the account cell: code-first, name-searchable, ghost-completing.
- **Header values inherit to every line** (Fortnox `Kostnadsställe`/`Projekt`). A line that overrides shows a **4px dot** in the cell, so overrides are scannable down the column.
- **`Ctrl+D` copies the cell above.** For repetitive dimension and description entry this is the highest-leverage keystroke in the whole app — spreadsheet muscle memory, zero learning cost.
- Required-dimension rules live **on the account** (`5xxx requires cost centre`), are surfaced in the dropdown row, and are enforced **on line blur** — not saved up for the post attempt.
- Follow Intacct: dimensions carry the analysis, the code stays lean. Resist every request to add a fifth code segment.

---

## 7. Multi-currency

- **The base currency is what balances.** A journal that balances only in transaction currency is not balanced. State this in the gauge when relevant: *Balances in USD · out of balance by AED 3.40*.
- Column order: `Amount (USD) → Rate → Debit (AED) / Credit (AED)`.
- Rate defaults from the rate table **at the journal date**, editable per line, with the source in a tooltip (`FTA daily rate, 2026-09-03`).
- Three values, two degrees of freedom: editing the base amount back-computes the rate and marks it *derived*; editing the rate recomputes the base. Show a small pin on whichever value the user fixed.
- Store rates at ≥6 dp, round base amounts per line to 2 dp, push accumulated rounding onto the last line, then **re-run the balance check**.
- FX gain/loss and revaluation lines are system-generated: visually marked, not directly editable, with a link to the run that produced them.

---

## 8. Trial balance → GL → journal → source

**One navigation contract: every summed figure is a link.**

Chain, five steps, each reversible by breadcrumb or Backspace:
`Statement line → Trial balance row → Account transactions (GL) → Journal → Source document`

- Drill opens **in the same viewport** with a breadcrumb. Never a new tab. Back restores scroll position and the row you came from (Ramp: "drill-downs that never lose your place").
- The **date range and dimension filters travel the whole chain** as removable chips that stay visible at every level.
- **Every level is deep-linkable**: `/ledger/accounts/4010?from=2026-01-01&to=2026-03-31&dim.cc=CC-100`. An accountant must be able to paste a link into an email and have the recipient land on the same figure.
- Trial balance columns: `Code | Name | Opening Dr | Opening Cr | Period Dr | Period Cr | Closing Dr | Closing Cr`, with a sticky totals row that must equal. If it doesn't, that's a **data-integrity alarm**, styled loudly and distinctly from user errors — it is your bug, not theirs.
- **Running balance honesty:** the running-balance column is only meaningful in date+sequence order. If the user sorts a GL view by amount or account, **grey the column and show `n/a in this sort`** rather than rendering a running total that is silently wrong. Almost every product gets this wrong.
- Export at every level exports **exactly the visible rows, columns and filters**, with the filter set written into the first rows of the file.

---

## 9. Bank reconciliation

**The two-column contract (Xero's standard, kept).** One row per statement line: **left = the immutable bank line** (date, description, amount, running bank balance); **right = the proposed ledger match, or the create form.** The left column never reorders while the user works.

- **Keyboard-first:** `Enter` confirms the focused pair · `J`/`K` or arrows move · `F` Find & Match · `S` split · `R` create rule from this line · `T` transfer · `D` discuss. A full session should be completable without the mouse.
- **Confirmed lines collapse over 250ms** and drop into an Undo stack top-right, live for 30 seconds. No confirmation dialog per line — undo beats confirm at this volume.
- **Match confidence is explicit.** Exact amount + date + reference → solid tick, auto-suggested. Amount matches but date is >5 days off or the reference differs → **dotted tick with the differing field highlighted**, and it always requires a keystroke. Never auto-confirm below exact.
- **Split** is a mini journal grid with the same last-line auto-balance behaviour.
- **Multi-invoice match reuses `<BalanceGauge>`.** "Remaining 240.00 goes here" must look and behave identically to the journal's difference. Consistency across the app's two hardest numeric moments is worth more than any individual optimisation here.
- **Rules:** creating a rule from a line pre-fills conditions as removable chips, and before saving shows **"this rule would have matched 43 of your last 200 lines"** with the preview list. Rules **suggest by default**; auto-apply is a separate explicit toggle carrying a "needs review" counter.

**"Why doesn't this reconcile" — a panel, not a report.** Xero users are told to run the report and diff month by month until the break appears; automate that folklore.

1. State the identity plainly: `Bank closing − Ledger balance = Σ unreconciled ledger items + Σ unpresented ± errors`, each term a link.
2. Then list **detected** causes in empirical frequency order, each a one-click filter:
   - **Feed gap** — show the missing date range, detected from the feed's own sequence.
   - **Duplicates** — show suspected duplicate pairs from a re-import or reconnect.
   - **Opening balance mismatch** — the silent killer that poisons every later month.
   - **Post-dated items** — booked before the statement date, cleared after.
   - **Manually marked reconciled** — lines that were waved through.
3. A **month-by-month ladder** (opening → movements → closing, green/red per month) so the user can binary-search the first month that broke, instead of walking backwards one report at a time.

---

## 10. Period close and locking

**States:** `Open → Soft-closed (per-module locks: AR / AP / Payroll / Bank) → Closed → Archived`. NetSuite's per-module lock is genuinely useful: it gives you a **pre-closed state where the numbers can settle** while ordinary posting stops.

**The checklist is the period page.** Ordered tasks, each with status (not started / in progress / done / **blocked-by-prerequisite**), owner, timestamp, and a direct link to where the work happens. A blocked task **names its prerequisite on hover** rather than dead-clicking.

Suggested task list for ARKS: reconcile all bank accounts · clear the suspense account to zero · match VAT control to the filed return · revalue open FX balances · review unposted drafts · review AR/AP ageing against control accounts · post accruals & prepayments · depreciation run · lock AR/AP → review → close.

**Prior-period rule** (NetSuite): a period cannot close while an earlier one is open. Render this as a **stack** where only the top period is actionable and the rest read "waiting for July" — visible sequencing, not a rejection.

**Locking must never dead-end.** When someone posts into a locked period, the dialog offers **three concrete outs**:
- **Re-date to the earliest open period** — showing the new date and what it changes.
- **Request unlock** — creates an approval task addressed to the period owner, with a reason field.
- **Post with override** — only for holders of the override permission, and it stamps a **visible override badge** on the journal, in the GL and in the audit log.

**Prevent, don't error.** Closed periods are **struck through and unselectable inside the date picker**, with the first open date pre-highlighted. Same principle as the balance gauge: block at entry, never at post. A thin global period strip at the top of every ledger screen shows the current status and the next close date; clicking it opens the checklist.

**Closing writes an immutable close record** — balance snapshot, who, when, checklist state. **Reopening requires a reason** and creates a linked reopen record; anything posted after a reopen is flagged in the GL as a **post-close adjustment**.

---

## 11. Immutability and corrections

Grounded in both jurisdictions: Swedish *bokföringslagen* (Fortnox's `Ändringsverifikation` — the original stays, a linked offsetting voucher nets it to zero) and UAE FTA record-keeping (5 years, 10 for capital assets, 15 for real estate).

- Posted journals are **never edited**. Two affordances only: **Reverse** (a linked mirror journal, dated by the user, defaulting to the same date or the first open date) and **Copy**.
- **Void/delete exists only** for the last journal in a series, inside an open period, with no dependent records — exactly Fortnox's `Radera` rule.
- **Journal numbers are assigned at post, never at draft creation**, and a series must have no gaps. Drafts are freely editable and carry a `DRAFT` marker in Swedish yellow.
- Every journal shows a **provenance strip**: created by / posted by / source (manual, invoice #, bank line, recurring template, import batch) / attachments / reversal links in **both directions**.

---

## 12. Implementation notes for this codebase

Existing deps that map straight onto this: **`cmdk`** → `AccountCombobox` and the ⌘K palette; **`xlsx`** → CoA import/export and paste normalisation; **`sonner`** → the reconcile undo stack; **`next-themes`** → the dark token layer. Worth adding: **`@tanstack/react-virtual`** for the 500-row CoA and GL views.

**Performance rule that decides whether the journal grid is usable:** keep cells **uncontrolled with a ref-backed store**, commit to a reducer on blur, and subscribe **only** `<BalanceGauge>` to per-keystroke totals via `useSyncExternalStore`. Re-rendering 200 rows on every keypress is the classic reason these grids feel dead. Virtualise beyond 100 rows, but never virtualise the sticky totals footer.

**Accessibility:** native `<table>` with `role="grid"` and `aria-rowindex`; amount cells get `aria-label="Debit, line 3, account 4010 Purchases"`; focus ring is 2px `--sv-blue` with a 1px paper offset so it reads against a hairline.

**Components to build once:** `LedgerTable` · `AccountCombobox` · `AmountInput` (expression + locale parser) · `DimensionCell` · `JournalGrid` · **`BalanceGauge`** (journal + split + multi-match + import review) · `PeriodGuard` (wraps every date input) · `DrillBreadcrumb` · `ReconcileRow` · `CloseChecklist` · `ProvenanceStrip`.

---

## Sources

[Fortnox — Skapa verifikation](https://support.fortnox.se/produkthjalp/bokforing/skapa-verifikation) · [Fortnox — Ta bort eller ändra felaktig verifikation](https://support.fortnox.se/produkthjalp/bokforing/ta-bort-eller-andra-felaktig-verifikation) · [Bokio — Bokföra manuellt](https://www.bokio.se/hjalp/bokforing/att-bokfora-i-bokio/bokfora-manuellt-i-bokio/) · [Bokio — ny design](https://www.bokio.se/blogg/bokio-lanserar-ny-design-for-att-bli-annu-enklare/) · [Xero shortcuts & calculator](https://www.mkgpartners.com.au/xero-shortcuts-tips-and-tricks/) · [Xero date-entry shortcuts](https://avers.com.au/Bookkeeping/Blog/Xero-Data-Entry-tricks-or-how-to-enter-dates-fast/) · [Xero reconciliation walkthrough](https://www.numeric.io/blog/how-to-reconcile-in-xero) · [Why your Xero bank rec doesn't match](https://www.loveyourbooks.com.au/resources/xero-bank-reconciliation-not-matching) · [NetSuite Period Close Checklist](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1455781.html) · [NetSuite locking periods](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1451780.html) · [Sage Intacct dimensions vs COA](https://inixion.com/dimensions-vs-chart-of-accounts-why-sage-intacct-wins/) · [Modern Treasury — Accounting for Developers](https://www.moderntreasury.com/journal/accounting-for-developers-part-i) · [Modern Treasury — Immutability & Double-Entry](https://www.moderntreasury.com/journal/how-to-scale-a-ledger-part-v) · [Ramp — designing for finance teams](https://ramp.com/blog/designing-for-better-finance-partnerships) · [BAS-kontoplan 2025](https://www.bas.se/kontoplaner/jamfor-kontoplaner/bas-2025/) · [Odoo — Chart of accounts](https://www.odoo.com/documentation/19.0/applications/finance/accounting/get_started/chart_of_accounts.html) · [AG Grid clipboard / TSV](https://www.ag-grid.com/react-data-grid/clipboard/) · [Acceptera (1931)](https://en.wikipedia.org/wiki/Acceptera) · [Stockholm Exhibition 1930](https://en.wikipedia.org/wiki/Stockholm_Exhibition_(1930)) · [Ellen Key, Skönhet för alla](https://visitsweden.com/what-to-do/design-architecture/design/enduring-appeal-swedish-design/) · [Sweden Sans](https://en.wikipedia.org/wiki/Sweden_Sans) · [Natural Colour System (SS 019100)](https://en.wikipedia.org/wiki/Natural_Color_System) · [Swedish flag NCS values](https://www.crwflags.com/FOTW/FLAGS/se-true.html) · [UAE VAT record retention](https://www.cleartax.com/ae/uae-vat-record-keeping)