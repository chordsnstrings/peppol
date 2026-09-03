## 0. What is already on disk

Ground truth from `/home/user/peppol`, because three of the five tracks assume a greenfield that does not exist:

| Path | State | Verdict |
|---|---|---|
| `/home/user/peppol/prisma/schema.prisma` | Ledger models already exist (lines 300–519): `Book`, `Account`, `FiscalYear`, `AccountingPeriod`, `Dimension`, `DimensionValue`, `JournalEntry`, `JournalLine`, `JournalLineDimension`, `AccountBalance`, `DocumentSequence` | **Keep the shapes, amend per §3** |
| `.../migrations/20260903041350_ledger_core/migration.sql` | Balance/immutability/period/line-guard triggers + `gl_next_number` | **Keep, patch 4 defects (§3.6)** |
| `.../migrations/20260903042500_ledger_fx_balance/migration.sql` | Relaxes per-currency balance to functional-only for multi-currency entries | **Keep — it is correct, and it contradicts Track 3 (§3.1)** |
| `/home/user/peppol/src/lib/domain/money.ts` | `number` arithmetic, `MINOR_PER_MAJOR = 100` hardcoded, `parseFloat` | **FROZEN to invoicing. Banned from the ledger** |
| `/home/user/peppol/src/lib/ledger/format.ts` | BigInt formatter + recursive-descent expression parser | **Keep the shape; `evalExpr` evaluates in JS floats — rewrite (§4.T0)** |
| `/home/user/peppol/src/styles/ledger.css` | `.sw`-scoped Swedish token block, 342 lines | **Replace the token block with §1; keep the scoping strategy** |
| `/home/user/peppol/src/app/globals.css` | `--ring: 43 55% 52%` (gold) | **Move `--ring` to accent (§1.6)** |
| `/home/user/peppol/tailwind.config.ts` | `gradient-pan`, `marquee`, `shimmer`, `gold-sheen`, `glow`, `pulse-ring` | **Delete all six (§5)** |
| `/home/user/peppol/src/components/motion/animated-number.tsx` | exists | **Banned from every ledger surface** |
| `/home/user/peppol/src/components/ledger/` | `entry-grid.tsx` (380 ln), `primitives.tsx`, `use-ledger.ts`, `ledger-nav.tsx` | **Rebuild against §4 — current grid predates the density and a11y rules** |

---

## 1. The design system

### 1.1 The three ideas the palette encodes

**Lagom is not minimalism.** Every source is explicit: lagom is "not about minimalism or austerity, nor about abundance." Whitespace maximalism *is* austerity. We target information density.

**Josef Frank's rule governs that density:** *"The monochromatic surface appears uneasy, while prints are calming."* A filled table of numerals is the print. A vast empty white expanse is the uneasy surface. Density is the Swedish choice, not a concession to accountants.

**Ljusinsläpp is a contrast strategy, not a whitespace strategy.** The ledger canvas is the palest surface on screen and gets the most area. The chrome around it — sidebar `#1B1A22`, toolbars on `--sw-ground-sunk` — is darker, so the data reads as the light source. This is why the sidebar stays dark in *both* themes.

### 1.2 The neutral ramp

Warm at the light end (`#F4F1E9`, limewash), violet at the dark end (`#1C1A24`, `#14131A`). Never a uniform blue-grey. Tailwind `slate`/`zinc` in a ledger surface is the fingerprint of generic AI minimalism and is a review block.

Never `#FFFFFF`, never `#000000`. Klarna's own white is `#F9F8F5` and its black is `#0B051D`; ours are `#F4F1E9` and `#1C1A24`.

### 1.3 The two colour systems that never collide

This is the load-bearing rule of the whole palette:

| System | Lives on | Hues | Never |
|---|---|---|---|
| **Debit / Credit** | Chrome only — small-caps headers, 1px column rules, Dr/Cr badges | `--sw-debit` blue-grey, `--sw-credit` ochre | Never tints a figure |
| **Positive / Negative** | Numerals only — the glyph and its digits | `--sw-neg` falu red, `--sw-pos` pine | Never on a header or a rule |

Because they occupy different visual roles, the neighbouring hues (`#34405A` next to `#8A5A1E`) do not read as a clash. Put credit ochre on a number and the system collapses immediately.

### 1.4 One accent, and the gold retirement

`--sw-accent: #006AA7` — Swedish flag blue, NCS 4055-R95B; `#5FA8D3` in dark. It appears on focus rings, primary buttons, selected rows, active nav, links and the primary chart series. **It never appears on a number.**

The app's existing `--gold` (`43 55% 52%`) is **retired as a brand accent**. An ochre accent collides with the credit semantic on every screen that shows both. The hue survives, demoted, as `--sw-credit`. `--ring` moves from gold to accent in `globals.css`.

### 1.5 Colour is never the only carrier

Falu red and pine both collapse to the same brown under deuteranopia. Therefore:

- Statements: **parentheses, no colour.** `(1,234.56)`
- Transaction lists: **U+2212 MINUS SIGN** (not a hyphen) **plus** colour as a secondary cue. `−1,234.56`
- Screen readers get the sign spoken: `aria-label="minus 1,234.56 dirhams"` — a screen reader does not announce `(`.
- User preference to swap parentheses for a `−` prefix everywhere.
- **Acceptance gate:** render the whole screen in greyscale. Any state that becomes ambiguous fails.

**Positives take plain `--sw-fg` ink.** Green-for-positive is a trading idiom, not accounting. `--sw-pos` is restricted to variance/delta columns explicitly labelled as change, and to the balanced/reconciled confirmation band. It never touches a balance.

### 1.6 No new hues

`--sw-warn` **aliases** `--sw-credit`. `--sw-info` **aliases** `--sw-accent`. Do not invent hues; distinguish by *treatment* — a warning is a filled tint band with an icon, a credit label is small-caps with a rule. Total data hues across the entire ledger: **five** (ink, accent, debit, credit, neg). `--sw-frank` is chrome, not data, and does not count.

### 1.7 The Frank moment

Josef Frank rose `#E9A6BC`, **one per screen, at most 2% of screen area**: the balanced-entry confirmation, empty states, the closed-period seal. Never on data, never a status colour, never a brand colour.

### 1.8 Elevation

Elevation is **hairlines and surface value**, not shadows.

- The ledger: `--sw-shadow-0: none`. Always.
- **Dark mode: zero shadows, universally.** Elevation is surface lightness only — `--sw-surface-raised` is the entire signal.
- Where shadows are allowed (light-mode popovers and dialogs) they are **low-angle**: small y-offset, wide blur, tinted with the violet ink `rgb(28 26 36 / …)`, never neutral black. Low winter sun casts long soft shadows.
- Cards sit on the ground with a **visible 1px edge** — Svenskt Tenn's "tall legs". Never melted in with a blur.

### 1.9 Radii

