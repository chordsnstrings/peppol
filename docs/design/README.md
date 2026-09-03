# The Swedish ledger design system

These five documents are the research the accounting UI was built from, kept in
the repository rather than in someone's notes, because a design system that
exists only in a conversation stops being followed the moment a new person
joins.

They are working documents, not marketing. Where the research corrected an
assumption we started with, the correction is left in — those are the most
useful parts.

| Document | What it settles |
|---|---|
| [`swedish-design-language.md`](./swedish-design-language.md) | The palette, typography and the principles behind them, with sources |
| [`data-entry-and-accessibility.md`](./data-entry-and-accessibility.md) | Keyboard-first entry, numeric input behaviour, WCAG 2.2 AA in a dense financial UI |
| [`ledger-ux-research.md`](./ledger-ux-research.md) | Interaction spec for the journal grid and the reporting screens |
| [`build-specification.md`](./build-specification.md) | The reconciled spec the build actually followed, including four defects it found in the first ledger migration |
| [`component-inventory.md`](./component-inventory.md) | Every primitive, its states and its rules |

## The three ideas, in one paragraph each

**Lagom** — "exactly enough". The research is emphatic that this is *not*
minimalism: lagom means the right amount of information for the task, and an
accountant reconciling a trial balance needs **more** rows, not fewer.
Whitespace maximalism is austerity, which is a different thing. Svenskt Tenn's
own philosophy records Josef Frank's view that patterned surfaces feel calming
and *"break up cold geometric stiffness"*, while plain surfaces quickly lose
visual interest. A dense table of numerals **is** the pattern. This is the
single most useful finding in the research, because it argues positively for
density rather than apologising for it.

**Funkis** — the 1930 Stockholm Exhibition and the *acceptera* manifesto
(Asplund, Gahn, Markelius, Sundahl, Åhrén, Paulsson) put form in service of use
and left structure visible. Translated: elevation is expressed by hairlines and
surface value, never by shadows; joints are drawn, not hidden. And *acceptera*
means accept the real conditions — long account names, six-digit amounts,
forty-row screens — instead of prettifying them away.

**Ljusinsläpp** — "letting the light in" is a contrast strategy, not a
whitespace strategy. Swedish interiors use white walls and oversized windows
because winter daylight is scarce; the goal is to maximise the light that
reaches you, not to leave rooms empty. So the ledger canvas is the window: the
palest surface on screen, given the most area, with darker chrome around it so
the data reads as the light source.

## Three corrections the research made to our starting assumptions

1. **The best free typeface for this was Swedish anyway.** Inter is by Rasmus
   Andersson, Spotify's first designer. It carries `tnum` and a slashed-zero
   feature — and a line through the zero is one of the two signature details of
   **Sweden Sans**, the national typeface. So the most Swedish typographic
   detail available is also exactly what stops account code `4010` reading as
   `4O1O`. We get the reference for free.

2. **Falu red cannot be the brand accent.** It is the most Swedish colour that
   exists — iron-oxide tailings from the Falun copper mine, boiled with rye
   flour and linseed oil since the 1500s — and it is unavailable here because
   red means *loss*. Same for green. The accent therefore has to be the flag
   blue, NCS 4055-R95B, `#006AA7`.

3. **The neutral ramp must not be blue-grey.** Tailwind `slate`/`zinc` are the
   fingerprint of generic AI minimalism. Nordic light does the opposite: low
   winter sun is warm and shadows on snow are blue-violet. Klarna's own palette
   proves the point — Klarna White is `#F9F8F5` and Klarna Black `#0B051D`,
   which leans deep violet rather than neutral. Our ground is limewash
   `#F4F1E9` and our ink `#1C1A24`. No pure black or white appears anywhere,
   and `scripts/verify-contrast.mjs` fails the build if one is introduced.

## The rule that matters most

**Colour is never the only carrier of meaning.**

Debit and credit tints live on chrome — column headers, rules, badges — and
never touch a numeral. Positive and negative live on numerals and never touch
chrome. Because the two axes occupy different visual roles, the ochre and the
Falu red never compete even though they are neighbouring hues.

And every negative figure carries parentheses as well as colour, because Falu
red and pine both collapse toward brown under deuteranopia. This is a
code-review rule, not a preference.

## What is enforced rather than documented

- **`scripts/verify-contrast.mjs`** reads the tokens out of `ledger.css` and
  fails if any text token drops below 4.5:1 against the worst surface it can
  land on, if `--sw-line-strong` drops below the 3:1 non-text threshold, if the
  primary button's label fails against its own fill, or if pure black or white
  appears. It reads the stylesheet rather than duplicating it, so it cannot
  drift from what ships.
- **`/accounting/design`** renders every token as a live swatch with its
  measured ratio, computed in the page from the resolved custom property.
  Documentation that hardcodes its own numbers is documentation that lies
  eventually.
- **`scripts/verify-ledger-ui.mjs`** checks target sizes (WCAG 2.2 SC 2.5.8),
  that the balance live region is mounted before it has content (SC 4.1.3), and
  that no screen scrolls horizontally at 390px.

## Why this is a legal requirement and not a preference

Sweden's DOS-lagen points at EN 301 549, which points at **WCAG 2.1 AA**. The
product is sold into the UAE rather than Sweden, but the standard is the one
the design language comes from and it is the right bar regardless. Auditing our
own palette against it found two real failures — `--sw-fg-faint` at 2.97:1 and
`--sw-line-strong` at 1.62:1 — which is precisely why the check is a script
that can fail a build rather than a note in a document.

## How the design language is held

A written design language nobody checks is a written design language that
drifts: it survives exactly as long as the person who wrote it is reviewing
every screen. So the rules in `swedish-design-language.md` that can be
asserted from the source are asserted, in `scripts/verify-swedish-design.mjs`,
which runs inside `scripts/verify-all.mjs`.

Eighteen checks, grouped by the idea each one comes from:

**Ljusinsläpp** — no pure white and no pure black anywhere; the ground is
limewash `#F4F1E9` and the ink is violet-biased `#1C1A24`; the accent is the
flag blue `#006AA7` and Tailwind's `#3B82F6` is absent, because that colour is
the single most recognisable tell of a generic interface.

**Colour discipline** — the split that does the work. Debit and credit are
structural and may not reach a numeral; positive and negative are values and
may not reach chrome, except through a named status class. Money is rendered
in one place, and no screen turns minor units into a string itself — that last
one is not only a style rule, because a hard-coded hundred is wrong by a factor
of ten for a Kuwaiti, Bahraini or Omani currency.

**Funkis** — no radius on a table cell, because rounding a grid is a lie about
where a cell ends; the ledger casts no shadow at all; and no shadow anywhere is
neutral black.

**Lagom** — three type weights, tabular numerals with the slashed zero that is
Sweden Sans's own signature, and the Frank accent held to a handful of
declarations rather than a theme.

**Acceptera** — every class a screen uses exists in the stylesheet, numeric
column headings are aligned with the figures beneath them, and every
interactive class declares its own target size for WCAG 2.2 SC 2.5.8.

**Democratic design** — every type size in `rem` so browser zoom works, and
both theme paths defined so the toggle wins in both directions.

Four real defects were found the first time it ran: three screens used a chip
class that does not exist and rendered unstyled, and one screen converted minor
units by hand in three places. None would have shown up in a screenshot test,
because a screenshot tells you what changed rather than which rule broke.

`scripts/verify-contrast.mjs` holds the ratios separately, against the worst
surface each token can land on rather than the best.
