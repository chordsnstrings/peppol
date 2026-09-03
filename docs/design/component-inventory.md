> Specified against the ledger that already exists on this branch: `prisma/schema.prisma` (Book, Account, FiscalYear, AccountingPeriod, Dimension, DimensionValue, JournalEntry, JournalLine, JournalLineDimension, AccountBalance) and `/home/user/peppol/src/lib/server/ledger/post.ts`. Every prop and state below traces to a real invariant in that code, not a generic accounting mental model.

---

## 0. The Swedish brief, as engineering constraints

Not "Scandinavian mood." Four real sources, each converted into something enforceable in review.

**Gregor Paulsson, *Vackrare vardagsvara* (Svenska Slöjdföreningen, 1919)** — "more beautiful everyday things." The argument was that objects people use daily and unthinkingly deserve more care than the ones they display. A trial balance is the most everyday object in this product. The care budget goes to the 32px row, the decimal alignment, and the tab order — not the dashboard hero.

**Asplund, Gahn, Markelius, Paulsson, Sundahl, Åhrén, *acceptera* (1931)** — "accept the reality that exists." Accounting is dense, numeric, long-form. Do not thin the data to make screens look calm. Accept 10,000 rows and build a table that is genuinely good at 10,000 rows. Calm comes from structure, never from removal.

**Gunnar Asplund, Stockholms stadsbibliotek (1928)** — a rotunda you comprehend entirely, stacks radiating off it. This is the navigation model for 20+ modules: you always see the whole of where you are plus exactly one ring outward, never the whole building. It is why there is no mega-menu.

**Josef Frank (Svenskt Tenn), and *lagom*** — Frank argued against sterile functionalism; warmth is not decoration, it is what makes a room habitable for eight hours. *Lagom* is "just the right amount," neither minimal nor maximal. Together: near-monochrome ink on warm paper, one restrained accent, and density tuned to the task rather than to a screenshot.

Two more, load-bearing later:

- **Sixten Sason** (Saab 92, Hasselblad bodies) — instrument design. The full-screen entry mode is an instrument panel: everything reachable without looking, nothing on the surface that is not used.
- **Allemansrätten** (right of public access) — every number in the app is walkable to its source in three steps or fewer, and the last step is always a human-readable document.

---

## 1. What already exists (reuse, do not rebuild)

| Asset | Path | Use for |
|---|---|---|
| `cn()` | `src/lib/utils.ts` | all class merging |
| `Input`, `Textarea`, `Label` | `src/components/ui/input.tsx` | AmountInput / DateInput base |
| `Badge`, `StatusBadge`, `StatusTone` | `src/components/ui/badge.tsx`, `src/lib/domain/status.ts` | StatusPill base |
| `EmptyState` | `src/components/ui/empty-state.tsx` | extend with presets |
| `Modal` | `src/components/ui/modal.tsx` | ConfirmDestructive base |
| `Skeleton`, `Separator`, `Kbd`, `Spinner` | `src/components/ui/feedback.tsx` | table loading, shortcut hints |
| `useHotkey`, `useLocalState`, `useOnClickOutside`, `useMediaQuery`, `useLockBody` | `src/hooks/use-ui.ts` | shortcut layer, recents, popovers |
| `cmdk` | dependency | AccountPicker + command palette |
| `sonner` | dependency | Toast/undo surface |
| `tnum`, `focus-ring`, `skeleton`, `glass` | `src/app/globals.css` | tabular numerals, focus |
| Nav frame | `src/components/shell/*` — now carries `Accounting → /accounting` | extend to LedgerFrame |

**Two real gaps to close first:**

1. `src/lib/domain/money.ts` is `number`-based. The ledger is `BigInt` minor units serialised as **strings** by `ledgerJson()` (`src/lib/server/ledger/serialize.ts`). A `number` cannot safely carry a large `BigInt` balance. Build `src/lib/domain/ledger-money.ts` as a BigInt/string sibling — do not widen the existing module, invoicing still depends on it.
2. No virtualisation library is installed. Rows here are uniform height, so hand-roll fixed-height windowing (~60 lines) rather than adding `@tanstack/react-virtual`. Uniform height also lets the sticky header and column grid stay in one CSS grid definition.

---

## 2. Foundation: `ledger-money.ts` (build this first, nothing else compiles without it)

```ts
export type Minor = string;            // decimal integer string, e.g. "123456" = 1,234.56
export type Side  = "debit" | "credit";

// Scale per ISO-4217. Critical in the Gulf: KWD/BHD/OMR are 3dp, JPY is 0dp.
export function scaleFor(currency: string): 0 | 2 | 3;

export function parseAmount(
  input: string,
  currency: string,
  opts?: { allowNegative?: boolean; decimalMode?: "explicit" | "implied" }
): { minor: Minor | null; error?: string; evaluated?: string };

export function formatAmount(
  minor: Minor,
  currency: string,
  opts?: { sign?: "auto" | "accounting" | "always"; withCode?: boolean; dashZero?: boolean }
): string;

export function addMinor(a: Minor, b: Minor): Minor;
export function negate(m: Minor): Minor;
export function isZero(m: Minor): boolean;
export function compareMinor(a: Minor, b: Minor): -1 | 0 | 1;

// HALF_UP at the currency scale — mirrors halfUp() in money.ts and post.ts rounding.
export function convert(minor: Minor, fxRate: string, toCurrency: string): Minor;

// signed <-> sided. DB stores signed (debit > 0, credit < 0); the POST API
// (PostLine in post.ts) takes positive debit/credit fields and REJECTS negatives.
export function toSigned(minor: Minor, side: Side): Minor;
export function fromSigned(signed: Minor): { minor: Minor; side: Side };
```

**Expression evaluator** (used by AmountInput): tokenise to digits, `.`, `,`, `+ - * / ( )` only, then shunting-yard. Never `eval` or `new Function`. Evaluate in a decimal-scaled integer domain and round **once**, HALF_UP, at the end. `1200*1.05` must yield `126000`, not `125999`.

---

## 3. Build order

