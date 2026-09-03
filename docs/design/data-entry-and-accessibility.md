## Why this matters more than the rest of the ledger UI

An accountant posting a month-end close does 40–200 journal lines in a sitting, from a paper stack or a second screen, **heads-down** — eyes on the source document, not on our UI. In that mode the interface is not something they look at; it is something they *play*, like an instrument. Every mouse reach is a context switch that costs ~2 seconds and loses their place in the stack. Software an accountant is fast in has one property above all others: **the hands never leave home position on the number pad, and the system never surprises them.**

The Swedish design frame is not decorative here, it is functional and it is load-bearing. The Swedish functionalist tradition (*funkis*, `acceptera` 1931, Bruno Mathsson, and its modern civic descendant in Digg's `webbriktlinjer`) makes exactly the claim this screen needs: **form follows use, ornament is subtracted until only the affordance is left, and the object must work for everybody — not as charity, but as the definition of good work.** Digg codifies this legally in the DOS-lagen: accessibility is not a layer added at the end, it is a property of the artefact. So: quiet paper-toned surfaces, no chrome competing with the numbers, generous focus states, and every state readable without colour. That is the same brief as WCAG 2.2 AA. They are not in tension — Swedish restraint *is* the accessible design.

Two hard constraints from the codebase to design inside:

- `src/lib/domain/money.ts` already fixes the model: **money is integer minor units, never floats.** `parseMoneyToMinor()` already accepts `"1,234.56"`, strips thousands separators, and falls back on decimal comma. The input layer must feed that function, never `parseFloat`, and never round on its own.
- `src/app/ar/layout.tsx` proves the product ships **Arabic RTL**. A ledger grid is the single hardest thing to get right in RTL, because numbers stay LTR inside an RTL row. This has to be designed in now, not retrofitted.

---

## Part 1 — Keyboard-first: the vocabulary accountants already own

Do not invent shortcuts. Every accountant arriving at ARKS carries muscle memory from at least one of these, and the overlaps are the shortcuts we must honour.

| Convention | Source | What it means for us |
|---|---|---|
| Calculator inside the amount field — type `1200/12`, press Tab | **Xero** (Debit/Credit fields in manual journals; Qty/Unit Price in invoices) | Non-negotiable. This is *the* feature accountants name when asked what they miss. |
| `t` = today, `tom` = tomorrow, `15/3` = 15 March this year | **Xero** date fields | Date fields must parse shorthand, not demand a picker. |
| `Alt+N` new row, `Alt+B` post, `Alt+S` save, `+` then `Enter` = copy from the row above | **Fortnox** | Direct precedent for our row and post commands, and for the copy-down key. |
| `F5` = post/save the transaction; `F3` = find transaction; `Alt+<letter>` = jump to labelled field | **Sage 50** | Function keys still carry weight with desktop-trained users. Offer `F5`-equivalent as an *alias*, not the primary. |
| Big `Tab` moves right, big `Enter` moves down | **10-key numeric keypads** sold specifically to bookkeepers | The grid must obey this axis convention exactly. |

### The one-hand rule

The right hand lives on the number pad. Therefore: **every high-frequency command must be reachable by the left hand alone, or by keys present on the number pad (`Tab`, `Enter`, `+`, `-`, `.`/`,`).** A shortcut requiring both hands to leave home position is a shortcut that will not be used.

### The complete mouse-free journal entry

This is the target flow. Header fields are a normal form; the lines are the grid.

```
/j              → open new journal (global command palette; "/" is Xero's search key)
[Date]  t       → today. "-" = yesterday, "+" = tomorrow, repeatable.
                  "31/1" = 31 Jan current FY. "31/1/25" = explicit year.
Tab
[Reference]     → auto-filled with next sequence; typing overrides
Tab
[Description]   → memo; carries down to every line as the default narration
Tab             → focus lands on line 1, Account cell

── grid ──
[Account] 4010  → type-ahead on CODE first, then name. Exact code match + Tab commits
                  with no dropdown interaction at all.
Tab
[Description]   → pre-filled from header. Type to override.
Tab
[Debit]  1200/12 → Tab evaluates → 100.00
Tab             → Credit (skipped by auto-advance if Debit non-zero — see Part 2)
Tab             → Tax code (optional, skippable)
Tab             → Dimension / cost centre
Tab             → wraps to line 2 Account, creating line 2 if it did not exist
──────────

Alt+N           → insert a line below (Fortnox)
Ctrl+Shift+Backspace → delete current line (never a bare Delete key)
Ctrl+D          → copy the cell above into this cell (Excel's fill-down)
+ then Enter    → copy the whole line above (Fortnox's "kopiera från raden ovan")
Ctrl+B          → auto-balance: write the outstanding difference into the
                  focused amount cell. The single most valuable key on the screen.
Ctrl+Enter      → post
Ctrl+S          → save as draft
Ctrl+Z / Ctrl+Y → undo / redo, scoped to the entry
Escape          → revert current cell to its last committed value
Shift+?         → shortcut cheat-sheet overlay
```

Two rules about the shortcut set itself:

1. **Never bind a bare single letter as a global shortcut.** A screen-reader user in browse mode, and any user with a tremor, will trigger it accidentally. WCAG 2.1.4 Character Key Shortcuts (Level A) requires it be remappable, or only active on focus. `/` for the palette is acceptable only because it is not a letter and is a near-universal web convention.
2. **Every shortcut must have a visible non-keyboard equivalent.** Discoverability: show the shortcut hint inside the button (`Post ⌃⏎`), which also satisfies the "don't hide functionality" instinct without a modal tutorial.

---

## Part 2 — Numeric input behaviour

### Never use `<input type="number">`

This is settled. Spinner buttons steal 2×24px of a dense cell and are a mouse-only affordance; the scroll wheel silently changes a committed amount when the user scrolls the page (a *catastrophic* failure mode in a ledger); browsers apply locale parsing you do not control; and `valueAsNumber` gives you a float, which `money.ts` forbids. 

Use instead:

```html
<input type="text" inputmode="decimal" autocomplete="off"
       spellcheck="false" enterkeyhint="next" class="tabular-nums text-right">
```

`inputmode="decimal"` gives the number pad on touch without any of `type=number`'s desktop damage.

### The amount field is a three-state machine

| State | Displayed | Alignment |
|---|---|---|
| **Blurred, has value** | `1 234,56` — grouped, fixed 2 dp, locale-formatted, tabular numerals | right |
| **Focused** | raw editable text, grouping separators *stripped*, caret preserved, full text selected on `Tab`-in / caret placed at click point on mouse-in | right |
| **Blurred, empty** | truly empty — **not** `0.00` | right |

Empty ≠ zero is a real accounting distinction: an empty Credit cell on a debit line is "not applicable", a `0.00` is an assertion. Rendering `0.00` in every unused cell also doubles the visual noise on a 40-line entry.

### Decimal separator: accept everything, display one thing

The Swedish numeric keypad has `,` where the US one has `.`; the Arabic keyboard produces `٫`. The user's thumb hits the key their hardware has, and they are always right.

- **Accept as decimal separator:** `.` `,` `٫` (U+066B) — and the `NumpadDecimal` key regardless of what character it emits.
- **Accept as thousands separator and discard:** space, non-breaking space, narrow no-break space (U+202F, what `Intl` emits for `sv-SE`), `'`, and `,` when followed by exactly three digits — `money.ts` already does this last one.
- **Display** per the entity's locale (`en-AE` today, ready for `sv-SE` and `ar-AE`).
- Route everything through `parseMoneyToMinor()`. Do not add a second parser.

### Calculator expressions

Xero's calculator in Debit/Credit fields is the feature to match, and it is small.

- Trigger: the field content contains any of `+ - * / ( )` beyond a leading sign.
- Evaluate on **commit** (`Tab`, `Enter`, or blur) — never on keystroke.
- Grammar: `+ - * / ( ) %` and decimals only. **Parse it yourself with a shunting-yard evaluator; never `eval`, never `new Function`.** It is ~60 lines and it is the difference between a feature and an XSS vector in a multi-tenant financial app.
- Evaluate in decimal minor units with half-up rounding to match `halfUp()`, so `100/3` → `33.33` consistently across the field and the posting engine.
- On commit, **show the working**: the cell reads `100.00` and a subdued hint below/beside it reads `= 1200/12`. Preserve the expression in the row's metadata so a reviewer can see how the number was derived. This turns a convenience into an audit feature.
- On a parse error, do **not** clear the field. Keep the text, mark `aria-invalid`, and say what is wrong.

### Negatives and the Dr/Cr axis

Accountants express negativity three ways and expect all three to work:

- `-100`, `100-` (trailing minus — the 10-key and mainframe convention; the `-` key is right there on the pad), and `(100)`.
- All three parse to the same negative value.
- **Design decision:** in a two-column Dr/Cr grid, a negative amount should be *offered as a side-swap*, not stored as a negative. If the user types `-100` in Debit, on commit move `100` into Credit and clear Debit, with a live-region announcement of what happened. This is error prevention: a negative debit and a positive credit are the same fact, and storing one as a negative debit will corrupt every report downstream. Offer a per-user setting to disable the swap for those who genuinely want signed single-column entry.

### Auto-advance — the rule and its exception

Auto-advance is loved when correct and hated when wrong. The safe rule:

- **Advance on an unambiguous commit only.** Entering a value in Debit and pressing Tab skips the Credit cell of that line. Do not auto-advance on "field looks full" heuristics (fixed-width auto-tab), which are a known accessibility failure — they break correction, break screen-reader focus tracking, and violate 3.2.2 On Input.
- Account code type-ahead: when the typed string **exactly** matches one account code, commit on `Tab` with no menu interaction. Do not auto-commit on a unique-prefix match while the user is still typing — `40` uniquely prefixing `4010` today stops being unique when they add account `4020` next week, and the muscle memory silently breaks.
- Provide a per-user preference for `Enter` behaviour: *move down* (Excel/10-key default) vs *submit*. Default to **move down** in the grid, **submit** in the header form. Announce which is active in the cheat-sheet.

---

## Part 3 — The grid: tab order, editing model, and Excel paste

### The semantic decision (this is the important one)

The ARIA Authoring Practices `grid` pattern exists, but Adrian Roselli's evaluation — echoed in Sarah Higley's grid series — is that `role="grid"` should be reserved for genuine Excel recreations, because it **destroys screen-reader table navigation** (users lose their table-reading shortcuts and are forced into arrow-key roaming), announces confusing shifting row/column positions, and requires you to hand-build focus management that native HTML gives free.

So split the two surfaces:

| Surface | Markup | Navigation |
|---|---|---|
| **Journal line editor** (2–40 rows, every cell editable) | Native `<table>` with real `<input>`/`<button>` in `<td>`. **No `role="grid"`.** | `Tab` visits every control in DOM order. Arrows enhanced (below). Screen readers keep full table semantics and header association. |
| **Ledger / trial balance / account browser** (thousands of rows, read-only, row-activatable) | Native `<table>` with `<caption>`, `<thead>`, `scope="col"`/`scope="row"`, `<tfoot>` for totals. **No `role="grid"`.** | `Tab` reaches one real link or button per row. Sorting via `<th><button aria-sort>`. |

`role="grid"` earns its place only if you later ship a true spreadsheet-mode bulk editor. If you do, follow APG exactly: roving `tabindex`, `Enter`/`F2` to enter edit mode, `Escape` to exit and revert, `aria-rowcount`/`aria-rowindex` for virtualised rows, and `aria-readonly` on locked cells.

### Arrow keys in an editable grid — the conflict, and the resolution

Plain arrow keys cannot mean "move cell" in a grid full of text inputs, because inside a text input they must mean "move caret". APG resolves this with an `F2` edit mode, which is correct but *alien to accountants*, who expect Excel's always-editing behaviour. Resolve it by axis, exploiting the fact that our amount fields are single-line:

- **`ArrowUp` / `ArrowDown`** — always move one row, same column. Vertical caret movement is meaningless in a single-line input, so there is no conflict to resolve. This is the axis accountants use constantly (running down a column of amounts) and it should be free.
- **`ArrowLeft` / `ArrowRight`** — move the caret. Move to the adjacent cell **only** when the caret is already at that end of the text *and* the selection is collapsed. Same as Excel's in-cell edit mode and Google Sheets. Predictable, and never traps.
- **`Ctrl/Cmd + Arrow`** — always move cell, regardless of caret. The unambiguous escape hatch.
- **`Home` / `End`** — caret to start/end of cell. **`Ctrl+Home` / `Ctrl+End`** — first / last cell of the grid.
- `Escape` **must** always return the cell to its last committed value and never leave focus stranded. Test explicitly for keyboard traps (2.1.2, Level A).

### Tab order

- Strict visual DOM order: header fields → line 1 left-to-right → line 2 → … → totals row → action bar. Never use positive `tabindex`.
- `Tab` on the **last cell of the last line** creates a new line and moves into its Account cell. This is how a stack of invoices gets entered without ever reaching for a "+ Add line" button.
- Optional-but-usually-empty columns (Tax, Dimension, Project) get a per-user **"skip in tab order"** toggle, implemented as `tabindex="-1"` on those inputs while still reachable via `Ctrl+Arrow`. A firm that never uses dimensions should not tab through 40 empty dimension cells per entry.
- The row-delete button must **not** be a tab stop between the last data cell and the next row. Put row actions in a trailing cell reachable by `Ctrl+Arrow`/`End`, or behind a per-row menu. Nothing destructive in the fast path.

### Paste from Excel

This is how a real close actually happens: the accrual schedule lives in a spreadsheet.

- Listen for `paste` on the grid. Read `text/plain` and split on `\r\n|\n|\r` then `\t` — Excel and Google Sheets both put **TSV** on the clipboard. Also read `text/html` when present: it preserves which cells were blank vs zero, and gives you number formats.
- **Anchor at the focused cell** and expand right/down, creating rows as needed. Truncate at the grid's column count; never wrap into the next row.
- Run every pasted amount through the same parser as typed input: strip currency symbols, `()` → negative, trailing minus, thousands separators, and Excel's non-breaking spaces.
- **Never post a paste silently.** Show a review state: pasted cells get a distinct-but-not-colour-only treatment (a left border marker + a "pasted" state in the row's accessible name), a `role="status"` announcement of `"Pasted 12 rows, 3 need attention"`, and an inline diff for rows where an account code could not be matched.
- Unmatched account codes become an inline "unresolved" cell with a picker — **not** a blocking modal, and **not** silently dropped.
- One `Ctrl+Z` undoes the entire paste as a single transaction. A paste that takes 12 undos to reverse is worse than no paste.
- Provide `Ctrl+C` on a selection producing TSV back out, so the round-trip works.

---

## Part 4 — Validation timing, undo, and the save model

### When to validate: the ledger amendment to GOV.UK

GOV.UK is explicit: *"Do not validate when the user moves away from a field. Wait until they try to move to the next part of the service."* That guidance is correct for a citizen filling one form once, where premature errors punish slow typists. But a heads-down accountant entering their 30th line will not see a submit-time error summary until 40 lines of work later, and by then they have lost the source document. The resolution is to split by **error class**, not by event:

| Class | Example | When | How |
|---|---|---|---|
| **Format / parse** | `"12x4"` in an amount | **On commit (blur/Tab/Enter) of that field only.** Never per keystroke. | Mark `aria-invalid="true"`, `aria-describedby` the message, keep the user's text, let them move on. |
| **Row-level semantic** | Debit *and* Credit both filled; account is a header/control account | **On row blur** — when focus leaves the row entirely. | Inline row-level message. Non-blocking. |
| **Entry-level** | Out of balance; period closed; date outside FY | **Continuously, as advisory status** — never as an error until Post. | The balance chip (Part 5). Not an error, a state. |
| **Server / posting** | FX rate missing; account deactivated since load | **On Post.** | Error summary at top with in-page links to each offending row, focus moved to the summary, `Error:` prefixed to the page `<title>`. |

Absolute rules regardless of class: **never validate on keystroke in an amount field** (`1` in a field that will become `1200` is not an error, and announcing it is hostile), and **never clear or reformat a field the user is still inside**.

### Error prevention beats error messaging

Nielsen Norman's fifth heuristic — *provide constraints and good defaults, upfront, before the user starts typing.* The ledger-specific applications:

- **Do not offer accounts that cannot be posted to.** Header/control/system accounts are filtered out of the picker, not rejected after selection.
- **Do not offer closed periods.** If the date lands in a locked period, the date field shows the lock and the next open date *as you type it*, before Post.
- **Auto-balance instead of scolding.** `Ctrl+B`, plus a clickable "balance to `AED 4,391.66`" affordance on the difference chip. Precedent across the category (Bukku auto-fills the remaining side; several packages ship a "recalculate" control). The difference is always shown as a **signed, named amount** — never just "out of balance".
- **Carry values forward** — date, reference, description, dimension inherit down the entry. This is WCAG 3.3.7 Redundant Entry (Level A) as an ergonomics win: don't ask twice in one session.
- **Confirm only what is irreversible.** Posting is irreversible (a posted entry can only be reversed, never edited) — confirm it, and say *why* in the dialog. Everything else is undoable, so do not confirm it.
- Warn on **suspicious but legal** input rather than blocking: an amount 100× the account's trailing median, a date more than 90 days out, a duplicate of a reference already posted this period. Advisory, dismissible, never a hard stop.

### Undo

- Undo stack is **per journal entry**, not global, and covers: cell edits, row insert/delete, paste, auto-balance, and side-swap. Depth ≥ 50.
- Every undoable action that the user did not directly type — auto-balance, negative side-swap, paste normalisation — must surface a **transient, keyboard-reachable "Undo" affordance** in a `role="status"` region, not a `sonner` toast that vanishes in 4 seconds. (`sonner` is already a dependency; configure `duration: Infinity` for undo toasts and dismiss on the next user action.)
- Undo is **not available across the post boundary.** After Post, the only correction is a reversing entry. Say this in the Post confirmation so it is never a surprise.

### Autosave vs explicit save

The category consensus and the trust research agree: **explicit save for financial commits, autosave for drafts, never mixed within one form.** The ledger has a natural seam to hang this on:

- **Draft** → **autosaved**, silently, debounced ~800ms after typing stops and always on row-blur, to `localStorage`/IndexedDB (`idb` is already a dependency) *and* the server. Show a quiet, non-animated `"Draft saved 14:02"` in a `role="status"`. Restore on reload with an explicit "restore your unsaved journal from 14:02?" prompt — never silently.
- **Post** → **explicit**, always, `Ctrl+Enter` or the button. Never automatic, never on blur, never on navigation.
- **Keep the Save button even though autosave exists.** Users panic without it; its presence is what makes the autosave believable.
- Never let a session timeout eat an entry (WCAG 2.2.1 Timing Adjustable). Warn at 20 hours, extend in place, and keep the local draft regardless.
- Navigating away from a dirty entry gets a `beforeunload` guard *and* a Next.js route-change guard.

---

## Part 5 — Accessibility to WCAG 2.2 AA in a data-dense financial UI

### Colour independence for Dr/Cr and +/− (1.4.1, Level A)

Colour must never be the only carrier. In a ledger, four distinctions need redundant encoding:

| Distinction | Redundant encoding (in addition to colour) |
|---|---|
| **Debit vs Credit** | Separate **columns** with persistent `<th>` labels, plus a `Dr`/`Cr` glyph in the cell's accessible name. Never one column tinted two ways. |
| **Negative amounts** | Accounting parentheses `(1 234,56)` **plus** a text sign in the accessible name (`aria-label="minus 1234.56 dirhams"`), because a screen reader reads `(` as nothing. Offer a user preference for `−` prefix instead of parentheses. |
| **Balanced vs out of balance** | Text: *"Balanced"* / *"Out by AED 4,391.66 (debit heavy)"* + a shape/icon + a border-weight change. The word does the work; the colour confirms it. |
| **Row state** (draft / posted / reversed / pasted / error) | A text badge and an icon. Row tints are a *secondary* cue only, and each tint must keep body text ≥ 4.5:1. |

Test by rendering the whole screen in greyscale. If any state becomes ambiguous, it fails.

### Contrast on dense small text (1.4.3, 1.4.11)

- Body/cell text **4.5:1 minimum** — no exceptions for "de-emphasised" columns. The most common failure in dense financial UIs is a `#9CA3AF` muted column that measures 2.6:1. Our verified muted token is `#646E7B` = **4.95:1** on paper, **4.61:1** on the zebra row.
- **Non-text contrast 3:1** applies to: input borders in the grid, the focus ring against *both* the cell background and the adjacent border, table gridlines that carry meaning, sort-direction arrows, the balance icon, and checkbox outlines. Zebra striping is decorative and exempt — but it must not push any text below 4.5:1, which is why the stripe is `#F2F2EE` (ΔL just enough to read as a row, verified against every foreground token).
- **1.4.12 Text Spacing**: a user stylesheet setting `line-height: 1.5`, `letter-spacing: 0.12em`, `word-spacing: 0.16em` must not clip or overlap anything. This is where dense grids break. Fix by using **`min-height` on rows, never fixed `height`**, and never `overflow: hidden` on a cell that contains text.
- **Tabular figures are an accessibility feature, not a typographic nicety.** `font-variant-numeric: tabular-nums lining-nums` on every amount, so digits sit in fixed-width columns and a user scanning a column of figures gets true vertical alignment. Right-align all amounts; align the decimal.

### Screen-reader announcement of running totals and balance (4.1.3 Status Messages, Level AA)

The balance state is *literally* the canonical case for SC 4.1.3: a status message that must reach a screen-reader user without moving focus.

```html
<!-- Rendered once, high in the form, never conditionally mounted -->
<div role="status" aria-live="polite" aria-atomic="true" class="sr-only" id="je-balance-live"></div>

<!-- The visible chip. aria-hidden so the same fact is not announced twice. -->
<div class="balance-chip" aria-hidden="true"> … </div>
```

Rules that make this usable rather than maddening:

- **Debounce ~600–800ms** after the last keystroke. Announcing on every digit turns typing `12000` into five interruptions.
- **Announce state transitions, not every value.** Fire when balanced↔unbalanced flips, or when the difference changes after a debounce — not on every recalculation.
- **`polite`, never `assertive`.** Assertive would interrupt the user mid-word on a live-updating total.
- **`aria-atomic="true"`** so the full sentence is read, not the bare number: `"Out of balance by 4,391.66 dirhams, debits exceed credits. 12 lines."` — not `"4391.66"`.
- The live region must exist in the DOM **before** it has content. Injecting a `role="status"` element and its text at the same moment means most screen readers announce nothing.
- The visible totals row must be a real `<tfoot>` with `<th scope="row">Total debits</th>` so the numbers are reachable and labelled through normal table navigation, independently of the live region.
- On a **column-total change** driven by a paste, announce the summary once (`"Pasted 12 rows. Total debits 48,120.00."`) rather than per-row.
- Each amount cell's accessible name must carry its column: `aria-label="Debit, line 3, 1,200.00 dirhams"` — otherwise a screen-reader user tabbing through hears a stream of unattributed numbers.

### Focus management and focus visibility (2.4.7, 2.4.11, 2.4.13)

- **A 2px focus ring at 3:1 against every surface it lands on**, with 1px offset so it reads against a filled input. Never `outline: none` without a replacement. In a grid, also give the focused **row** a persistent left marker — knowing *which row* you are in matters as much as which cell.
- **2.4.11 Focus Not Obscured (Minimum), new in 2.2**: a sticky totals bar or sticky header must never fully cover the focused cell. This will happen the first time someone tabs into the last visible row. Fix with `scroll-padding-block: var(--sticky-header-h) var(--sticky-footer-h)` on the scroll container, which makes browser scroll-into-view respect the sticky regions. Test by tabbing down the grid until the sticky footer is reached.
- After Post fails, move focus to the error summary. After Post succeeds, move focus to the success `role="status"` heading of the new entry — do not leave focus on a button that no longer exists.
- Row deletion: move focus to the same column in the **next** row (or previous, if it was the last). Never let focus fall to `<body>`.
- Modal dialogs (Post confirmation, account create) trap focus, restore it on close, close on `Escape`.

### Target size (2.5.8, new in 2.2) in a dense grid

24×24 CSS px minimum for pointer targets. This directly constrains row density. The workable compromise:

- Grid rows: **36px min-height** in dense mode. A 36px row gives every in-cell input a ≥24px target trivially.
- Row action icon buttons: **28×28 minimum**, spaced so the 24px undisplaced circles do not overlap (the spacing exception in 2.5.8).
- Offer a **Comfortable** density at 44px rows as a user preference, and remember it. Density is an accessibility control, not a cosmetic one — motor-impaired and low-vision users need it.
- Sort controls in `<th>` must be the full header cell, not a 12px caret.

### Reduced motion (2.3.3 / prefers-reduced-motion)

A ledger has no business animating, and `framer-motion` is already in the dependency tree, which makes this a live risk.

- Wrap all transitions in `@media (prefers-reduced-motion: no-preference)`, and set `--motion-duration: 0ms` under `reduce`.
- **`animated-number.tsx` exists in this codebase (`src/components/motion/`). Do not use it for ledger totals.** A rolling/counting number is unreadable while it animates, it fires a live-region update per frame if naively bound, and it is precisely the vestibular trigger the criterion targets. Totals change instantly.
- Row insert/delete: a ≤120ms opacity change is fine; height/slide animation is not. Under `reduce`, no transition at all.
- No parallax, no auto-scrolling, no attention-seeking pulse on the balance chip.

### Zoom and reflow at 200% and 400% (1.4.4, 1.4.10)

- **1.4.4 Resize Text (AA)**: at 200% browser zoom **all functionality and content must remain available**. There is no data-table exception here. Everything must be in `rem`, no fixed `px` heights on containers, no `overflow: hidden` clipping text.
- **1.4.10 Reflow (AA)**: no two-dimensional scrolling at 320px-equivalent width. **Data tables are explicitly excepted** from the two-axis rule — but the exception covers *the table only*, and only the table. So:
  - Wrap the grid in `<div role="region" aria-labelledby="…" tabindex="0" class="overflow-x-auto">` — a focusable, labelled scroll container so keyboard users can scroll it and screen readers announce it as a region.
  - **Everything outside the table must reflow into one column** at 320px: header form, action bar, filters, the balance chip. Page-level horizontal scroll is a failure.
  - The sticky totals row must remain visible and must not consume more than ~30% of a 256px-tall viewport.
- Practical target: usable at **1280px × 400% zoom**, and at **200%** with no loss at all. For the mobile/narrow case, ship a **stacked card view** of the entry (one card per line, label-value pairs) rather than trying to compress a 7-column grid — this is what actually works, and it is the same view a business owner on a phone should get.

### RTL / Arabic (UAE requirement, `src/app/ar/`)

- Set `dir` on the table container, not on individual cells. Column order mirrors: Account moves right, actions move left.
- **Amounts stay LTR inside an RTL row.** Wrap every numeric cell in `<span dir="ltr">` or set `unicode-bidi: isolate`, or `AED 1,234.56` will render with the currency code and minus sign in the wrong place. This is the single most common RTL financial bug.
- Use **logical CSS properties throughout** — `margin-inline-start`, `padding-inline`, `border-inline-start`, `text-align: end` — so one stylesheet serves both directions. Tailwind's `ps-*`/`pe-*`/`ms-*`/`me-*`/`start-*`/`end-*` utilities do this.
- Arrow-key navigation must respect direction: in RTL, `ArrowRight` moves to the *previous* column. Read `getComputedStyle(el).direction`, don't hardcode.
- Arabic-Indic digits (`٠١٢٣`) as a display preference; **always store and parse Latin digits**, and accept Arabic-Indic input by normalising on parse.

---

## Verification checklist

Run these before calling the grid done. Each is a pass/fail an engineer can execute.

1. **Mouse unplugged.** Post a 12-line balanced journal, including one calculator expression, one paste from Excel, one row deletion, and one undo. If you reach for the mouse once, the flow is broken.
2. **Screen reader** (NVDA + Firefox, VoiceOver + Safari): tab through the grid — every cell announces its column header and row number; the balance state is announced on change and only on change; the totals row is reachable via table navigation.
3. **Greyscale render**: debit vs credit, negative vs positive, balanced vs unbalanced, draft vs posted all remain unambiguous.
4. **200% zoom**: no loss of content or function. **400% zoom at 1280px**: only the table scrolls horizontally; the page does not.
5. **Text-spacing bookmarklet** (1.4.12 values): no clipping or overlap in any row.
6. **`prefers-reduced-motion: reduce`** in OS settings: nothing on the screen moves.
7. **Automated contrast sweep** on the rendered grid in both themes, including every row-state tint against every foreground token.
8. **`dir="rtl"`**: amounts render correctly, arrow keys move in the visually correct direction.
9. **Tab into the last row** with the sticky footer present: the focused cell is fully visible (2.4.11).
10. **Kill the tab mid-entry, reopen**: the draft is offered for restore, and nothing was silently posted.

---

## Sources

- [ARIA Authoring Practices — Grid Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/grid/) · [Developing a Keyboard Interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) · [What's New in WCAG 2.2](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/) · [Understanding 2.4.11 Focus Not Obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html) · [Understanding 2.5.8 Target Size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) · [Understanding 1.4.10 Reflow](https://www.w3.org/WAI/WCAG21/Understanding/reflow.html) · [Understanding 1.4.1 Use of Color](https://www.w3.org/TR/UNDERSTANDING-WCAG20/visual-audio-contrast-without-color.html)
- [GOV.UK Design System — Recover from validation errors](https://design-system.service.gov.uk/patterns/validation/) · [Error message](https://design-system.service.gov.uk/components/error-message/) · [Error summary](https://design-system.service.gov.uk/components/error-summary/)
- [Digg / Webbriktlinjer — Visa var ett fel uppstått och beskriv det tydligt](https://www.digg.se/webbriktlinjer/riktlinjer/2-ge-begripliga-felmeddelanden/) · [Ge tydlig återkoppling i e-tjänster](https://webbriktlinjer.se/riktlinjer/77-notifiera-och-ge-anvandaren-aterkoppling/) · [Skapa tillgängligt innehåll med HTML och stilmallar](https://www.digg.se/kunskap-och-stod/regler-och-rekommendationer/regler-och-rekommendationer/skapa-tillgangligt-innehall-med-html-och-stilmallar)
- [Fortnox — Kortkommandon](https://support.fortnox.se/hantera-fortnox/allman-info/kortkommandon) · [Fortnox — Skapa verifikation](https://support.fortnox.se/produkthjalp/bokforing/skapa-verifikation)
- [Sage 50 — Keyboard Shortcuts](https://help-sage50.na.sage.com/en-us/2019/Content/Basics/Keyboard_Shortcuts.htm) · [Xero shortcuts, tips and tricks (calculator in Debit/Credit fields)](https://www.mkgpartners.com.au/xero-shortcuts-tips-and-tricks/)
- [Adrian Roselli — ARIA Grid As an Anti-Pattern](https://adrianroselli.com/2020/07/aria-grid-as-an-anti-pattern.html) · [Don't Turn a Table into an ARIA Grid Just for a Clickable Row](https://adrianroselli.com/2023/11/dont-turn-a-table-into-an-aria-grid-just-for-a-clickable-row.html) · [Sarah Higley — Grids Part 2: Semantics](https://sarahmhigley.com/writing/grids-part2/)
- [NN/g — Preventing User Errors: Avoiding Unconscious Slips](https://www.nngroup.com/articles/slips/) · [10 Usability Heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/) · [Hostile Patterns in Error Messages](https://www.nngroup.com/articles/hostile-error-messages/)
- [AG Grid — Clipboard (TSV paste model)](https://www.ag-grid.com/react-data-grid/clipboard/) · [David Luhr — A deep dive on the UX of number inputs](https://luhr.co/blog/2025/07/01/a-deep-dive-on-the-ux-of-number-inputs/) · [Primer — Saving patterns](https://primer.style/product/ui-patterns/saving/) · [MDN — font-variant-numeric](https://developer.mozilla.org/docs/Web/CSS/font-variant-numeric)