Capped at **8px**, derived from bentwood lamination — the tightest radius a laminated bend holds. Table cells, table rows, the ledger region and the entry grid are **`--sw-r-0: 0`**. Rounding a grid is dishonest construction about where the cell ends.

### 1.10 Typography — real faces

| Token | Face | Why |
|---|---|---|
| `--sw-font-sans` | **Inter** (Google Fonts) — already loaded in `src/app/layout.tsx` | Rasmus Andersson is Swedish. Inter is the closest publicly-licensable relative of Sweden Sans, and its `zero` feature supplies Sweden Sans's own signature — *a line that cuts through the zero* — which stops `4010` reading as `4O1O` in an account-code column. Sweden Sans itself (Söderhavet, 2014) is not licensable. |
| `--sw-font-display` | **Familjen Grotesk** (Google Fonts) | A Swedish grotesk. **Marketing and page titles only — never enters a ledger surface.** |
| `--sw-font-mono` | **JetBrains Mono** — already loaded | Hashes, UUIDs, UBL/XML payloads, API keys. **Not** account codes, **not** money: figures stay in Inter with `tnum` so the code column aligns optically with the name column beside it. |

**Drop `Sora` and `Bricolage_Grotesque` from all app surfaces.** Neither has Swedish provenance. Bricolage may stay on `(marketing)` if the team wants the divergence.

Ledger body is **13px / 20** (`--sw-fs-sm`) with `font-variant-numeric: tabular-nums lining-nums` and `font-feature-settings: "zero" 1` on account codes.

### 1.11 The rem rule, stated precisely

Track 1 says "everything in rem so browser zoom works" but ships px spacing. The honest rule:

- **rem:** type sizes, line heights, row heights, cell padding, column widths. These must grow when a user raises their base font size, or rows clip.
- **px:** hairlines (`1px`), the total double rule (`3px`), the focus ring (`2px`), radii. A hairline that scales stops being a hairline.

---

## 2. The density rules

### 2.1 Resolving the density conflict

Four tracks gave four answers. Resolution:

| Track | Claim | Ruling |
|---|---|---|
| Design language | 28/32/40, user setting | **Row values adopted, recalibrated** |
| UX | Ship **one** density (28px), no toggle | **Overruled** on the accessibility argument — but its instinct survives: density is *one per-user preference*, not a per-table control |
| WCAG | 36px dense, 44px comfortable, density *is* an accessibility control | **Wins for the editable grid**; its 36px minimum for read-only tables is over-conservative |
| Inventory | Calibrate to the task: 28 scan / 32 default / 36 entry | **Wins the framing** |

**Final: density is calibrated by surface, then modified by one remembered user preference.**

| Surface | Compact | **Default** | Comfortable |
|---|---|---|---|
| Read-only ledger, trial balance, account browser, GL | 28px | **32px** | 44px |
| Editable journal grid, bank reconciliation | *not offered* | **36px** | 44px |

The editable grid has no compact option and 36px is a hard floor. A row that hosts an in-cell input **and** a 28×28 row-action button must clear WCAG 2.5.8's 24×24 target minimum with non-overlapping spacing. 28px cannot do that. Read-only rows host no targets and 28px is legal there.

**`min-block-size`, never `height`.** WCAG 1.4.12 text-spacing overrides (line-height 1.5, letter-spacing 0.12em, word-spacing 0.16em) must not clip. Never `overflow: hidden` on a cell containing text.

### 2.2 The 28-lines claim, corrected

Track 1 asks for "at least 28 journal lines at a 900px viewport." That is not achievable at 32px rows once real chrome is counted. The honest, testable budget:

```
900px viewport
− 56  app header
− 168 editor page chrome (title, header form, toolbar)  ← capped by this spec
− 40  sticky thead (--sw-row-h-head)
− 56  sticky tfoot (--sw-row-h-foot)
= 580px of rows
```

**Acceptance test:** ≥ 16 lines at 36px entry default, ≥ 20 at 32px, ≥ 24 at 28px, all at 900px viewport height, with editor page chrome ≤ 168px. Any design that pushes chrome past 168px fails the test, not the row height.

### 2.3 No zebra striping. The three-weight rule system instead.

Zebra stripes carry one bit of information (odd/even). Real accounting typography carries more:

```css
tbody tr            { border-block-end: 1px solid var(--sw-rule); }
td + td             { border-inline-start: 1px solid var(--sw-rule-strong); }  /* column dividers */
tr[data-subtotal]   { border-block-start: 1px solid var(--sw-rule-total); }
tr[data-grandtotal] { border-block-end: 3px double var(--sw-rule-total); }
tbody tr:hover      { background: var(--sw-row-hover); }
tr[data-focused]    { box-shadow: inset 2px 0 0 0 var(--sw-row-marker); }
```

Also: this removes Track 4's zebra-row contrast problem at the source. There is no zebra row to verify.

### 2.4 Numeral treatment

Non-negotiable on every figure:

```css
.sw-num {
  font-variant-numeric: tabular-nums lining-nums;
  text-align: end;
  display: grid;
  grid-template-columns: 1fr var(--sw-num-gutter);  /* 1ch reserved */
  padding-inline-end: var(--sw-cell-x-num);
  white-space: nowrap;
}
```

The reserved `1ch` right gutter is what lets parentheses hang *outside* the digit column so digits stay vertically true across a 200-row column. Without it, every negative row shifts by one character and the column stops being scannable.

- **Debit and Credit columns never display a sign.** The column *is* the sign.
- **Currency code once in the header**, never per row.
- **Zero is an en dash `–` in statements.** `0.00` appears only where a zero was genuinely entered on a journal line. Empty and zero are different accounting assertions.
- **An empty amount cell stays visually empty.** Never render `0.00` as a placeholder.
- **Money is never compacted in a ledger surface.** No `12.4k`. Compaction is for KPI tiles only.

### 2.5 Alignment is derived, not hand-set

Alignment is a property of the **column kind**, resolved once in the table primitive:

| Kind | Align | Numerals | Header align |
|---|---|---|---|
| money, count | end | tabular | **end** |
| code, date | start | tabular + `zero` | start |
| text | start | — | start |
| status | start, fixed width | — | start |

A right-aligned money column gets a right-aligned header. Status columns get a fixed width so pills never jitter row to row. Nothing is centred, ever.

### 2.6 Acceptera the real data

**Never truncate an account name with an ellipsis to keep the column tidy.** Give the column a drag handle and a `title` attribute. Columns are resizable, reorderable and hideable — *"lightweight, movable, flexible according to the inhabitants' needs."*

### 2.7 Contrast, computed