| Phase | Components | Unblocks |
|---|---|---|
| **0** | `ledger-money.ts`, tokens in `globals.css`, `tailwind.config.ts` extensions | everything |
| **1** | CurrencyAmount, StatusPill, BalanceIndicator | read-only screens |
| **2** | AmountInput, DateInput, AccountPicker, DimensionPicker | entry atoms |
| **3** | DebitCreditGrid | the journal editor |
| **4** | DataTable, SavedViews/FilterBar, DrillDown | trial balance, GL, journal list |
| **5** | LedgerFrame, TwoPaneDrillDown, FullScreenEntry, PeriodSelector, ShortcutLayer, LedgerToast, ConfirmDestructive, EmptyState presets | the workspace |

All ledger components live in `/home/user/peppol/src/components/ledger/`. DataTable is generic enough to live in `/home/user/peppol/src/components/data/`.

---

## 4. Value display components

### 4.1 `CurrencyAmount`

**Purpose.** Render one amount with the three-currency reality of `JournalLine`: `txnCurrency`/`txnAmountMinor`, `functionalCurrency`/`functionalAmountMinor`, and `Book.presentationCurrency`. Display-only.

```ts
interface CurrencyAmountProps {
  amountMinor: Minor;
  currency: string;
  functionalAmountMinor?: Minor;
  functionalCurrency?: string;
  fxRate?: string;
  fxRateAsOf?: string;                 // ISO date, for the tooltip
  showFunctional?: "always" | "when-different" | "never";  // default "when-different"
  layout?: "inline" | "stacked";       // stacked in table cells, inline in prose
  sign?: "auto" | "accounting" | "always";  // "accounting" = (1,234.56)
  dashZero?: boolean;                  // zero renders as em-dash; false in totals rows
  size?: "sm" | "md" | "lg";
  emphasis?: "normal" | "total" | "muted";
}
```

**Behaviour.** Primary line is transaction currency, always full precision, never compacted — a ledger amount is never `12.4k`. Secondary functional line renders at 85% size in `--muted-foreground`, only when `functionalCurrency !== currency`. Rate tooltip shows `1 USD = 3.6725 AED · 3 Sep 2026` sourced from `fxRate`/`fxRateAsOf`.

**Sign.** Minus glyph by default, tinted `--ledger-negative` (Falu red) on **the glyph only** — never a filled cell, never a red row. Green for positive is a trading idiom, not an accounting one: positives take plain foreground ink. `sign: "accounting"` switches to parentheses for auditors who ask.

**States.** `loading` → `<Skeleton className="h-4 w-20" />` at the amount's rendered width so the column does not reflow. `error` (rate missing on a foreign line) → amount in txn currency plus a warning glyph, functional line replaced by "rate missing". No disabled/readonly — it is not interactive.

**Keyboard.** None, except: when inside a DataTable cell it is `tabIndex={-1}` and participates in roving tabindex only.

**Accessibility.** The visible text may abbreviate or use parentheses; `aria-label` always carries the unambiguous form — `"negative 1,234.56 United Arab Emirates dirham, 4,532.10 dirham functional"`. Never encode sign in colour alone (WCAG 1.4.1). Wrap in `<data value={amountMinor}>` so the machine-readable minor value travels with the DOM.

---

### 4.2 `StatusPill` and `StateMachineChip`

**Purpose.** One vocabulary for four distinct state machines in the schema. Wraps the existing `Badge`.

```ts
type EntryStatus  = "draft" | "posted" | "reversed" | "reversal";
type PeriodStatus = "open" | "soft_closed" | "hard_closed" | "locked";
type ActorType    = "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION";
type AccountFlag  = "postable" | "heading" | "control" | "archived";

interface StatusPillProps {
  kind: "entry" | "period" | "actor" | "account";
  value: EntryStatus | PeriodStatus | ActorType | AccountFlag;
  size?: "sm" | "md";
  showGlyph?: boolean;   // default true
  showLabel?: boolean;   // false = glyph only, for dense table cells; label moves to aria-label
}
```

**Mappings.**

| Kind | Value | Tone | Glyph | Label |
|---|---|---|---|---|
| entry | draft | neutral | pencil | Draft |
| entry | posted | success | check | Posted |
| entry | reversed | warning | rotate-ccw | Reversed |
| entry | reversal | info | corner-up-left | Reversal of … |
| period | open | neutral | circle | Open |
| period | soft_closed | warning | lock-open | Soft closed |
| period | hard_closed | info | lock | Hard closed |
| period | locked | neutral (grey) | shield | Locked |
| actor | HUMAN | outline | user | — (glyph only) |
| actor | RULE / MODEL / AGENT / INTEGRATION | info / gold / gold / info | zap / sparkles / bot / plug | Rule / Model / Agent / Integration |
| account | heading | outline | folder | Heading |
| account | control | info | shield | Control |
| account | archived | neutral | archive | Archived |

**`StateMachineChip`** is the same pill plus a popover on hover/focus/click listing the legal transitions **from the current state and who may perform each**. Periods: `open → soft_closed` (accountant), `soft_closed → open` (accountant), `soft_closed → hard_closed` (admin), `hard_closed → soft_closed` (admin, audited), `locked → ∅`. Entries: `draft → posted`, `posted → reversed` (posts a new entry, never mutates). This turns the state machine from tribal knowledge into something legible in place.

**States.** `pulse` for a period mid-close. Disabled transitions render greyed with the blocking reason ("needs admin", "period is locked — statutory").

**Accessibility.** Glyph plus label, never colour alone. In `showLabel={false}` mode the label moves into `aria-label`. The chip popover is `role="dialog"` with `aria-haspopup="dialog"`, Escape closes, focus returns to the chip. The actor pill is genuinely important for provenance — a MODEL-posted entry must be visually distinguishable at a glance in a 10,000-row table, which is why it earns gold.

---

### 4.3 `BalanceIndicator`

**Purpose.** Show whether an entry satisfies the two independent balance checks in `post.ts` (lines ~213 and ~218). This is not a green tick; it is the instrument reading.

```ts
interface CurrencyBalance {
  currency: string;
  debitMinor: Minor;
  creditMinor: Minor;
  differenceMinor: Minor;   // signed: positive = debits exceed credits
}

interface BalanceIndicatorProps {
  balances: CurrencyBalance[];        // one per distinct txnCurrency
  functional: CurrencyBalance;        // post-conversion, in Book.functionalCurrency
  state: "balanced" | "unbalanced" | "functional-drift" | "incomplete";
  onPlug?: (currency: string, side: Side, amountMinor: Minor) => void;
  plugTargetLabel?: string;           // e.g. "line 4" — null disables the plug button
  variant?: "bar" | "inline" | "compact";
  density?: "compact" | "dense";
}
```

