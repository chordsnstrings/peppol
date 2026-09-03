## Three corrections from the sources first — they change what we build

**1. Bariol is not Swedish.** It is from [Atipo Foundry](https://www.atipofoundry.com/fonts/bariol) in Gijón, Spain, and there is no "Awesome" in the Swedish catalogue. [Letters from Sweden](https://lettersfromsweden.se/fonts/) (Björkhagen, outside Stockholm) actually ships **Trim / Trim Mono**, **Ivar Text / Ivar Mono**, **Lab Grotesque / Lab Grotesque Mono**, **Gothia Sans/Serif**, **Eksell Display** (a digitisation of Olle Eksell's 1962 alphabet) and — new in 2026 — **Markelius Sans**, named for Sven Markelius of the *acceptera* group. Those are the real licensing options.

**2. The best free face is Swedish anyway.** [Inter](https://en.wikipedia.org/wiki/Inter_(typeface)) is by **Rasmus Andersson**, a Swede who was Spotify's first designer in 2006. It carries `tnum` and a `zero` slashed-zero feature — which matters because [**Sweden Sans**](https://en.wikipedia.org/wiki/Sweden_Sans), the national typeface by Söderhavet/Stefan Hattenbach, has as its two signature quirks a filled ring on the å and *"a line that cuts through the zero."* Hattenbach described the brief as **lagom**: "not too much and not too little… it's not exaggerated, but you're still very happy with it." A slashed zero is at once the most Swedish typographic detail available and exactly what stops account code `4010` reading as `4O1O`. We get the reference for free.

**3. Red is already spoken for.** [Falu red](https://www.moosefarg.com/swedish-red/) — iron-oxide tailings from the Falun copper mine, boiled with rye flour and linseed oil since the 1500s — is the most Swedish colour that exists, and it is unavailable as a brand accent here because red means *loss*. Same for green. So the accent must be blue, and the Swedish blue is the flag's NCS 4055-R95B, commonly rendered **#006AA7** — cyan-leaning, noticeably not the `#3B82F6` SaaS default.

---

## The principles that actually distinguish this from generic minimalism

**Lagom is not minimalism.** Every source is explicit: lagom is *"not about minimalism or austerity, nor about abundance."* Whitespace maximalism is austerity. Lagom means the right amount of information for the task — and an accountant reconciling a trial balance needs **more** rows, not fewer.

**Josef Frank settles the density argument outright.** [Svenskt Tenn's own philosophy page](https://www.svenskttenn.com/us/en/svenskt-tenn/interior-design-philosophy/) records Frank's view that *patterned surfaces feel calming and "break up cold geometric stiffness while filling the room," whereas plain surfaces quickly lose visual interest* — and elsewhere: *"The monochromatic surface appears uneasy, while prints are calming."* A dense table of numerals **is** the print. A vast empty white expanse is the uneasy monochrome surface. This is the single most useful finding in the research: Swedish design theory positively argues *for* filled, patterned, dense surfaces.

**Ljusinsläpp is a contrast strategy, not a whitespace strategy.** Swedish interiors use white walls, oversized windows and sheer fabric because winter daylight is scarce — the goal is to *maximise the amount of light that reaches you*, not to leave rooms empty. Bruno Mathsson built his own houses with **triple-glazed window walls**. Translated: the ledger canvas is the window. It is the palest surface on screen, it gets the most area, and the chrome around it is darker so the data reads as the light source. (Spotify does exactly this: *"every surface is a shade of charcoal… the only true colour comes from Spotify Green and the album artwork."*)

**Funkis / honest construction.** The [1930 Stockholm Exhibition](https://en.wikipedia.org/wiki/Stockholm_Exhibition_(1930)) and the *acceptera* manifesto (Asplund, Gahn, Markelius, Sundahl, Åhrén, Paulsson) put form in service of use and left structure visible. Translated: **elevation is expressed by hairlines and surface value, not by shadows.** Joints are drawn, not hidden. And *acceptera* literally means accept the real conditions — so accept long account names, six-digit amounts and 40-row screens instead of prettifying them away.

**Svenskt Tenn's "tall legs" rule.** Frank and Ericson insisted furniture sit on tall legs so the floor-to-wall contour stays visible, and be *"lightweight, movable, flexible according to the inhabitants' needs."* Translated: a panel is delineated by an edge, never by melting into a blur; and columns are resizable, reorderable, hideable.

**Ericson and Frank on colour.** Both advocated **white walls as the ideal, letting the textiles determine the room's palette.** Translated: the chrome is achromatic linen and graphite; colour enters only through the *data* — the sign of a figure, the state of a period.

**Democratic design.** [IKEA's five dimensions](https://www.ikea.com/global/en/this-is-ikea/) are form, function, quality, sustainability and low price — good design is the *right combination*, not the maximum of any one. The digital equivalent of "low price" is **access**: Sweden's DOS-lagen points at EN 301 549 → **WCAG 2.1 AA**, 4.5:1 normal text and 3:1 large ([Digg](https://www.digg.se/webbriktlinjer/lagar-och-krav/det-har-ar-en-301-549-och-wcag)). Every foreground token below has been computed and passes; the failures are listed honestly.

**Restraint with one moment of warmth.** Frank's botanical exuberance existed *because* the pine and the limewash around it were quiet. So: one Frank moment, quarantined.

---

## Palette construction

**The neutral ramp is warm at the top and violet at the bottom.** This is the anti-generic move. Tailwind `slate`/`zinc` are uniformly blue-grey and are the fingerprint of AI minimalism. Nordic light does the opposite: low winter sun is warm, and shadows on snow are blue-violet. Klarna's own palette proves it — [Klarna White is **#F9F8F5**](https://brand.klarna.com/brand-colors) (warm off-white) and Klarna Black is **#0B051D**, which leans deep violet, not neutral. So our ground is limewash `#F4F1E9` and our ink is `#1C1A24`.

**No pure `#FFFFFF` and no pure `#000000` anywhere.** Klarna does not use them; neither do we.

### Four separate semantic axes, none of them the accent

| Axis | Light | Dark | Where it is allowed to appear |
|---|---|---|---|
| **Accent** (interaction only) | `#006AA7` | `#5FA8D3` | Focus ring, primary button, selected row, active nav. Never on a number. |
| **Debit / Credit** (structural) | `#34405A` / `#8A5A1E` | `#A7B6D8` / `#D5A257` | **Chrome only** — column header small-caps, 1px column rule, DR/CR badge. Never on the digits. |
| **Positive / Negative** (value) | `#2F6B4F` / `#8E2C1E` | `#63B084` / `#DE7A62` | **Numerals only** — deltas, variances, signed balances. Never on chrome. |
| **Frank moment** (affirmation) | `#E9A6BC` | `#E9A6BC` | Balanced-entry confirmation, empty states, closed-period seal. ≤2% of screen. |

That split is the whole trick. Because debit/credit lives on chrome and positive/negative lives on numerals, the ochre and the falu-red never compete in the same visual role even though they are neighbouring hues.

`#8E2C1E` is Falu red pulled up to pass AA on limewash (7.36:1) while keeping its brown iron-oxide character — it is a *loss*, not a fire alarm. `#2F6B4F` is pine, not mint.

**Warning and info are aliases, not new colours.** `--sw-warn` = the credit ochre; `--sw-info` = the accent. Lagom: do not invent a fifth hue. They are distinguished by *treatment*, not value — a warning is a filled tint band with an icon; a credit marker is a small-caps label plus a 1px rule.

**Colour is never the only carrier of sign.** Falu red and pine both collapse toward brown under deuteranopia, so every negative figure must also carry an explicit `−` or parentheses. This is non-negotiable and is a code-review rule, not a guideline.

---

## Typography

`--sw-font-sans: "Inter var", Inter, system-ui, sans-serif`, with **`font-variant-numeric: tabular-nums slashed-zero`** applied globally to `.ledger` and every numeric cell. Weights: **400 / 500 / 600 only**. No 700, no 300.

Two families maximum, and honestly one is enough: Inter for everything, `--sw-font-mono` (`ui-monospace`) reserved for document IDs, PEPPOL identifiers and raw XML only.

Scale (rem, 16px root) — note **13px is the ledger default**, not 14 or 16:

| Token | Size / LH | Use |
|---|---|---|
| `--sw-fs-2xs` | 11 / 16 | Column headers, DR/CR labels (uppercase, `0.06em` tracking) |
| `--sw-fs-xs` | 12 / 18 | Metadata, secondary cells, dimension tags |
| `--sw-fs-sm` | **13 / 20** | **Ledger body — account names and amounts** |
| `--sw-fs-base` | 15 / 24 | Forms, prose, dialogs |
| `--sw-fs-lg` | 17 / 26 | Section leads |
| `--sw-fs-xl` | 20 / 28 | Panel titles |
| `--sw-fs-2xl` | 24 / 32 | Page titles |
| `--sw-fs-3xl` | 30 / 38 | Account balance figure |
| `--sw-fs-4xl` | 38 / 44 | One dashboard hero figure. One. |

Everything in `rem` so browser zoom works — that is the democratic-design obligation. Density is a **user setting** (compact / default / comfortable), not a designer's imposition; that is how you get density *and* accessibility rather than trading one for the other.

---

## Layout, density and the ledger grid

Concrete targets, because "data-dense" needs a number:

- **≥ 28 journal lines visible at a 900px viewport height.** Row height 32px default, 28px compact, 40px comfortable.
- Cell padding: 12px horizontal, 16px on the right edge of numeric columns. Vertical padding comes from line-height, not padding.
- Numerals **right-aligned, tabular, decimal-aligned**. Account codes left, tabular, slashed zero.
- Sticky header row and a frozen first column — Mathsson's window frame: thin, always present, structural.
- **The ledger is not inside a card.** It goes edge-to-edge in its region with a single top hairline. Cards are for summaries; the ledger is the floor.

**No zebra striping.** Alternating fills on warm linen read as dirty, and they are decoration pretending to be structure. Use the three-weight rule system instead, which is real accounting typography and carries more information than stripes:

- `--sw-rule` `#E2DDD1` — between rows (hairline)
- `--sw-rule-strong` `#CBC4B4` — column dividers, panel edges
- `--sw-rule-total` `#8E8677` — **single rule above a subtotal, double rule under a grand total** (3.19:1, so it is legible as an information-bearing graphic)

Page gutter `clamp(16px, 4vw, 40px)`. Klarna's published rule is a 6%-of-shortest-side margin with gutters at half the margin — good for the marketing shell, but in the ledger the data outranks the margin. That is functionalism, not a violation.

**The sidebar stays dark in both themes** (`#1B1A22`). This preserves the existing ARKS structure, follows Spotify's charcoal frame, and literalises *ljusinsläpp*: the dark frame is the wall, the pale ledger is the window.

---

## Radii and elevation

Radii come from **bentwood** — Mathsson's laminated beech has a small consistent curve, not a pill. Cap at **8px**; the current `--radius: 0.75rem` (12px) is too soft.

- `0` — **table cells, rows, the ledger grid.** Rounding a grid is dishonest construction.
- `3px` inputs, chips, badges · `5px` buttons, menu items · `8px` cards, panels, dialogs · `999px` avatars and status dots only.

**Elevation rules, in order of importance:**

1. **The ledger has no shadow at all.** Hairlines only.
2. Cards get a 1px border plus at most a 1px hairline shadow — they sit *on* the ground with a visible edge (tall legs), they do not melt into it.
3. Popovers and dialogs get a **low-angle** shadow: small y-offset, wide blur. Low winter sun casts long soft shadows, not tight drop shadows.
4. Shadow colour is the **violet ink at low alpha**, never neutral black.
5. **Dark mode has no shadows.** Elevation is surface value only — `#14131A` → `#1B1A23` → `#23212C`.

Motion budget: 120ms / 180ms, `cubic-bezier(0.2, 0, 0, 1)`, opacity plus 2px translate maximum. **The ledger does not animate.**

---

## What to avoid (this is the part that stops it reading as AI minimalism)

1. **Pure white and pure black.** Not in a background, not in text, not in a border.
2. **Blue-grey neutral ramps** — Tailwind `slate`/`zinc`/`gray`. Warm at the light end, violet at the dark end, always.
3. **The current config's decorations must go**: `gold-sheen`, `shimmer`, `gradient-pan`, `glow`, `marquee`, `bg-grid-fade`. Also banned: glassmorphism, `backdrop-blur` chrome, gradient text, coloured glows, neumorphism.
4. **Radii above 8px, pill buttons, rounded table rows.**
5. **Whitespace maximalism.** No 96px section padding, no 24px body copy, no three-column grid of cards each holding one number. If a screen shows fewer than ~20 rows of ledger data, it is the wrong screen.
6. **Emoji, 3D blobs, illustrated mascots, "friendly" iconography.** Icons are 1.5px stroke, 16px, monochrome.
7. **Colour as the sole carrier of sign.** Always a `−` or parentheses too.
8. **A second accent hue.** If a colour appears that is not the accent, it must be semantic or it does not ship.
9. **Centred layouts.** Left-aligned, ragged right, on a grid. Numerals right.
10. **Falu red on destructive buttons in a table row that also shows red figures.** Reuse `--sw-neg` for destructive actions, but only in dialogs and toolbars — never inline in a row.
11. **Truncating account names with `…` to keep columns pretty.** *Acceptera*: give the column a drag handle and a `title`.
12. **A rainbow chart palette.** Primary series = accent, comparison = ink at 40%, third = credit ochre. Three maximum.

---

## Wiring it into the existing app

The current `tailwind.config.ts` consumes tokens as `hsl(var(--x))` with bare HSL triplets. Cleanest migration with the least churn: define each token as **space-separated RGB channels** and switch the config to `rgb(var(--x) / <alpha-value>)`, which keeps every `/opacity` utility working. The hex values below are the canonical source of truth.

```css
:root {
  --sw-ground: 244 241 233;   /* #F4F1E9 */
  --sw-fg:      28  26  36;   /* #1C1A24 */
  --sw-accent:   0 106 167;   /* #006AA7 */
}
```

```ts
colors: {
  ground: "rgb(var(--sw-ground) / <alpha-value>)",
  fg:     "rgb(var(--sw-fg) / <alpha-value>)",
  accent: "rgb(var(--sw-accent) / <alpha-value>)",
}
```

**Migration notes for the existing tokens:** the navy `--brand` survives as `--sw-sidebar` `#1B1A22` (retuned from blue to violet-charcoal so it matches dark mode). The `--gold` **must be retired as a brand accent** — an ochre accent would collide with the credit semantic. Its hue survives, demoted, as `--sw-credit`. `--ring` moves from gold to `--sw-accent`.

Every foreground/background pair below was computed against WCAG 2.1. All text tokens pass AA. Two are AA-large only and are labelled as such: `--sw-fg-subtle` (3.25:1) and `--sw-fg-subtle` dark (3.80:1) — restrict both to disabled states and ≥17px. The hairline rules `--sw-rule` and `--sw-rule-strong` are below 3:1 by design: they are redundant decorative separators, which WCAG 1.4.11 exempts. `--sw-rule-total`, which *does* carry information, was darkened specifically to clear 3:1.

---

### Sources

[Klarna brand colours](https://brand.klarna.com/brand-colors) · [Klarna layout & grid](https://brand.klarna.com/layout) · [Svenskt Tenn interior design philosophy](https://www.svenskttenn.com/us/en/svenskt-tenn/interior-design-philosophy/) · [Josef Frank's Accidentism](https://www.illustrationhistory.org/essays/accidentally-swedish-josef-franks-design-theory-in-his-pattern-design) · [Stockholm Exhibition 1930](https://en.wikipedia.org/wiki/Stockholm_Exhibition_(1930)) · [acceptera manifesto](https://en.wikipedia.org/wiki/Acceptera) · [Bruno Mathsson](https://scandinaviandesign.com/personalities/bruno-mathsson/) · [Letters from Sweden](https://lettersfromsweden.se/fonts/) · [Sweden Sans](https://en.wikipedia.org/wiki/Sweden_Sans) · [Inter](https://en.wikipedia.org/wiki/Inter_(typeface)) · [Figma: the birth of Inter](https://www.figma.com/blog/the-birth-of-inter/) · [Digg — EN 301 549 & WCAG](https://www.digg.se/webbriktlinjer/lagar-och-krav/det-har-ar-en-301-549-och-wcag) · [Digg Webbriktlinjer](https://www.digg.se/webbriktlinjer/about-webbriktlinjer) · [IKEA Democratic Design](https://www.ikea.com/global/en/this-is-ikea/) · [Spotify Encore](https://medium.com/spotify-design/reimagining-design-systems-at-spotify-2fe20fbb3552) · [Falu red](https://www.moosefarg.com/swedish-red/) · [Lagom](https://visitsweden.com/about-sweden/swedish-lagom-lifestyle/)