WCAG 2.1 AA is a hard gate (Sweden's DOS-lagen → EN 301 549). Every foreground token is verified against the **darkest surface it can land on**, which is `--sw-row-hover` / `--sw-ground-sunk`, not `--sw-surface`.

**One research token failed and is corrected here.** `--sw-fg-muted: #6E6A62` measures **4.39:1** on `--sw-row-hover #EDE9DF` — a fail. Replaced with **`#67635B`**: 4.90:1 on row-hover, 5.26:1 on ground, 5.75:1 on surface. Still warm (R>G>B), still not blue-grey.

`--sw-fg-subtle` is **renamed `--sw-fg-disabled`** (3.24:1 light, 3.86:1 dark — AA-large only). The rename is deliberate: the commonest dense-financial-UI failure is a muted secondary column at 2.6:1, and it happens because a "subtle" token is sitting there looking reachable. There is now exactly one de-emphasis token and it passes AA.

Verified body ratios on `--sw-surface`: accent 5.56 / 6.59 · neg 7.95 / 5.80 · pos 6.03 / 6.63 · credit 5.70 / 7.49 · debit 10.06 / 8.48 (light / dark).

Non-text 3:1 (WCAG 1.4.11) applies to: grid input borders, the focus ring against both the cell background *and* the adjacent border, meaningful gridlines, sort arrows, checkbox outlines. `--sw-rule-strong` is the token that carries this; `--sw-rule` is decorative and exempt.

### 2.8 The ledger is not a card

It runs **edge-to-edge in its region with a single top hairline**. Cards are for summaries. The scroll wrapper required for accessibility is semantic only and carries no visual treatment:

```html
<div role="region" aria-labelledby="gl-caption" tabindex="0"
     class="overflow-x-auto"
     style="scroll-padding-block: var(--sw-row-h-head) var(--sw-row-h-foot)">
```

The `scroll-padding-block` is what keeps a focused cell from being covered by the sticky totals bar (WCAG 2.4.11 Focus Not Obscured, new in 2.2). Test by tabbing to the last visible row.

Everything **outside** the table — header form, action bar, filters, balance chip — reflows to a single column at 320px. Data tables are excepted from WCAG 1.4.10's two-axis rule; *the exception covers the table only*. Page-level horizontal scroll is a failure regardless. Verify at 1280×400% zoom and at 200% zoom with no loss of function.

Below `640px`, ship the **stacked card view** — one card per line, label/value pairs. It is also the right view for a business owner on a phone.

### 2.9 RTL

`src/app/ar/` exists, so this is live, not theoretical.

- Every numeric cell gets `dir="ltr"` or `unicode-bidi: isolate`. Without it the currency code and minus sign render on the wrong side — the single most common RTL financial bug.
- **Numerals stay Latin and money stays right-aligned in RTL.** Layout mirrors; numeric alignment does not.
- CSS **logical properties throughout** (`padding-inline`, `border-inline-start`, `text-align: end`; Tailwind `ps-/pe-/ms-/me-/start-/end-`). One stylesheet serves both directions.
- Arrow-key direction is derived from `getComputedStyle(el).direction`, never hardcoded. In RTL, ArrowRight moves to the *previous* column.
- Accept Arabic-Indic digits `٠١٢٣٤٥٦٧٨٩` and `٫` (U+066B) on input, normalise to Latin on parse, always store Latin. Arabic-Indic display is a locale preference.

### 2.10 Charts

Three colours maximum: `--sw-accent` for the primary series, `--sw-fg` at 40% for comparison, `--sw-credit` for a third. Never a rainbow.

---

## 3. The ledger schema

### 3.1 Resolved conflict: the balance invariant

**Track 3 says:** debits equal credits *per currency*, checked on transaction amounts before any FX arithmetic, "because rates move and the invariant must not depend on them."

**The existing migration `20260903042500` reverses this**, arguing a genuine FX transaction balances only after conversion.

**The existing migration is right; Track 3's stated *reason* is right but its *mechanism* is wrong.** Receiving USD 1,000 against an AED 3,670 receivable is one economic event whose sides are in different currencies. Per-currency it nets +1000 USD and −3670 AED; neither is zero. Strict per-currency balance makes multi-currency accounting impossible.

Track 3's real requirement — *the invariant must not depend on a rate that can later move* — is satisfied by **freezing the rate and rate date on the line at posting time and making them immutable**, not by per-currency balance.

**Final rule:**
1. The ledger balances in the **functional currency**, always, no exception.
2. Per-currency balance is **additionally** enforced when the entry is single-currency — free, and it produces a far better error message for the common mistake.
3. `fxRate` + `fxRateDate` are captured at posting and frozen. The functional amount is never re-derived.

### 3.2 Resolved conflict: sign convention

Track 2 and Track 4 say "the ledger never stores a negative debit" and "a line carrying both debit and credit is a hard block." The schema stores **one signed `txnAmountMinor`** — debit positive, credit negative.

These do not conflict; they are talking about different layers. Making it explicit:

- **Storage:** one signed column. "Balanced" is literally `SUM() = 0`.
- **A negative debit is not representable.** A line carrying both Dr and Cr is not representable. The two UI hard-blocks are *structural*, not validated.
- **The Dr/Cr two-column grid is a pure view transform.** A minus typed into Debit moves `abs()` into Credit on commit; the swap is announced in a live region with an Undo; a per-user setting disables it.

### 3.3 Resolved conflict: delete

Track 2 permits deleting the last journal in a series in an open period with no dependents. Track 3 forbids deleting a posted entry by any route.

**Track 3 wins.** Track 2's exception exists to preserve gaplessness, and the `UPDATE`-based allocator already gives us that: a rolled-back transaction restores `nextNo`, so no hole is left. Delete buys nothing and costs immutability.

**Nothing posted is ever deleted.** Drafts delete freely — they are not the ledger.

### 3.4 Resolved conflict: drafts

Track 3: *"Drafts live in a separate table and are not part of the ledger. Nothing enters JournalEntry unposted."* The current schema has `status: 'draft'` inside `JournalEntry`.

**Track 3 wins.** Drafts move to `JournalDraft` (JSONB payload, may be unbalanced, freely editable and deletable). `JournalEntry.status` narrows to `('posted','reversed')`. This is also what makes Track 2's *"assign journal numbers at post, never at draft creation"* structurally true rather than a convention.

### 3.5 Resolved conflict: control accounts in the picker

Track 4: filter unpostable accounts out of the picker entirely — prevent the error, don't message it.
Track 5: disabled options are shown with their reason, never hidden.

**Split by cause:**
- **Header and system accounts** — never postable by anyone, ever. **Filtered out.**
- **Control accounts (AR/AP/VAT/bank)** — postable, just not from *here*. **Shown disabled with the reason**: *"Owned by Accounts Receivable — post from an invoice."* A user reasonably expects to find AR in the list and needs to learn where it lives.

### 3.6 Four defects in the existing migration

1. **`gl_entry_guard` immutability is a denylist.** It blocks `bookId`, `periodId`, `entryDate`, `number`, `series`, `orgId`, `entityId` — so `memo`, `source`, `actorId` and *every column added in future* are silently mutable on a posted entry. Track 3 requires an allowlist. Fixed below with `to_jsonb()` subtraction.
2. **`gl_entry_guard` does not block `posted → draft`.** It checks `reversed → *` but not `posted → draft`, so a posted entry can be un-posted. Moot once drafts leave the table, but the status-transition matrix goes in anyway.
3. **`gl_next_number` races.** Two concurrent postings for a scope with no `DocumentSequence` row both take the `NOT FOUND` branch and both `INSERT` → unique violation on `(orgId, entityId, scope)`. Needs `ON CONFLICT DO UPDATE`.
4. **`AccountBalance` is an UPDATE-a-running-total design**, which Track 3 explicitly rejects: two postings to the same control account serialise on the same row. Replaced with INSERT-only movements + sealed anchors.

### 3.7 The DDL

```sql
-- ═════════════════════════════════════════════════════════════════════════
-- 0. CURRENCY REGISTRY — scale is data, never a hardcoded 100
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE "Currency" (
  code        CHAR(3) PRIMARY KEY,
  name        TEXT     NOT NULL,
  "minorUnits" SMALLINT NOT NULL CHECK ("minorUnits" BETWEEN 0 AND 4)
);
INSERT INTO "Currency" (code, name, "minorUnits") VALUES
  ('AED','UAE Dirham',2), ('USD','US Dollar',2), ('EUR','Euro',2),
  ('GBP','Pound Sterling',2), ('SAR','Saudi Riyal',2), ('SEK','Swedish Krona',2),
  ('KWD','Kuwaiti Dinar',3), ('BHD','Bahraini Dinar',3), ('OMR','Omani Rial',3),
  ('JOD','Jordanian Dinar',3), ('TND','Tunisian Dinar',3),
  ('JPY','Japanese Yen',0), ('KRW','South Korean Won',0), ('ISK','Icelandic Krona',0);

-- ═════════════════════════════════════════════════════════════════════════
-- 1. TENANT-COMPOSITE KEYS — a row can never reference another tenant's row
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE "Book"             ADD CONSTRAINT "Book_org_id_uq"    UNIQUE ("orgId","id");
ALTER TABLE "Account"          ADD CONSTRAINT "Account_org_id_uq" UNIQUE ("orgId","id");
ALTER TABLE "AccountingPeriod" ADD CONSTRAINT "Period_org_id_uq"  UNIQUE ("orgId","id");
ALTER TABLE "FiscalYear"       ADD CONSTRAINT "FY_org_id_uq"      UNIQUE ("orgId","id");
ALTER TABLE "JournalEntry"     ADD CONSTRAINT "Entry_org_id_uq"   UNIQUE ("orgId","id");
ALTER TABLE "JournalLine"      ADD CONSTRAINT "Line_org_id_uq"    UNIQUE ("orgId","id");
ALTER TABLE "DimensionValue"   ADD CONSTRAINT "DimVal_org_id_uq"  UNIQUE ("orgId","id");

ALTER TABLE "JournalEntry" DROP CONSTRAINT "JournalEntry_bookId_fkey";
ALTER TABLE "JournalEntry" ADD  CONSTRAINT "JournalEntry_book_fkey"
  FOREIGN KEY ("orgId","bookId")   REFERENCES "Book"("orgId","id") ON DELETE RESTRICT;
ALTER TABLE "JournalEntry" DROP CONSTRAINT "JournalEntry_periodId_fkey";
ALTER TABLE "JournalEntry" ADD  CONSTRAINT "JournalEntry_period_fkey"
  FOREIGN KEY ("orgId","periodId") REFERENCES "AccountingPeriod"("orgId","id") ON DELETE RESTRICT;
ALTER TABLE "JournalLine"  DROP CONSTRAINT "JournalLine_entryId_fkey";
ALTER TABLE "JournalLine"  ADD  CONSTRAINT "JournalLine_entry_fkey"
  FOREIGN KEY ("orgId","entryId")  REFERENCES "JournalEntry"("orgId","id") ON DELETE CASCADE;
ALTER TABLE "JournalLine"  DROP CONSTRAINT "JournalLine_accountId_fkey";
ALTER TABLE "JournalLine"  ADD  CONSTRAINT "JournalLine_account_fkey"
  FOREIGN KEY ("orgId","accountId") REFERENCES "Account"("orgId","id") ON DELETE RESTRICT;
-- …repeat for JournalLineDimension, AccountMovement, PeriodAnchor.

-- ═════════════════════════════════════════════════════════════════════════
-- 2. DRAFTS LEAVE THE LEDGER
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE "JournalDraft" (
  id           TEXT PRIMARY KEY,
  "orgId"      TEXT NOT NULL,
  "entityId"   TEXT NOT NULL,
  "bookId"     TEXT NOT NULL,
  "entryDate"  DATE,
  series       TEXT NOT NULL DEFAULT 'GJ',
  memo         TEXT,
  payload      JSONB NOT NULL,        -- lines as entered; may be unbalanced
  "updatedBy"  TEXT,
  "updatedAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("orgId", id)
);
CREATE INDEX ON "JournalDraft" ("orgId","entityId","updatedAt" DESC);

ALTER TABLE "JournalEntry" DROP CONSTRAINT "entry_status_chk";
ALTER TABLE "JournalEntry" ADD  CONSTRAINT "entry_status_chk"
  CHECK (status IN ('posted','reversed'));
ALTER TABLE "JournalEntry" ALTER COLUMN status SET DEFAULT 'posted';
ALTER TABLE "JournalEntry" ALTER COLUMN "postedAt" SET NOT NULL;
ALTER TABLE "JournalEntry" ADD COLUMN "reversedById"   TEXT,
                           ADD COLUMN "reversalReason" TEXT,
                           ADD COLUMN "overrideBadge"  TEXT;  -- period-unlock override provenance

-- ═════════════════════════════════════════════════════════════════════════
-- 3. LINES: three currency concepts, rate frozen at posting
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE "JournalLine"
  ADD COLUMN "fxRateDate"            DATE,
  ADD COLUMN "presentationCurrency"  CHAR(3),
  ADD COLUMN "presentationAmountMinor" BIGINT,
  ADD COLUMN "sourceExpression"      TEXT;   -- how the bookkeeper derived the number
ALTER TABLE "JournalLine" ADD CONSTRAINT "line_txn_ccy_fk"
  FOREIGN KEY ("txnCurrency") REFERENCES "Currency"(code);
ALTER TABLE "JournalLine" ADD CONSTRAINT "line_fn_ccy_fk"
  FOREIGN KEY ("functionalCurrency") REFERENCES "Currency"(code);
ALTER TABLE "JournalLine" ADD CONSTRAINT "line_nonzero_chk"
  CHECK ("txnAmountMinor" <> 0);
ALTER TABLE "JournalLine" ADD CONSTRAINT "line_rate_positive_chk"
  CHECK ("fxRate" > 0);

-- ═════════════════════════════════════════════════════════════════════════
-- 4. BALANCES: INSERT-only deltas + sealed anchors. Never SUM() the ledger,
--    never UPDATE a running total (two postings to AR must not block).
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE "AccountMovement" (
  id                     BIGSERIAL PRIMARY KEY,
  "orgId"     TEXT NOT NULL, "entityId" TEXT NOT NULL, "bookId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL, "periodId" TEXT NOT NULL,
  currency               CHAR(3) NOT NULL REFERENCES "Currency"(code),
  "txnDeltaMinor"        BIGINT  NOT NULL,
  "functionalDeltaMinor" BIGINT  NOT NULL,
  "entryId"              TEXT    NOT NULL,
  "postedAt"             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON "AccountMovement" ("orgId","bookId","accountId","periodId",currency);
CREATE INDEX ON "AccountMovement" ("entryId");

CREATE TABLE "PeriodAnchor" (
  "orgId"        TEXT NOT NULL, "bookId" TEXT NOT NULL,
  "accountId"    TEXT NOT NULL, "periodId" TEXT NOT NULL,
  currency       CHAR(3) NOT NULL,
  "openingMinor" BIGINT NOT NULL, "debitMinor"  BIGINT NOT NULL,
  "creditMinor"  BIGINT NOT NULL, "closingMinor" BIGINT NOT NULL,
  "sealedAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("bookId","accountId","periodId",currency)
);
DROP TABLE "AccountBalance";
-- Read path: closing of the newest sealed PeriodAnchor at-or-before the target
-- period, plus SUM(AccountMovement) for periods after it. Never a full scan.

-- ═════════════════════════════════════════════════════════════════════════
-- 5. IMMUTABILITY BY ALLOWLIST — any column added later is immutable by default
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION gl_entry_guard() RETURNS TRIGGER AS $$
DECLARE v_status TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger: entry % cannot be deleted — correct by reversal', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'status' - 'reversedById' - 'reversalReason')
       IS DISTINCT FROM
       (to_jsonb(OLD) - 'status' - 'reversedById' - 'reversalReason') THEN
      RAISE EXCEPTION
        'ledger: posted entry % is immutable — only status, reversedById and reversalReason may change',
        OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (OLD.status || '>' || NEW.status IN
            ('posted>posted','posted>reversed','reversed>reversed')) THEN
      RAISE EXCEPTION 'ledger: illegal status transition % -> %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT: only into an OPEN period, and only from gl_post()
  IF current_setting('app.in_gl_post', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'ledger: direct INSERT refused — use gl_post()'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT status INTO v_status FROM "AccountingPeriod" WHERE id = NEW."periodId";
  IF v_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'ledger: accounting period is % — posting refused',
      COALESCE(v_status,'missing') USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION gl_line_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ledger: a journal line may never be % — correct by reversal', TG_OP
    USING ERRCODE = 'check_violation';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "gl_line_no_update" BEFORE UPDATE OR DELETE ON "JournalLine"
  FOR EACH ROW EXECUTE FUNCTION gl_line_immutable();

-- ═════════════════════════════════════════════════════════════════════════
-- 6. PERIODS — 'locked' is terminal, by any route, for any role
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION gl_period_guard() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'locked' AND NEW.status <> 'locked' THEN
    RAISE EXCEPTION 'ledger: period % is locked — a filed statutory period never reopens', OLD.label
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (OLD.status || '>' || NEW.status IN (
      'open>open','open>soft_closed',
      'soft_closed>soft_closed','soft_closed>open','soft_closed>hard_closed',
      'hard_closed>hard_closed','hard_closed>soft_closed','hard_closed>locked',
      'locked>locked')) THEN
    RAISE EXCEPTION 'ledger: illegal period transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "gl_period_guard_trg" BEFORE UPDATE ON "AccountingPeriod"
  FOR EACH ROW EXECUTE FUNCTION gl_period_guard();

-- ═════════════════════════════════════════════════════════════════════════
-- 7. GAPLESS NUMBERING per (org, entity, series). Never a SEQUENCE:
--    nextval() is non-transactional and leaves holes on rollback.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION gl_next_number(p_org TEXT, p_entity TEXT, p_scope TEXT)
RETURNS TEXT AS $$
DECLARE r RECORD;
BEGIN
  INSERT INTO "DocumentSequence" (id,"orgId","entityId",scope,prefix,"nextNo",padding,"updatedAt")
  VALUES (gen_random_uuid()::text, p_org, p_entity, p_scope, '', 1, 5, now())
  ON CONFLICT ("orgId","entityId",scope) DO NOTHING;      -- ← fixes the race

  UPDATE "DocumentSequence"
     SET "nextNo" = "nextNo" + 1, "updatedAt" = now()
   WHERE "orgId" = p_org AND "entityId" = p_entity AND scope = p_scope
  RETURNING prefix, ("nextNo" - 1) AS n, padding INTO r;

  RETURN r.prefix || lpad(r.n::text, r.padding, '0');
END; $$ LANGUAGE plpgsql;
-- Series scope key: 'GL:' || series. Rollback restores nextNo, so no gap.

-- ═════════════════════════════════════════════════════════════════════════
-- 8. THE ONLY WRITE PATHS
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION gl_post(p_draft JSONB) RETURNS TEXT
SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_org TEXT; v_entry TEXT; v_residual BIGINT; v_lines INT; v_period TEXT;
BEGIN
  v_org := p_draft->>'orgId';
  IF v_org IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'ledger: org mismatch' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_period := p_draft->>'periodId';

  -- FOR SHARE: a concurrent gl_close() takes FOR UPDATE and WAITS for us
  -- instead of racing. This is why a close can never strand a half-post.
  PERFORM 1 FROM "AccountingPeriod"
   WHERE id = v_period AND "orgId" = v_org AND status = 'open' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger: period is not open' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('app.in_gl_post','1',true);

  -- …allocate gl_next_number('GL:'||series); INSERT header; INSERT lines with
  --   fxRate + fxRateDate frozen; INSERT AccountMovement deltas…

  -- FX ROUNDING RESIDUAL: absorb into the largest line of the same currency
  -- group. NEVER post a plug line — a plug breaks the per-currency invariant.
  SELECT COALESCE(SUM("functionalAmountMinor"),0), COUNT(*)
    INTO v_residual, v_lines FROM "JournalLine" WHERE "entryId" = v_entry;
  IF abs(v_residual) > v_lines THEN
    RAISE EXCEPTION
      'ledger: FX residual % exceeds one minor unit per line (% lines) — posting refused',
      v_residual, v_lines USING ERRCODE = 'check_violation';
  ELSIF v_residual <> 0 THEN
    UPDATE "JournalLine" SET "functionalAmountMinor" = "functionalAmountMinor" - v_residual
     WHERE id = (SELECT id FROM "JournalLine" WHERE "entryId" = v_entry
                  ORDER BY abs("txnAmountMinor") DESC, "lineNo" LIMIT 1);
  END IF;

  PERFORM set_config('app.in_gl_post','0',true);
  DELETE FROM "JournalDraft" WHERE id = p_draft->>'draftId' AND "orgId" = v_org;
  RETURN v_entry;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION gl_reverse(p_entry_id TEXT, p_reason TEXT, p_date DATE)
RETURNS TEXT SECURITY DEFINER SET search_path = public, pg_temp AS $$ /* … */ $$
LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION gl_close(p_period_id TEXT, p_target TEXT)
RETURNS VOID SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_dr BIGINT; v_cr BIGINT;
BEGIN
  PERFORM 1 FROM "AccountingPeriod" WHERE id = p_period_id FOR UPDATE;  -- waits on in-flight posts

  IF EXISTS (SELECT 1 FROM "AccountingPeriod" e
              WHERE e."entityId" = (SELECT "entityId" FROM "AccountingPeriod" WHERE id = p_period_id)
                AND e."startsOn" < (SELECT "startsOn" FROM "AccountingPeriod" WHERE id = p_period_id)
                AND e.status = 'open') THEN
    RAISE EXCEPTION 'ledger: an earlier period is still open' USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(SUM("functionalDeltaMinor") FILTER (WHERE "functionalDeltaMinor" > 0),0),
        -COALESCE(SUM("functionalDeltaMinor") FILTER (WHERE "functionalDeltaMinor" < 0),0)
    INTO v_dr, v_cr FROM "AccountMovement" WHERE "periodId" = p_period_id;
  IF v_dr <> v_cr THEN
    RAISE EXCEPTION 'ledger: period does not balance (Dr % vs Cr %) — close refused', v_dr, v_cr
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO "PeriodAnchor" (...) SELECT ... ;  -- seal
  UPDATE "AccountingPeriod" SET status = p_target, "closedAt" = now() WHERE id = p_period_id;
END; $$ LANGUAGE plpgsql;

-- ═════════════════════════════════════════════════════════════════════════
-- 9. ROW LEVEL SECURITY — FORCE, so even the table owner is subject to it
-- ═════════════════════════════════════════════════════════════════════════
DO $$ DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['Book','Account','FiscalYear','AccountingPeriod',
      'Dimension','DimensionValue','JournalEntry','JournalLine',
      'JournalLineDimension','AccountMovement','PeriodAnchor',
      'JournalDraft','DocumentSequence'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY %I_org ON %I
                      USING ("orgId" = current_setting('app.org_id', true))$f$, t, t);
  END LOOP;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- 10. GRANTS — the app role can read the ledger and write nothing
-- ═════════════════════════════════════════════════════════════════════════
REVOKE INSERT, UPDATE, DELETE ON
  "JournalEntry","JournalLine","JournalLineDimension",
  "AccountMovement","PeriodAnchor" FROM arks_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO arks_app;
GRANT INSERT, UPDATE, DELETE ON "JournalDraft" TO arks_app;  -- drafts are not the ledger
GRANT EXECUTE ON FUNCTION gl_post(JSONB), gl_reverse(TEXT,TEXT,DATE),
                          gl_close(TEXT,TEXT) TO arks_app;
```

### 3.8 The invariants, as a checklist

| # | Invariant | Enforced by |
|---|---|---|
| 1 | Every posted entry balances in the functional currency | `gl_check_entry_balance`, deferred constraint trigger |
| 2 | Single-currency entries also balance per currency | same, `n_cur = 1` branch |
| 3 | Every entry has ≥ 2 lines | same |
| 4 | No line is ever `UPDATE`d or `DELETE`d | `gl_line_no_update` trigger **and** no grant |
| 5 | A posted header changes only `status`, `reversedById`, `reversalReason` | `to_jsonb()` allowlist |
| 6 | Nothing posts into a non-`open` period | `gl_entry_guard` INSERT branch |
| 7 | Close waits for in-flight posts, never races | `FOR SHARE` / `FOR UPDATE` on the period row |
| 8 | `locked` is terminal, all routes, all roles | `gl_period_guard` |
| 9 | A period cannot close while an earlier one is open | `gl_close` |
| 10 | A period cannot close while Dr ≠ Cr | `gl_close` recomputes and refuses |
| 11 | Numbers are gapless per (org, entity, series) | `UPDATE … RETURNING` inside the txn, never a SEQUENCE |
| 12 | Numbers are assigned at post, never at draft | drafts are in a different table |
| 13 | Only `gl_post` / `gl_reverse` write | `SECURITY DEFINER` + pinned `search_path` + no grants |
| 14 | Every write asserts `app.org_id` | `gl_post` guard + FORCE RLS |
| 15 | No cross-tenant reference is representable | composite FKs on `(orgId, id)` |
| 16 | All money is BIGINT minor units; scale from `Currency.minorUnits` | schema types + FK to `Currency` |
| 17 | Three currency concepts per line, rate frozen at post | line columns, immutable by #4 |
| 18 | FX residual absorbed into the largest line, never a plug | `gl_post`; refuses if > 1 minor unit/line |
| 19 | Balances never computed by `SUM()` over lines | `PeriodAnchor` + `AccountMovement` |
| 20 | Concurrent postings to one control account never block | INSERT-only deltas |
| 21 | Manual journals refused into control accounts | `gl_line_guard` (exists) |
| 22 | Journal tables are append-only in the strict sense | #4 + #5 + drafts elsewhere |

---

## 4. Component build order

Strict dependency order. Each tier is fully buildable and testable before the next.

### Tier 0 — Foundations (no UI, no React)

1. **`src/lib/ledger/money.ts`** — BigInt minor units, scale from the `Currency` registry. Exports `parseAmount`, `format`, `halfUp`, `add`, `negate`. **Never `number`.** `src/lib/domain/money.ts` is frozen to invoicing; the ledger does not import it. *(This overrides Track 4's instruction to route amounts through `parseMoneyToMinor()` — that function returns a `number` and hardcodes `MINOR_PER_MAJOR = 100`, violating three other rules.)*
2. **Rewrite `evalExpr` in `src/lib/ledger/format.ts`** — currently a recursive-descent parser evaluating in **JS floats** (`v * r`, `v / r`), so `1200/12` in the field and `1200/12` in the posting engine can disagree. Replace with a **hand-written shunting-yard parser over decimal minor units** using the same half-up rounding as the engine. Never `eval()`, never `new Function()` — an injectable expression field in a multi-tenant financial app is a security hole, not a convenience. Supports `+ - * / ( ) %`.
3. **The number parser** — one parser for `1 234,56`, `1,234.56`, `1234.56`: strip space, U+00A0, U+202F, apostrophe, and `,` followed by exactly three digits; then treat whichever of `.` or `,` occurs **last** as the decimal separator. Accepts `٫` (U+066B), `NumpadDecimal`, and Arabic-Indic digits. Accepts `-100`, `100-` (10-key trailing minus) and `(100)` identically.
4. **`src/styles/ledger.css`** — the token block from §1, light + dark, complete pairs. Map into `tailwind.config.ts`.
5. **Date grammar** — `t`, `+7`, `-1`, `eom`, `p` (last day of previous open period), bare day number, `31/1`, `31/1/25`. Tab commits the interpretation.
6. **Shortcut registry** — one module. The cheat sheet is **generated from it**; a hand-maintained list drifts within two sprints.
7. **Density preference** — three values, one per-user setting, persisted, read by every table.

> **Tier 0 gate:** property tests proving the field evaluator and the posting engine produce byte-identical minor units for 10,000 random expressions across AED (2), KWD (3) and JPY (0).

### Tier 1 — Primitives

8. **`<Figure>`** — the single money renderer. Owns tabular-nums, the 1ch gutter, parentheses vs U+2212, en-dash zero, `dir="ltr"` isolation, and the accessible name (`"Debit, line 3, 1,200.00 dirhams"`). **Every number on every screen goes through this.**
9. **`<AccountCode>`** — `zero` + `tnum` features, monospace-free.
10. **`<RuleSet>`** — the three-weight rule system as data attributes, so a table never hand-rolls a border.
11. **`<Announcer>`** — a **single persistent** `<div role="status" aria-live="polite" aria-atomic="true" class="sr-only">` rendered **before it has content**. A live region injected together with its text announces nothing in most screen readers. Debounced 700ms; announces state *transitions*, not recalculations; polite, never assertive.
12. **`<StatusChip>`** — glyph + tone, never tone alone.
13. **`<EmptyState>`** — two variants with different copy and different actions: *"nothing exists"* vs *"nothing matches your filters"*. Never conflated. The Frank moment lives here.
14. **`<SkeletonRows>`** — rows at the exact final height, header retained. Never a centred spinner that collapses the table.
15. **`<MoneyInput>`** — `<input type="text" inputmode="decimal" autocomplete="off" spellcheck="false">`. **Never `type="number"`** — spinners are mouse-only targets, the scroll wheel silently mutates a committed amount, and `valueAsNumber` returns a float. Grouped and 2-dp on blur, raw on focus; select-all on Tab-in, caret-at-click on mouse-in; expression evaluated on commit only (Tab/Enter/blur, **never on keystroke**); source expression kept on the row and shown as a subdued hint; on parse error keep the user's text, `aria-invalid="true"`, `aria-describedby` at the message.
16. **`<DateInput>`** — the grammar from Tier 0. Closed periods are **struck through and disabled inside the picker**, with the first open date pre-highlighted. Block at entry; never error at post.
17. **`<AccountPicker>`** — **build and test the blind-entry path first, before any popup UI.** Typing a complete valid code and pressing Tab commits without the dropdown ever opening. Never auto-commit on a unique *prefix* — the prefix stops being unique when the next account is created and the muscle memory silently breaks; a unique prefix ghost-completes inline instead. One field matching code-prefix and name simultaneously, ranked: exact code > code prefix > name starts-with > word starts-with > contains > alias, then boosted by favourites and last-30-days usage. On blur with no match, **hold focus in the cell in an error state** — never clear what the user typed. Header/system accounts filtered out; control accounts shown disabled with their reason. Required-dimension rules shown as a badge in the dropdown row. *"Create new account"* sits in a divided footer requiring a click or Ctrl+Enter — **never plain Enter**; plain-Enter creation is how a chart of accounts bloats.

### Tier 2 — Composites

18. **`<LedgerTable>`** — plain semantic `<table>` with `<caption>`, `<thead>`, `scope="col"`/`scope="row"`, `<tfoot>`. Derives alignment from column kind. Resizable / reorderable / hideable columns. Row activation via **one real link or button per row**, never a clickable row with `role="grid"`. With virtualisation, `aria-rowcount` is the **full logical count** and every rendered row carries its **true** `aria-rowindex` — reporting "row 3 of 20" in a 10,000-row table is a defect.
19. **`<TotalsFooter>`** — a real `<tfoot>` with `<th scope="row">` labels, reachable by ordinary screen-reader table navigation, independent of the live region.
20. **`<BalanceGauge>`** — **build this before the grid.** It is reused *verbatim* by bank splits and multi-invoice matching; *"remaining 240.00 goes here"* must look and behave identically in both screens. States the difference as a **signed, named amount with its direction**: *"out by AED 4,391.66, debits exceed credits"* — never a bare "out of balance". Neutral/amber while typing, falu red **only after a post attempt**. Visible chip is `aria-hidden`; the fact is announced once, through the Announcer. **Never** `src/components/motion/animated-number.tsx` — a counting number is unreadable while animating and fires a live-region update per frame.
21. **`<PeriodBanner>`** — four states, not one. Open / soft closed / hard closed / locked, each with distinct copy and a **distinct achievable action**, and the banner never offers an action the current role cannot perform.
22. **`<DrillBreadcrumb>`** — filters as removable chips carried through the whole chain. **The drill path lives in the URL**: back, forward, refresh and paste-a-link all work, because accountants send each other links to specific numbers.

### Tier 3 — The journal grid

23. **`<JournalGrid>`** — native `<table>` with real `<input>` in `<td>`. **No `role="grid"`** — it destroys screen-reader table navigation and forces hand-built focus management that native HTML provides free. Cells are **uncontrolled with a ref-backed store**, committing to a reducer on blur; **only** `<BalanceGauge>` subscribes to per-keystroke totals. Never re-render 200 rows per keypress.
    - Totals row is a **sticky footer inside the same CSS grid** as the entry rows, so Debit and Credit sums sit under the figures they sum **to the digit**. A separate flex row is a failed screen.
    - The out-of-balance difference renders **under the column it is missing from** — debits exceeding credits shows in the *Credit* column labelled *"Credit short by"*. Clicking it inserts a pre-filled balancing line and focuses its Account cell.
    - Last line only: tabbing out of an empty Debit/Credit auto-fills the balancing amount in the correct column with a **dotted underline as a suggestion**; typing over it cancels; it never moves focus; it is announced with an Undo. Never on an interior row. User-disableable.
    - Keyboard: ArrowUp/Down always move one row in the same column. ArrowLeft/Right move the caret and cross the cell boundary only at the end with a collapsed selection; Ctrl/Cmd+Arrow always crosses. Home/End within the cell; Ctrl+Home/End to grid start/end. Direction derived from `getComputedStyle().direction`. Tab on the last cell of the last line **creates a new line** and moves into its Account cell. Escape restores the last committed value and never strands focus.
    - **Never a positive `tabindex`.** Order is strict visual DOM order: header fields → each line left-to-right → totals row → action bar. Optional columns (Tax, Dimension, Project) get a per-user *skip in tab order* toggle via `tabindex="-1"`, still reachable by Ctrl+Arrow. Row action buttons live in a trailing cell or a per-row menu, never between the last data cell and the next row.
    - Auto-advance **only on unambiguous commit** — entering a Debit and pressing Tab skips that line's Credit cell. Never on a character-count heuristic (WCAG 3.2.2).
    - Dimensions render as **columns in the grid**, never a modal or drawer, and only for dimensions the tenant has enabled. Header values pre-fill every line; a line overriding the header shows a **4px dot** so overrides are scannable down the column. Per-account required-dimension rules enforced **on line blur**, not saved for the post attempt.
    - Validation cadence: format/parse on **field commit**; row semantics on **row blur**; balance and period state as **continuous advisory status**, never an error before Post; server failures on Post as an **error summary**.
24. **`<PasteReview>`** — read `text/plain`, split `/\r\n|\n|\r/` then `\t`; also read `text/html` to distinguish blank cells from zeros. Anchor at the focused cell, expand right and down, create rows; **truncate at the column count, never wrap into the next row**. Detect a header row by name (Account/Konto, Debit/Debet, Credit/Kredit); split a single signed amount column into Debit (positive) / Credit (negative). **A paste never posts:** a review strip (*"18 rows · 2 accounts unmatched · 1 amount unparsed"*), offending cells outlined, cycled with Alt+Enter, a bulk *"map all rows with code X"* resolver, a per-cell `pasted` marker that is not colour-only, and a `role="status"` summary. Unmatched codes become an inline picker — never a blocking modal, never a silent drop. **One Ctrl+Z undoes the entire paste as a single transaction.**
25. **`<UndoStack>`** — ≥ 50 entries per entry, covering cell edits, row insert/delete, paste, auto-balance and side-swap. **Does not cross the post boundary.** Every action the system took that the user did not type (auto-balance, side-swap, paste normalisation) surfaces an Undo in a `role="status"` region — `sonner` with `duration: Infinity`, dismissed on the next user action, never a 4-second toast.
26. **`<DraftAutosave>`** — debounced 800ms and always on row blur, to **both** IndexedDB (the `idb` dependency is already installed) and the server. **Post is always explicit** — never automatic, never on blur, never on navigation. Keep a **visible Save button** even though autosave runs: its presence is what makes the autosave believable. On reload, prompt to restore, naming the timestamp — never silently reinstate. Guard route changes and `beforeunload` while dirty. A session timeout must never destroy an in-progress entry (WCAG 2.2.1): warn well before expiry, allow extension in place, keep the local draft regardless.
27. **`<PostAction>`** — **never silently disabled.** Clickable with `aria-disabled`, labelled with the **single blocking reason** (*"Post — 1,250.00 out of balance"*), and on click it scrolls to and focuses the offending cell. No toast, no post-hoc error. Shortcut hint in the label (*"Post ⌃⏎"*). Confirms — and the dialog says a posted entry can only be **reversed, never edited**. On failure: an error summary at the top with in-page links to each offending row, keyboard focus moved to the summary, and the document `<title>` prefixed with `Error:`. On success: focus moves to the new entry's success heading. **Focus must never fall to `<body>`.**
28. **`<LockedPeriodDialog>`** — never a bare *"Period is closed."* Three outs: **re-date** to the earliest open period showing the new date, **request an unlock** (creating an approval task), or **post with override** if permitted, stamping a visible override badge on the journal.

### Tier 4 — Screens

29. **Chart of Accounts** — search returns a **flat list with a breadcrumb above each hit**, never a filtered tree with orphaned parents. A permanent flat mode in code order for browser find. Hierarchy derived from the code where the scheme is positional; explicit `parentId` only for non-positional schemes. Accounts with postings can be **archived but never deleted or re-coded**; archived accounts stay resolvable on historic journals with an *archived* badge.
30. **Journal list** → 31. **Journal editor** (Tier 3 assembled) → 32. **Trial balance** → 33. **General ledger** — the running-balance column is **greyed with an explicit *"n/a in this sort"* state** whenever the view is sorted by anything other than date+sequence, rather than showing a running total that is silently wrong.
34. **Account drill-down** — every summed figure is a link; drill stays in the same viewport; **every number reaches its source in three steps or fewer**, and the last step is always a human-readable document or an honest *"posted manually by X"* statement (allemansrätten).
35. **Period close checklist** — each task carries status, owner, timestamp and a link to where the work happens. A blocked task **names its prerequisite on hover** instead of dead-clicking.
36. **Bank reconciliation** — two columns, immutable bank line left, proposed match right, **never reordering while the user works**. `Enter` confirms the focused pair, `J`/`K` move, `F` find & match, `S` split, `R` make a rule (all focus-scoped, none bound globally). Auto-suggest **only** exact amount+date+reference matches with a solid tick; near-matches get a dotted tick with the differing field highlighted and **always require a keystroke**. Confirmed lines collapse in 250ms into a 30-second undo stack — no per-line confirm dialog. `<BalanceGauge>` reused verbatim for splits.
37. **"Why doesn't this reconcile"** — a **panel, not a report**: state the balance identity, then list detected causes in frequency order (feed gap with the missing date range, duplicate pairs, opening balance, post-dated items, manual marks), each a **one-click filter**, plus a month-by-month ladder to binary-search the first broken month.
38. **Rules** — preview impact before saving (*"this would have matched 43 of your last 200 lines"*); rules **suggest by default** and auto-apply only behind an explicit toggle with a needs-review counter.

### Tier 5 — Reporting

39. Financial statements → 40. Charts (three colours max) → 41. KPI tiles (the only place compaction is allowed) → 42. Exports.

---

## 5. The non-negotiables

*(See the `rules` array — these hold on every screen we ever build.)*

Twelve rules, each of which invalidates a screen if broken. Two additions worth stating in prose:

**Nothing in the ledger is deleted.** Destructive dialogs state the consequence in ledger terms; type-to-confirm uses the **entry or period identifier**, not the word DELETE; initial focus goes to **Cancel**. Undo is a **server action**, not a client rollback — the toast must say whether it deleted a draft or posted a reversal, and errors are never reported by toast alone.

**Every account-related error the posting engine can raise is pre-empted in the UI with the same wording.** The server is a backstop, never the user's first news. Warn without blocking on suspicious-but-legal input (an amount 100× the account's trailing median, a date over 90 days out, a duplicate reference in the period) — advisory, dismissible, never a hard stop. Confirm only what is irreversible.

### Immediate cleanup

```
tailwind.config.ts  → delete keyframes/animation: gradient-pan, marquee, shimmer,
                      pulse-ring; delete boxShadow.glow; delete backgroundImage.gold-sheen
globals.css         → --ring: gold → accent; delete .glass, .glass-strong,
                      .text-gold-gradient, .skeleton::after shimmer, .hover-lift
layout.tsx          → drop Sora; add Familjen Grotesk as --sw-font-display
```

`--gold` remains defined for the 33 existing `.tsx` files that reference it, but is out of bounds in `src/app/(app)/accounting/**` and `src/components/ledger/**` from day one. Migrate the rest opportunistically; the ledger does not wait for it.