**The four states are the whole point.**

- `incomplete` — fewer than two lines with amounts. Neutral, no alarm. Says "add a second line."
- `balanced` — every currency sums to zero **and** functional sums to zero. Quiet check, no celebration, no animation beyond a 120ms tint.
- `unbalanced` — at least one currency is out. Shows `Out by AED 25.00 — debits exceed credits`, with a **plug** button when exactly one line has an account but no amount.
- `functional-drift` — the subtle and most valuable one: every currency balances individually but the functional sum does not, because rates disagree. Copy must explain it, not just flag it: *"Balanced in each currency, but out by AED 0.03 after conversion. Check the exchange rates — a cross-currency entry has to balance once converted."* Reproduces the exact failure `post.ts` raises, before the server does.

**Layout.** `variant="bar"` is sticky to the bottom of the grid, above the fold, `--row-h-comfortable` tall. Three columns matching the grid's debit/credit column x-positions so the totals sit **directly under** their columns. That alignment is the single detail that makes the component feel like an accounting tool.

**Keyboard.** `=` anywhere in the grid triggers `onPlug` for the functional currency. The plug button is a real focusable button, not just a hotkey.

**Accessibility.** `role="status"` `aria-live="polite"` `aria-atomic="true"`. **Debounce announcements 400ms and announce only on state transition or settle** — otherwise a screen reader recites the running difference on every keystroke, which is unusable. On transition to `balanced`, announce once: "Entry balances." On `unbalanced` settle: "Out of balance by 25 dirham, debits exceed credits."

---

## 5. Input components

### 5.1 `AmountInput`

**Purpose.** Enter money as `BigInt` minor units with no float ever touching the value, with the ergonomics a bookkeeper coming off a ten-key expects.

```ts
interface AmountInputProps {
  value: Minor | null;
  onChange: (minor: Minor | null) => void;
  currency: string;                    // drives scale via scaleFor()
  allowNegative?: boolean;             // default false inside DebitCreditGrid
  onSignFlip?: () => void;             // typing "-" in the grid moves to the other column
  decimalMode?: "explicit" | "implied";// "implied": 1234 -> 12.34, adding-machine style
  expressions?: boolean;               // default true
  placeholder?: string;
  align?: "right";                     // always right; the prop exists only to be explicit
  size?: "sm" | "md";
  state?: "default" | "loading" | "invalid" | "warning" | "readonly" | "disabled";
  readonlyReason?: string;             // "Period FY26 P08 is hard closed"
  invalidMessage?: string;
  autoFocus?: boolean;
  onCommit?: (minor: Minor | null) => void;   // Enter / Tab / blur
  id?: string; "aria-describedby"?: string;
}
```

**Input grammar** (parse in this order):

1. Plain: `1234.56`, `1,234.56`, `1234,56` (decimal comma).
2. Trailing minus: `1234-` → negative. Ten-key habit; supporting it costs nothing and wins trust.
3. Accounting parens: `(1234.56)` → negative.
4. Expression: any of `+ - * / ( )` beyond a leading/trailing sign → evaluate on commit. While typing, show a ghost `= 1,234.56` right-aligned below the field. `1200*1.05`, `500+250+125`, `(1000+200)/2` all work. Reject anything with a letter.
5. Empty → `null`, distinct from `"0"`. Zero is meaningful and `post.ts` explicitly rejects it ("a zero amount carries no information"); empty is not-yet-entered.

**Negative handling.** With `allowNegative: false` (the grid default), typing `-` calls `onSignFlip()` and moves the caret to the paired column rather than showing an error. Sign is carried by column position, matching how `post.ts` accepts `PostLine.debit` / `PostLine.credit` as positive values and refuses negatives outright.

**Keyboard.**

| Key | Action |
|---|---|
| Enter | evaluate expression, commit, stay |
| Tab | commit, advance |
| Escape | revert to last committed, keep focus |
| ArrowUp / Down | ±1 major unit |
| Shift + Arrow | ±10 major |
| Alt + Arrow | ±1 minor |
| `-` | negate, or `onSignFlip()` |
| `=` | evaluate without committing |

**States.** `loading` — trailing spinner (awaiting an FX rate), input stays editable. `readonly` — `--muted` background, lock glyph in `trailing`, `readonlyReason` in the tooltip and in `aria-describedby`; still focusable and selectable so values can be copied out of a closed period. `disabled` — not focusable, only when a prerequisite is missing (no account chosen yet). `invalid` — `--destructive` border, message below, `aria-invalid="true"`.

**Accessibility.** `inputMode="decimal"`, `autoComplete="off"`, `spellCheck={false}`. `aria-describedby` chains the expression ghost, the readonly reason and the invalid message. On commit after an expression, announce the result in a polite live region — a sighted user sees the field change, a screen-reader user otherwise gets silence. Always pair with a real `<label>`; in the grid the label is the column header wired via `aria-labelledby`.

---

### 5.2 `AccountPicker`

**Purpose.** Choose a postable account from the chart. Must pre-empt **every** account-related `LedgerError` in `post.ts` — heading, archived, control, wrong currency, missing required dimension — so the server error is never a user's first news.

```ts
interface AccountOption {
  id: string; code: string; name: string; nameAr?: string | null;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
  subtype?: string | null;
  parentPath: string[];              // ["Assets", "Current assets", "Cash and bank"]
  isPostable: boolean; isControl: boolean;
  currency?: string | null;          // restricts postings when set
  requiresDimension?: string | null; // dimension code
  status: "active" | "archived";
}

interface AccountPickerProps {
  value: string | null;              // account CODE, matching PostLine.account
  onChange: (code: string | null, account: AccountOption | null) => void;
  entityId: string;
  bookCurrency: string;
  filter?: { postableOnly?: boolean; allowControl?: boolean; types?: AccountOption["type"][];
             currency?: string; includeArchived?: boolean };
  disabledReason?: (a: AccountOption) => string | null;   // escape hatch
  variant?: "field" | "cell";        // "cell" is borderless for DebitCreditGrid
  state?: "default" | "loading" | "invalid" | "readonly" | "disabled";
  onCreateNew?: (query: string) => void;
  autoFocus?: boolean; placeholder?: string;
}
```

