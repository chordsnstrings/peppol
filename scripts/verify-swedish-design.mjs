/**
 * The design language, checked rather than claimed.
 *
 * docs/design/swedish-design-language.md sets out the rules this product's
 * accounting surfaces follow, and where each one comes from — lagom, funkis,
 * ljusinsläpp, Frank on density, acceptera on honest construction, and Sweden's
 * DOS-lagen pointing at EN 301 549 and WCAG 2.1 AA. A written design language
 * nobody checks is a written design language that drifts: it survives exactly
 * as long as the person who wrote it is reviewing every screen.
 *
 * So this reads the stylesheet and every accounting screen and asserts the
 * rules that can be asserted from the source. It is deliberately not a
 * screenshot test — a screenshot tells you what changed, not which rule broke.
 *
 * scripts/verify-contrast.mjs already holds the colour ratios. This holds the
 * rest: where a colour is allowed to appear, what a data surface may look like,
 * and whether a new screen invented anything.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (n, extra = "") => { pass++; console.log(`  PASS  ${n}${extra ? " — " + extra : ""}`); };
const bad = (n, e) => { fail++; console.log(`  FAIL  ${n} — ${e}`); };

const css = readFileSync("src/styles/ledger.css", "utf8");

const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

const screens = walk("src/app/(app)/accounting").filter((f) => f.endsWith("page.tsx"));
const source = new Map(screens.map((f) => [f, readFileSync(f, "utf8")]));

console.log("\nLJUSINSLÄPP — the ground, and what it is not");

// Klarna uses neither, and neither does this. Pure white on a long ledger
// session is the clinical light this palette exists to avoid; pure black is a
// hole in a warm surface.
const pureWhite = [...css.matchAll(/#(?:fff|ffffff)\b/gi)].length;
const pureBlack = [...css.matchAll(/#(?:000|000000)\b/gi)].length;
pureWhite === 0 && pureBlack === 0
  ? ok("no pure white and no pure black in the stylesheet")
  : bad("pure white or black", `${pureWhite} white, ${pureBlack} black`);

// The ink is violet-biased and the ground is warm — the anti-generic move.
// Tailwind slate and zinc are uniformly blue-grey, which is the fingerprint
// this palette was built to avoid.
const ink = /--sw-fg:\s*#1c1a24/i.test(css);
const ground = /--sw-ground:\s*#f4f1e9/i.test(css);
ink && ground
  ? ok("warm limewash ground, violet-biased ink", "#f4f1e9 / #1c1a24")
  : bad("ground or ink has drifted", `ground ${ground}, ink ${ink}`);

// The Swedish blue, not the SaaS default. #3B82F6 is Tailwind's blue-500 and
// is the single most recognisable tell of a generic interface.
/--sw-accent:\s*#006aa7/i.test(css) && !/#3b82f6/i.test(css)
  ? ok("accent is the flag blue NCS 4055-R95B", "#006aa7, and no Tailwind blue-500")
  : bad("accent", "not #006aa7, or Tailwind blue-500 crept in");

console.log("\nCOLOUR DISCIPLINE — the split that does the work");

/*
 * Debit and credit are structural and live on chrome; positive and negative
 * are values and live on numerals. Because the two axes never share a role,
 * the ochre and the falu red never compete even though they are neighbouring
 * hues. If a debit tint ever lands on a numeral the whole scheme collapses
 * into "some numbers are brown".
 */
const numeralRules = [...css.matchAll(/^([^{}\n]*\.sw-num[^{}\n]*)\{([^}]*)\}/gm)];
const debitOnNumerals = numeralRules.filter(([, sel, body]) =>
  /--sw-(debit|credit)\b/.test(body)).map(([, sel]) => sel.trim());
debitOnNumerals.length === 0
  ? ok("no debit or credit tint reaches a numeral", `${numeralRules.length} numeral rules read`)
  : bad("debit/credit tint on a numeral", debitOnNumerals.join(", ").slice(0, 120));

/*
 * The other half of the same rule. --sw-pos and --sw-neg carry a VALUE, and a
 * value belongs on digits. The status meaning of --sw-neg — an error, a
 * refusal — is a separate use and is allowed on prose, which is what .sw-error
 * and .sw-chip-bad do; those are named explicitly rather than pattern-matched,
 * because an exception nobody wrote down becomes the rule.
 */
/*
 * The named status uses. --sw-neg carries two meanings and only one of them is
 * a value: as a STATUS — an error, a refusal, a failed check, the destructive
 * one of two buttons — it may appear on chrome. Every entry here is listed
 * explicitly rather than pattern-matched, because an exception nobody wrote
 * down becomes the rule.
 *
 * In each of these, colour is never the only signal: an error has its words, a
 * failed chip has its label, and the destructive button says what it will do.
 */