**Search ranking** — codes always beat names, because accountants type codes:

1. exact code · 2. code prefix · 3. code substring · 4. name word-prefix · 5. name substring · 6. `nameAr` substring · 7. initials (`ca` → "Cash at bank") · 8. subtype match.

Query the existing endpoint `GET /api/ledger/accounts?entityId=…&q=…&postable=1`; cache per entity in memory; re-rank client-side so keystrokes never wait on the network.

**Blind entry — the single most important behaviour.** Typing a complete valid code and pressing Tab selects it and advances **without ever opening the popup**. A bookkeeper entering fifty lines never sees this component's UI. Build and test that path first.

**Hierarchy.** Each row shows `1010` in `--font-code`, the name in sans, and `parentPath.join(" › ")` dimmed at 85% below. Headings (`isPostable: false`) render as non-selectable group rows with the hint "heading — choose a sub-account"; Enter on a heading expands into its children rather than erroring.

**Disabled options are shown, never hidden**, each with its reason inline:

- archived → "Archived — reactivate in the chart of accounts"
- control (when `allowControl` false) → "Control account — maintained by its subledger. Raise the underlying document instead."
- currency mismatch → "Only accepts USD"

Hiding them makes a user hunt for an account they know exists. Showing them with the reason teaches the model of the system.

**Recents.** Empty query shows two sections: **Recent** (per `entityId` + user, MRU, cap 8, via `useLocalState`) and **Frequent in this book** (from posting counts, cap 5). Recents are what make the second, third and fourth entry of a session fast.

**Keyboard.** `↑↓` navigate (skipping disabled), `Enter` select, `Tab` select-and-advance, `Escape` close and revert, `Alt+↓` open, `Backspace` on empty clears the selection, typing filters immediately. `Cmd+Enter` on a no-results query triggers `onCreateNew`.

**States.** `loading` — three skeleton rows inside the popup, input stays typeable. Empty results — distinguish "no account matches `4021`" (offer create) from "no accounts exist yet" (offer chart-of-accounts setup, `POST /api/ledger/setup`). `readonly` — renders as static `code · name` text with a lock glyph.

**Accessibility.** ARIA combobox pattern: `role="combobox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`, popup `role="listbox"`, rows `role="option"`. Disabled rows use `aria-disabled="true"` (**not** `disabled`, so they stay reachable) with the reason inside the accessible name. Result count announced in a polite live region, debounced 300ms. Popup rendered in a portal with `aria-owns` so the DOM order does not break inside table cells.

---

### 5.3 `DimensionPicker`

**Purpose.** Assign N dimension values to a line. The schema supports arbitrary dimensions (`Dimension` / `DimensionValue`, unique on `[lineId, dimensionId]`), so this is a set of single-selects, not two hard-coded columns.

```ts
interface DimensionPickerProps {
  dimensions: Dimension[];                   // org's active dimensions
  value: Record<string, string>;             // dimCode -> valueCode
  onChange: (next: Record<string, string>) => void;
  requiredCodes?: string[];                  // union of Dimension.isRequired and Account.requiresDimension
  variant?: "cell" | "panel";                // cell = chips + popover; panel = stacked selects
  state?: "default" | "loading" | "invalid" | "readonly" | "disabled";
  onApplyToAllLines?: (v: Record<string, string>) => void;
  maxChips?: number;                         // default 2, then "+2"
}
```

**Requiredness has two sources and they behave differently.** `Dimension.isRequired` is org-wide and known up front. `Account.requiresDimension` is per-line and appears only **after** an account is chosen — so the grid recomputes `requiredCodes` on every account change and the picker must animate the new required slot in without shifting the row height. An unmet requirement is a **warning** while editing and an **error** on submit, mirroring `post.ts`: `Account 5010 requires a COST_CENTRE.`

**Cell variant.** Renders selected values as compact chips (`OPS · MKT`), overflow as `+2`. Click or Enter opens a popover with one labelled select per dimension, required ones first and marked. Footer holds **Apply to all lines** — one click, large payoff on a twelve-line allocation entry.

**States.** `loading` — chips as skeletons. `readonly` — chips only, no popover trigger, lock glyph. Empty (org has no dimensions) — renders nothing at all, and the grid drops the column entirely rather than showing a dead cell.

**Accessibility.** Each slot is a labelled `combobox`. The chip row is a `role="group"` with `aria-label="Dimensions for line 3"`. Required unmet slots get `aria-required="true"` and `aria-invalid` once the row has been touched. Popover is `role="dialog"`, focus-trapped, Escape reverts to the value on open.

---

### 5.4 `DateInput`

**Purpose.** Enter `JournalEntry.entryDate` with the fiscal calendar visible, so a user learns the period they are landing in **while typing**, not after a failed post.

```ts
interface DateInputProps {
  value: string | null;                // ISO yyyy-mm-dd
  onChange: (iso: string | null) => void;
  entityId: string;
  periods: AccountingPeriodLite[];     // GET /api/ledger/periods?entityId=…
  restrictToOpen?: boolean;            // default false for drafts, true for direct posts
  min?: string; max?: string;
  showPeriodAnnotation?: boolean;      // default true
  state?: "default" | "loading" | "invalid" | "warning" | "readonly" | "disabled";
  size?: "sm" | "md";
}
```

**Typed input is primary, calendar is secondary.** Accountants type. Parse, in order: `3/9` and `03-09` (current year, locale-ordered), `3 sep` / `sep 3`, `20260903`, `2026-09-03`, and the shortcuts `t` today, `y` yesterday, `+7` / `-1` day offsets, `bom` / `eom` / `eoq` / `eoy`. The shortcuts are a genuine daily-use feature, not garnish — `eom` during a month-end close is worth more than the calendar.

**Period annotation.** Below the field, always: `3 Sep 2026 · FY26 P09 · Open`. If the resolved period is not open, the annotation becomes a warning with the exact remedy and a one-click fix:

> Period FY26 P08 is **hard closed**. Posting will be refused. → *Use 1 Oct 2026 (P10, open)*

If no period covers the date at all, mirror `post.ts`: *"No accounting period covers 3 Sep 2026. Open the fiscal year first."* with a link to Periods.

**Calendar overlay.** Closed periods get a hatched background using `--ledger-locked-hatch`; `soft_closed` days stay selectable (reopenable), `hard_closed` and `locked` days are `aria-disabled` when `restrictToOpen`. Adjustment periods (`isAdjustment`) appear as a separate row after period 12, labelled `Adj`.

**Keyboard.** `↑↓` ±1 day, `PageUp/Down` ±1 month, `Shift+PageUp/Down` ±1 year, `t` today, `Enter` commit and close, `Escape` revert and close, `Alt+↓` open calendar. Inside the calendar: arrows move by day/week, `Home`/`End` week bounds, roving tabindex on the day grid.

**Accessibility.** Date-picker dialog pattern. The period annotation lives in `aria-describedby` so a screen reader hears *"3 September 2026, period FY26 P09, open"* — the annotation is not decorative, it is the primary feedback. Calendar is `role="dialog"` `aria-modal="true"` with a `role="grid"` day table, `aria-current="date"` on today, `aria-selected` on the value.

---

## 6. `DebitCreditGrid` — the journal line editor

The centre of the product. Everything above composes into it.

```ts
interface JournalRow {
  key: string;                          // stable client id
  accountCode: string | null;
  side: Side;
  amountMinor: Minor | null;            // ALWAYS positive; side carries the sign
  currency: string;                     // defaults to Book.functionalCurrency
  fxRate: string | null;                // required when currency !== functional
  memo: string;
  dimensions: Record<string, string>;
}

interface DebitCreditGridProps {
  rows: JournalRow[];
  onChange: (rows: JournalRow[]) => void;
  book: { code: string; functionalCurrency: string; presentationCurrency: string };
  entityId: string;
  dimensions: Dimension[];
  entryDate: string | null;
  periodStatus: PeriodStatus | null;
  readonly?: boolean;
  readonlyReason?: string;
  minRows?: number;                     // default 2 — post.ts requires >= 2
  showFxColumn?: "auto" | "always" | "never";   // "auto": appears on first foreign currency
  showDimensionColumn?: boolean;        // false when the org has no dimensions
  onPost?: () => void; onSaveDraft?: () => void;
  serverErrors?: { rowKey?: string; field?: string; message: string }[];
  density?: "dense" | "comfortable";
}
```

**Columns.** `# | Account | Memo | Dimensions | Currency | FX | Debit | Credit | ⋮`

`Currency` and `FX` are hidden until a foreign currency appears, then slide in for all rows — never a per-row column shift. Debit and Credit are fixed-width, right-aligned, `tnum`, decimal points aligned down the column.

**Sign model.** Internally each row holds a **positive** amount plus a `side`. The DB stores signed (`debit > 0, credit < 0`) and `serialize.ts` sends strings; the POST API takes positive `debit`/`credit` fields and rejects negatives outright. So the grid converts at exactly one boundary — `toSided()` on load, `fromSided()` on submit — and never carries a negative in row state.

**Auto-balance ("plug").** Never silent. When exactly one row has an account and no amount, the imbalance chip becomes an active button and `=` fills that row with the balancing amount on the correct side, animating the fill over 120ms so the user sees which row changed. With more than one candidate, `=` focuses the first empty amount instead of guessing.

**Side inference.** A new row added below a debit-heavy running balance defaults to `credit`. Typing an amount in the Debit cell when the row was created as credit flips the side rather than erroring.

**Paste.** Handle TSV/CSV paste into any cell — bookkeepers paste from Excel constantly. Expand rows to fit, infer column mapping from a header row when present, otherwise map positionally from the paste anchor. Amounts parse through `parseAmount`; unmatched account codes leave the cell populated and marked invalid rather than blank, so nothing is silently dropped.

**Client validation mirrors `post.ts` exactly**, keyed to the same strings so the server is only ever a backstop:

- fewer than 2 rows → "A journal entry needs at least two lines."
- both or neither of debit/credit → "must carry exactly one of debit or credit"
- zero amount → "A zero amount carries no information."
- heading account → "…is a heading, not a postable account. Choose one of its sub-accounts."
- control account → "…is a control account — it is maintained by its subledger."
- archived account → "Account 5010 is archived."
- currency-restricted account → "Account 1020 only accepts USD."
- missing dimension → "Account 5010 requires a COST_CENTRE."
- foreign currency without rate → "Line 3 is in USD; supply an fxRate to AED."
- unbalanced per currency, and unbalanced functional after conversion (see BalanceIndicator).

**Keyboard** — the whole component is keyboard-first:

| Key | Action |
|---|---|
| Tab / Shift+Tab | next/previous cell |
| ↑ / ↓ | same column, adjacent row |
| Enter | commit; on the last cell of the last row, append a row |
| Cmd/Ctrl + Enter | post the entry |
| Cmd + S | save draft |
| Cmd + D | duplicate current row below |
| Cmd + Backspace | delete current row |
| Cmd + ↑ / ↓ | move row up/down |
| `=` | plug the imbalance |
| Escape | revert current cell; second press exits the grid |
| Cmd + Shift + F | toggle full-screen entry mode |

**Period-locked readonly.** The most important non-happy state, and it is four states, not one:

| Period status | Grid | Banner action |
|---|---|---|
| `open` | editable | — |
| `soft_closed` | readonly, amber banner | **Reopen period** (if permitted) |
| `hard_closed` | readonly, blue banner | **Request reopen** (admin, audited) |
| `locked` | readonly, grey banner | none — offers **Re-date to today (P10, open)** instead |

The banner names the period label and status literally and never offers an action the role cannot perform; it offers the achievable alternative instead. Cells stay focusable and selectable so values can be copied out.

**Other states.** `loading` — skeleton rows at exact final height, no layout shift. `posting` — grid dims to 60%, inputs disabled, spinner in the action bar, `aria-busy="true"`. `serverErrors` — mapped back to their row and field, cell border `--destructive`, message under the grid, and focus moved to the first errored cell.

**Accessibility.** A real `<table>` with `role="grid"`, `aria-rowcount`, `aria-colcount`. Each cell `role="gridcell"` with roving tabindex — exactly one tab stop for the whole grid, arrows move within. Column headers carry `id`s and every input is `aria-labelledby="col-debit row-3"` so a screen reader announces "Debit, line 3, edit". Row-level errors go in `aria-describedby` on the row's first cell. Row add/remove announced politely: "Line 4 added. 4 lines." Reduced motion already handled globally in `globals.css` — the plug fill must respect it.