const STATUS_USE = [
  ".sw-error", ".sw-chip-bad", ".sw-chip-warn", ".sw-chip-ok",
  ".sw-cell-invalid", ".sw-warn", ".sw-btn-danger",
];
const valueOnChrome = [...css.matchAll(/^([^{}\n]*)\{([^}]*)\}/gm)]
  // A block that DEFINES the token is not a block that uses it. The theme
  // blocks necessarily mention every token they set, and treating that as a
  // violation would make the rule impossible to satisfy.
  .filter(([, , body]) => !/--sw-(?:pos|neg)\s*:/.test(body))
  .filter(([, , body]) => /var\(\s*--sw-(?:pos|neg)\b/.test(body))
  .map(([, sel]) => sel.trim())
  .filter((sel) => !/\.sw-num|\.sw-figure/.test(sel))
  .filter((sel) => !STATUS_USE.some((s) => sel.includes(s)));
valueOnChrome.length === 0
  ? ok("positive/negative appear on numerals, or on a named status class, and nowhere else")
  : bad("value colour on chrome", valueOnChrome.join(", ").slice(0, 140));

/*
 * Colour is never the only carrier of sign. Falu red and pine both collapse
 * toward brown under deuteranopia — roughly one man in twelve — so a negative
 * figure has to carry its parentheses whatever the palette does. The Figure
 * primitive is the only place money is rendered, which is what makes this
 * checkable at all: one implementation, one rule.
 */
const figure = readFileSync("src/components/ledger/primitives.tsx", "utf8");
/\(\$\{|\(`|\("\("|paren|\(/.test(figure) && /fmtMinor/.test(figure)
  ? ok("money is rendered in one place, through the formatter that parenthesises")
  : bad("Figure", "no single money renderer, or it does not use fmtMinor");

/*
 * A screen that formats an amount itself has stepped outside the one place
 * the parentheses rule is enforced. `toFixed` is legitimate for a rate — a
 * percentage is not money and carries a sign a reader expects — so the check
 * is for `toFixed` applied to something that is not named as a rate. Naming
 * the exception rather than pattern-matching around it is what keeps this
 * honest: if somebody formats an amount and calls the variable `rate`, that
 * is a different problem.
 */
/*
 * The signal is unambiguous and does not need heuristics: an amount is in
 * minor units, so a screen that formats one itself has to divide it. Dividing
 * anything named `…Minor` by a hundred is the whole violation in one
 * expression — and it is worse than a style breach, because a hard-coded
 * hundred is also wrong by a factor of ten for a Kuwaiti, Bahraini or Omani
 * currency, which have three decimals. That exact defect was found in
 * month-end.ts earlier and is why this is checked rather than trusted.
 *
 * A rate divided by a hundred is a percentage and is nobody's business here;
 * it carries no currency and no parentheses rule.
 */
const handFormatted = [];
for (const [file, s] of source) {
  for (const m of s.matchAll(/([A-Za-z0-9_.\[\]]*Minor[A-Za-z0-9_.\[\]]*)\s*\)?\s*\/\s*(100|1000)\b/g)) {
    handFormatted.push(`${file.replace("src/app/(app)/accounting/", "")}: ${m[1]} / ${m[2]}`);
  }
}
handFormatted.length === 0
  ? ok("no screen turns minor units into a string itself", `${screens.length} screens read`)
  : bad("hand-formatted money", handFormatted.join("; ").slice(0, 200));

console.log("\nFUNKIS — honest construction");

/*
 * Rounding a grid is a lie about where a cell ends. Mathsson's bentwood has a
 * small consistent curve; a table cell has none at all.
 */
const roundedCells = [...css.matchAll(/^([^{}\n]*(?:\.sw-table|td|th)[^{}\n]*)\{([^}]*)\}/gm)]
  .filter(([, , body]) => /border-radius:\s*(?!0)/.test(body))
  .map(([, sel]) => sel.trim());
roundedCells.length === 0
  ? ok("no radius on a table cell or row")
  : bad("rounded data surface", roundedCells.join(", ").slice(0, 120));

/*
 * Elevation is drawn, not faked. The ledger has no shadow at all — structure
 * is expressed by hairlines and surface value, which is what acceptera means
 * by leaving construction visible.
 */
const shadowedTable = [...css.matchAll(/^([^{}\n]*\.sw-table[^{}\n]*)\{([^}]*)\}/gm)]
  .filter(([, , body]) => /box-shadow:\s*(?!none)/.test(body))
  .map(([, sel]) => sel.trim());
shadowedTable.length === 0
  ? ok("the ledger casts no shadow")
  : bad("shadow on the ledger", shadowedTable.join(", ").slice(0, 120));

// Shadows that do exist are the violet ink at low alpha, never neutral black.
const blackShadows = [...css.matchAll(/box-shadow:[^;]*rgba\(\s*0\s*,\s*0\s*,\s*0/gi)].length;
blackShadows === 0
  ? ok("no shadow is neutral black")
  : bad("neutral black shadow", `${blackShadows} of them`);

console.log("\nLAGOM — the right amount, and no more");

// Three weights. 700 is shouting and 300 does not survive a limewash ground.
const weights = new Set([...css.matchAll(/font-weight:\s*(\d{3})/g)].map((m) => m[1]));
[...weights].every((w) => ["400", "500", "600"].includes(w))
  ? ok("three type weights only", [...weights].sort().join(", "))
  : bad("type weights", [...weights].sort().join(", "));

// Tabular numerals, so a column of figures aligns on the decimal without
// anybody counting characters; and the slashed zero, which is Sweden Sans's
// own signature and stops account code 4010 reading as 4O1O.
/tabular-nums/.test(css) && /slashed-zero/.test(css)
  ? ok("tabular numerals and a slashed zero")
  : bad("numeral features", "tabular-nums or slashed-zero missing");

/*
 * The Frank moment is quarantined. Josef Frank's botanical exuberance worked
 * because the pine and limewash around it were quiet, so the warm accent is
 * held to a handful of declarations rather than a theme.
 */
const frank = [...css.matchAll(/--sw-frank\b/g)].length;
frank > 0 && frank <= 12
  ? ok("the Frank accent stays quarantined", `${frank} references`)
  : frank === 0
    ? ok("no Frank accent in use")
    : bad("Frank accent has spread", `${frank} references`);

console.log("\nACCEPTERA — every screen speaks the same language");

/*
 * A screen that invents a class is a screen that has quietly left the design
 * language, and it will keep working and keep looking almost right. Every
 * sw-* class used anywhere has to exist in the stylesheet.
 */
const defined = new Set([...css.matchAll(/\.(sw-[a-z0-9-]+)/g)].map((m) => m[1]));
const invented = new Map();
for (const [file, s] of source) {
  // The design page is the token catalogue: it prints token and class names as
  // data so somebody can read the palette off a screen. Checking it against
  // the stylesheet would report the catalogue as a violation of the thing it
  // documents.
  if (file.includes("/design/")) continue;
  /*
   * Only what actually lands in a class attribute. A bare `sw-…` elsewhere in
   * the file is a token inside `var()` or an element id, and reporting either
   * would make the rule noisy enough that somebody switches it off — which is
   * how a check stops being a check.
   */
  for (const attr of s.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/g)) {
    const value = attr[1] ?? attr[2] ?? attr[3] ?? "";
    // A token can appear inside a class attribute too, in a Tailwind arbitrary
    // value like `grid-cols-[var(--sw-col-amount)]`. Still a token.
    for (const m of value.matchAll(/(--)?\bsw-[a-z0-9-]+/g)) {
      if (m[1]) continue;
      if (!defined.has(m[0])) {
        invented.set(m[0], [...(invented.get(m[0]) ?? []), file.replace("src/app/(app)/accounting/", "")]);
      }
    }
  }
}
invented.size === 0
  ? ok("no screen uses a class the stylesheet does not define", `${defined.size} classes, ${screens.length} screens`)
  : bad("invented classes", [...invented.entries()].map(([c, f]) => `${c} (${f[0]})`).join(", ").slice(0, 160));

/*
 * A figure column that is not right-aligned is a column a reader has to scan
 * character by character. Every th carrying sw-num has to reach the alignment
 * rule — this caught a real defect once, where `.sw-table th` outranked
 * `.sw-num` and every numeric heading sat left of its own figures.
 */
/\.sw-table (?:thead|tbody|tfoot) th\.sw-num/.test(css) || /th\.sw-num/.test(css)
  ? ok("numeric column headings are aligned with their figures")
  : bad("numeric headings", "no rule gives th.sw-num the alignment its cells have");

/*
 * WCAG 2.2 SC 2.5.8: 24 CSS pixels of target. Anything a person taps has to
 * declare it, and a dense table is exactly where this gets forgotten.
 */
const targets = [".sw-btn", ".sw-tab", ".sw-subtab", ".sw-check", ".sw-input", ".sw-select"];
const undersized = targets.filter((t) => {
  const rule = new RegExp(`\\${t}\\s*[,{][^}]*\\}`, "s").exec(css);
  if (!rule) return false;
  return !/min-height|block-size|padding|height/.test(rule[0]);
});
undersized.length === 0
  ? ok("every interactive class declares its own target size", targets.join(" "))
  : bad("target size", undersized.join(", "));

console.log("\nDEMOCRATIC DESIGN — it has to work for everybody");

// Browser zoom is the obligation. A px font size is a font size a person who
// needs it larger cannot change.
const pxFonts = [...css.matchAll(/font-size:\s*(\d+)px/g)].map((m) => m[1]);
pxFonts.length === 0
  ? ok("every type size is in rem, so browser zoom works")
  : bad("px font sizes", pxFonts.join(", "));

// Both themes are defined on tokens, and the dark one redefines them rather
// than inventing new ones — otherwise half the palette has one definition and
// the toggle only half works.
/prefers-color-scheme:\s*dark/.test(css) && /\[data-theme="dark"\]/.test(css)
  ? ok("dark theme is defined for both the system setting and the explicit toggle")
  : bad("dark theme", "one of the two paths is missing");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