---

## 7. `DataTable` — dense, sorted, sticky, virtualised

Generic. Used by trial balance, general ledger, journal list, chart of accounts, audit trail.

```ts
type Align = "left" | "right";
type ColKind = "money" | "code" | "date" | "text" | "count" | "status" | "actions";

interface Column<T> {
  id: string;
  header: React.ReactNode;
  kind: ColKind;                      // drives alignment, font and formatting
  accessor: (row: T) => unknown;
  cell?: (row: T) => React.ReactNode;
  width?: number; minWidth?: number; grow?: boolean;
  sortable?: boolean;
  sortFn?: (a: T, b: T) => number;
  pinned?: "left" | "right";
  hidden?: boolean;
  footer?: (rows: T[]) => React.ReactNode;
  align?: Align;                      // override; almost never needed
}

interface DataTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  density?: "compact" | "dense" | "comfortable";   // 28 / 32 / 36 px
  sort?: { id: string; dir: "asc" | "desc" }[];    // multi-sort
  onSortChange?: (s: DataTableProps<T>["sort"]) => void;
  virtualise?: boolean | { threshold: number };    // default { threshold: 100 }
  stickyHeader?: boolean;                          // default true
  stickyFooter?: boolean;                          // totals row
  groupBy?: { key: (row: T) => string; header: (k: string, rows: T[]) => React.ReactNode;
              subtotal?: boolean; collapsible?: boolean };
  selection?: { mode: "none" | "single" | "multi"; selected: Set<string>;
                onChange: (s: Set<string>) => void };
  onRowActivate?: (row: T) => void;                // Enter or double-click -> drill down
  state?: "ready" | "loading" | "empty" | "empty-filtered" | "error";
  emptyState?: React.ReactNode;
  errorMessage?: string; onRetry?: () => void;
  skeletonRows?: number;                           // default 12
  ariaLabel: string;                               // required
}
```

**Column alignment rules — the ones everyone gets wrong.** Derived from `kind`, not hand-set per table:

| kind | Align | Font | Notes |
|---|---|---|---|
| money | right | sans + `tnum` | full precision, never compacted, decimals aligned |
| code | left | `--font-code` + `tnum` | account codes, entry numbers |
| date | left | sans + `tnum` | one fixed format app-wide (`3 Sep 2026`) |
| text | left | sans | truncate with `title` and full text in `aria-label` |
| count | right | sans + `tnum` | |
| status | left | — | **fixed width** so pills never jitter the grid |
| actions | right | — | fixed width, visible on hover/focus, always in the a11y tree |

**Header alignment must match its cells.** A right-aligned money column gets a right-aligned header. This is the most-broken rule in accounting UIs and it is one line of shared code here.

**No zebra striping.** Swedish rule: separate with space and a hairline, not with fill. A 1px `--ledger-rule` under each row, a slightly stronger rule between groups. Row hover is a 4% `--accent` wash; keyboard focus is a 2px inset `--ledger-focus-cell` ring, distinct from hover.

**Totals get the double rule** — 1px above, 2px below, `--ledger-rule-total`. It is the real accounting convention and it costs two CSS lines.

**Virtualisation.** Uniform row height makes this simple: track `scrollTop`, render `[start - 8, end + 8]`, position with a single `translateY` on a spacer, `contain: strict` on rows. Below `threshold` rows, render everything — virtualising 40 rows only costs correctness. Grid template columns are defined once on the container so header, body and footer are guaranteed to align; never re-derive widths per row.

**Column sizing.** Money columns size to the widest value at the current scale, measured once per data change, so the decimal column is stable. Text columns take the remaining space.

**Sorting.** Click toggles asc → desc → none. Shift+click appends to a multi-sort, and each header shows its sort index (`1`, `2`). Money sorts on `BigInt` via `compareMinor`, never on the formatted string.

**States.**

- `loading` — `skeletonRows` shimmer rows at exact final height, header rendered. Never a centred spinner; it destroys the layout and the scroll position.
- `empty` — nothing exists. Header retained, `EmptyState` in the body with a creating CTA.
- `empty-filtered` — **a genuinely different state.** "No entries match these filters" plus **Clear filters** and the active filter count. Conflating these two is the most common table bug.
- `error` — inline row with the message and a Retry button; any rows already loaded stay visible.

**Keyboard.** Roving tabindex: one tab stop for the table. `↑↓` rows, `←→` columns, `Home`/`End` row bounds, `Cmd+Home`/`Cmd+End` table bounds, `PageUp/Down` viewport, `Enter` activate row (drill down), `Space` toggle selection, `Shift+↑↓` extend selection, `Cmd+A` select all loaded rows (with an explicit "select all N matching" affordance when more exist server-side).

**Accessibility.** Semantic `<table>`; `role="grid"` only when interactive. **With virtualisation, `aria-rowcount` must be the full logical count and each rendered row must carry its true `aria-rowindex`** — otherwise a screen reader reports "row 3 of 20" in a 10,000-row table. `aria-sort` on sorted headers. Sticky header uses `position: sticky` on real `<th>` elements, never a duplicated header table. `aria-label` is required, not optional. Announce sort and filter changes in a polite live region: "Sorted by amount, descending. 1,284 rows."

---

## 8. `DrillDownSurface`

**Purpose.** Allemansrätten made literal: every number walks to its source.

```ts
type DrillKind = "report" | "account" | "period" | "entry" | "document" | "attachment";

interface DrillNode {
  kind: DrillKind;
  id: string;                 // "4000", "GJ-0042", "inv_abc"
  label: string;              // "4000 Sales — services"
  params?: Record<string, string>;   // { from, to, book }
}

interface DrillDownProps {
  path: DrillNode[];
  onPush: (n: DrillNode) => void;
  onPop: (toIndex?: number) => void;
  render: (node: DrillNode) => React.ReactNode;
  maxCrumbs?: number;         // default 4, then collapse the middle into "…"
  state?: "ready" | "loading" | "error" | "no-source";
}
```

**Canonical chain.** `trial balance → account (GL) → journal entry → source document → attachment`. Depth is capped at 5; nothing in this product should be further than that from a number.

**URL is the state.** Encode as `?drill=tb.2026-Q1/acct.4000/entry.GJ-0042`. Browser back and forward work, a drilled view is shareable by link, and refresh restores position. Non-negotiable — accountants send each other links to specific numbers.

**`no-source` state.** Some entries have no document (`source: "manual"`, or an opening balance). Say so plainly — *"Posted manually by Nadia Rahman on 3 Sep 2026. No source document."* — and show the actor and timestamp instead of an error. This is the state most drill-downs handle badly.

**Keyboard.** `Escape` or `Backspace` pops one level (Backspace only when focus is not in a text input). `Cmd+[` / `Cmd+]` move back and forward through drill history. `1`–`5` jump to that breadcrumb.

**Accessibility.** Breadcrumb is `<nav aria-label="Drill-down path">` with an ordered list, current node `aria-current="page"`. Each push moves focus to the new pane's heading and announces "Opened account 4000 Sales — services" politely. Collapsed middle crumbs live behind a real menu button, never a bare ellipsis.

---

## 9. `PeriodSelector`

```ts
interface PeriodSelectorProps {
  fiscalYears: FiscalYear[];
  periods: AccountingPeriodLite[];    // seq, label, startsOn, endsOn, status, isAdjustment
  value: { kind: "period"; periodId: string } | { kind: "range"; from: string; to: string };
  onChange: (v: PeriodSelectorProps["value"]) => void;
  comparative?: { enabled: boolean; value?: PeriodSelectorProps["value"];
                  onChange?: (v: PeriodSelectorProps["value"]) => void };
  quickRanges?: boolean;              // default true
  showStatus?: boolean;               // default true
  variant?: "toolbar" | "context-bar";
  state?: "default" | "loading" | "readonly" | "disabled";
}
```

**Layout.** Fiscal year select, then a 12-cell period grid (plus a separate `Adj` row for `isAdjustment` periods), each cell showing `P09 · Sep` with a status dot. Quick ranges below: This month, Last month, This quarter, YTD, Last FY, Custom.

**Status dots** use the period tokens: open neutral, soft closed amber, hard closed blue, locked grey with a lock glyph. A user must be able to see, at a glance, how far the close has progressed across the year — that grid **is** the close dashboard.

**Comparative mode** returns a second value and offers Prior period / Prior year / Custom, which the report surfaces as an extra column pair.

**Keyboard.** Arrows navigate the period grid as a 2D grid, `Enter` selects, `Shift+Enter` sets the comparative, `y`/`Y` previous/next fiscal year, `Escape` closes.

**Accessibility.** `role="grid"` for the period cells with `aria-selected`; each cell's accessible name is `"Period 9, September 2026, open"` so status is never dot-only. The quick ranges are a `radiogroup`.

---

## 10. Supporting components

### 10.1 `EmptyState` presets

Extend the existing component; do not replace it. Presets, each with the right CTA:

| Preset | Copy | CTA |
|---|---|---|
| `no-chart` | "No chart of accounts yet." | Set up UAE chart → `POST /api/ledger/setup` |
| `no-journals` | "No journal entries in this book." | New entry |
| `no-results` | "No entries match these filters." | Clear filters (+ show active count) |
| `period-empty` | "No activity in FY26 P09." | Change period |
| `no-source` | "Posted manually. No source document." | View audit trail |
| `no-dimensions` | "No dimensions configured." | Add a dimension |
| `account-empty` | "No postings to 4000 in this range." | Widen the range |

The `no-journals` / `no-results` distinction is mandatory. `EmptyState` in an error position must never be used for a failed fetch — that is the table's `error` state.

### 10.2 `ConfirmDestructive`

**In a ledger, nothing is deleted.** The destructive actions are: void a draft, reverse a posted entry, hard-close a period, reopen a hard-closed period, archive an account.

```ts
interface ConfirmDestructiveProps {
  open: boolean; onCancel: () => void; onConfirm: () => Promise<void>;
  tier: "confirm" | "type-to-confirm" | "reauthenticate";
  title: string;
  consequence: React.ReactNode;      // stated in ledger terms, required
  confirmPhrase?: string;            // the entry number or period label — never "DELETE"
  confirmLabel: string;              // "Reverse GJ-0042" — names the action, not "OK"
  irreversible?: boolean;
}
```

**`consequence` is required and must be literal**, e.g.:

> This posts a **reversing entry** dated 3 Sep 2026 into FY26 P09. GJ-0042 stays in the ledger and is marked Reversed. The reversal takes the next number in the GJ series.

Tier by severity: void a draft → `confirm`; reverse a posted entry → `type-to-confirm` with the entry number; hard-close or reopen a period → `reauthenticate`.

**Accessibility.** `role="alertdialog"`, `aria-describedby` on the consequence. **Initial focus goes to Cancel, never the destructive button.** Escape cancels, focus trapped, focus restored to the trigger on close. The confirm button stays disabled until the phrase matches exactly.

### 10.3 `SavedViews` and `FilterBar`

```ts
type FilterOp = "eq" | "neq" | "in" | "between" | "gte" | "lte" | "contains" | "exists";
interface Filter { field: string; op: FilterOp; value: unknown; }

interface SavedView {
  id: string; name: string;
  scope: "personal" | "entity" | "org";
  filters: Filter[];
  sort: { id: string; dir: "asc" | "desc" }[];
  columns: string[]; density: "compact" | "dense" | "comfortable";
  isDefault?: boolean;
}
```

**Filterable ledger fields.** date range, period, account (multi, with an **include sub-accounts** toggle that walks `Account.parentId`), dimension values, amount range, currency, entry status, `source`, `actorType`, memo contains, entry number, has attachment.

**URL is the source of truth.** A saved view is a named URL state. Pasting a filtered ledger link must reproduce it exactly. When the current state diverges from the loaded view, show a `Modified` chip with Save / Save as / Reset.

Needs a small `SavedView` Prisma model for `entity` and `org` scopes; `personal` can start on `useLocalState` and migrate.

**Keyboard.** `f` focuses the filter bar, `Escape` clears the in-progress chip, `Cmd+Shift+S` save view, `Backspace` on an empty filter input removes the last chip.

**Accessibility.** Chips are a `role="group"`; each has a labelled remove button ("Remove filter: account 4000"). Result count announced politely on change.

### 10.4 `ShortcutLayer`

A scoped registry, not scattered `useHotkey` calls.

```ts
useShortcut("mod+enter", handler, {
  scope: "journal-grid",
  description: "Post entry",
  group: "Journal",
  when: () => canPost,
  allowInInput: true,        // single-key shortcuts default to false
});
<ShortcutScope name="journal-grid"> … </ShortcutScope>
```

Scopes stack; the innermost matching handler wins. `when` predicates gate without unregistering, so the `?` cheat sheet can show unavailable shortcuts greyed with the reason. **The cheat sheet is generated from the registry** — a hand-maintained list drifts within two sprints. Conflicts throw in dev.

Global: `Cmd+K` palette, `?` cheat sheet, `g` then `j`/`t`/`a`/`p` go to journals/trial balance/accounts/periods, `Cmd+Shift+F` focus mode, `Alt+Z` undo the last toast action.

**Accessibility.** Every shortcut has a pointer equivalent. Hints render with the existing `Kbd`. The cheat sheet is a real focus-trapped dialog. Nothing may hijack `Tab`, `Escape`, `Enter`, or arrow keys outside a grid.

### 10.5 `LedgerToast` (on `sonner`)

Undo in a ledger is not a client-side rollback — it is a server action, and the toast must be honest about which one.

```ts
ledgerToast.posted(entry, {
  undo: async () => { /* draft -> delete; posted -> POST /journals/[id]/reverse */ },
  undoLabel: entry.status === "posted" ? "Reverse" : "Undo",
});
```

- Success: `Posted GJ-0042 · AED 12,500.00` with Undo for 8 seconds, and the entry number is a link to the entry.
- After the window closes, undo is gone from the toast and lives in the entry's menu as **Reverse entry** — never a dead Undo button.
- If undo posts a reversal, the follow-up toast must say so: `Reversed GJ-0042 with GJ-0043`. Never imply the original vanished.
- **Errors are never toast-only.** A failed post also renders inline on the grid with focus moved to the offending cell. A toast that scrolls away is not an error report.

**Accessibility.** Success `aria-live="polite"`, errors `assertive`. `Alt+Z` triggers the newest undo, because Tab-reaching a transient toast is a known trap. Toasts pause their timer on hover **and on focus**.

---

## 11. Layout shells

### 11.1 `LedgerFrame` — 20+ modules, no mega-menu

Asplund's rotunda: the whole of where you are, plus one ring outward.

**Left rail, 240px, collapsible to a 56px icon rail** (persisted). Three zones:

1. **Pinned** — user-chosen, max 6, drag to reorder. Where a bookkeeper actually lives.
2. **Sections** — accordion, **exactly one open at a time**. This is the mega-menu replacement: `Sell`, `Buy`, `Bank`, `Ledger`, `Reports`, `Setup`. The `Ledger` section holds Journals, Chart of accounts, Trial balance, General ledger, Periods & close, Dimensions, FX revaluation, Audit trail — matching the new `Accounting → /accounting` entry in `nav-config.ts`.
3. **Footer** — entity switcher, user menu.

**Depth limit is 2.** No flyouts, no nested submenus. A module needing a third level uses in-page tabs.

**`Cmd+K` is the primary navigation for power users**; the rail is for orientation. The palette indexes modules, accounts by code and name, entry numbers, saved views, and actions. Typing a bare account code from anywhere jumps to that account's ledger — extend the existing `command-palette.tsx`.

**Context bar** — a persistent strip under the topbar on every ledger route: `Entity · Book · Period · Functional currency`. It never scrolls away. It is the "where am I in the books" line, and its absence is why people post to the wrong entity.

Mobile keeps the existing 5-item tab bar plus drawer. The ledger grid is not usable below 768px — offer a read-only entry view and a "open on desktop" note rather than a broken editor.

### 11.2 `TwoPaneDrillDown`

```ts
interface TwoPaneProps {
  list: React.ReactNode;
  detail: React.ReactNode;
  drillPath: DrillNode[];
  listWidth?: number;          // 380–640, persisted per route
  collapsed?: boolean;
  emptyDetail?: React.ReactNode;
}
```

Left pane resizable and persisted; right pane carries the drill breadcrumb. **The list pane keeps its scroll position when you pop back** — small, and instantly noticed when missing. Both panes scroll independently. Below 1024px the panes become a push/pop stack with a back button.

Keyboard: `[` / `]` collapse and expand, `j` / `k` move in the list, `Enter` drill, `Escape` pop, `Cmd+[` / `Cmd+]` drill history.

Accessibility: `<main>` split into two labelled `<section>`s ("Accounts", "Account detail"); the resizer is `role="separator"` with `aria-orientation="vertical"`, `aria-valuenow`, and arrow-key resize in 16px steps.

### 11.3 `FullScreenEntry` — the Sason instrument panel

Entered by `Cmd+Shift+F` or `/accounting/journals/new?mode=focus`.

**Removes** sidebar, topbar, notifications, breadcrumbs. **Keeps** the context strip (entity · book · period · currency), the grid, the balance bar, and a one-line shortcut hint bar.

- Row height goes to `--row-h-comfortable` (36px) *despite* density elsewhere — you stare at the same row for minutes here. This is *lagom*: density calibrated to the task, not applied uniformly.
- After posting, the form resets **keeping date, book and dimensions**, and a "posted this session" list accumulates in a right column so a user sees their run without leaving. That list is the difference between entering 8 entries and entering 80.
- Toasts move to bottom-left so they never cover the balance bar.
- No animation over 120ms.
- `Escape` prompts when dirty; a draft is autosaved to `useLocalState` keyed by entity so a refresh never loses work.

Accessibility: entering focus mode announces "Focus entry mode. Press Escape to exit." and moves focus to the first empty cell. The shortcut hint bar is real text, not a tooltip. Exiting restores focus to the trigger.

---

## 12. Definition of done, per component

1. Renders correctly in light **and** dark (`next-themes` + `.dark` tokens).
2. Every state in its table is reachable in a story or a dev route.
3. Full keyboard path with no mouse, verified end to end.
4. Screen-reader pass on the specified contract.
5. Money paths use `Minor` strings and `BigInt` — a `number` in a ledger amount is a review block.
6. Every client-side validation message matches its `post.ts` counterpart verbatim.
7. `prefers-reduced-motion` respected (global rule exists in `globals.css`; do not override it locally).
8. RTL-safe — `nameAr` exists on `Account` and the app already sets `[dir="rtl"]`. Numerals stay Latin and money stays right-aligned in both directions.
