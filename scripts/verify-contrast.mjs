/**
 * WCAG 2.1 AA gate for the Swedish ledger palette.
 *
 * Sweden's DOS-lagen points at EN 301 549, which points at WCAG 2.1 AA, so
 * this is a legal requirement for the market this product is sold into, not a
 * preference. It is a script rather than a note in a design doc because a
 * design doc cannot fail a build.
 *
 * Tokens are read out of src/styles/ledger.css so the check can never drift
 * from what actually ships — editing a colour without editing this file will
 * fail here.
 */
import fs from "node:fs";

const css = fs.readFileSync(new URL("../src/styles/ledger.css", import.meta.url), "utf8");

/** Pull one theme's token block out of the stylesheet. */
function tokens(startMarker) {
  const at = css.indexOf(startMarker);
  if (at < 0) throw new Error(`Could not find "${startMarker}" in ledger.css`);
  const block = css.slice(at, css.indexOf("}", at));
  const out = {};
  for (const m of block.matchAll(/--(sw-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]] = m[2];
  return out;
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const L = (h) => { const [r, g, b] = hex(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const x = L(a), y = L(b); const [hi, lo] = x > y ? [x, y] : [y, x]; return (hi + 0.05) / (lo + 0.05); };

const SURFACES = ["sw-ground", "sw-surface", "sw-surface-2"];
/** Text tokens: 4.5:1 (WCAG 1.4.3). Ledger body is 13px, so never AA-large. */
const TEXT = ["sw-fg", "sw-fg-muted", "sw-fg-faint", "sw-accent", "sw-debit", "sw-credit", "sw-pos", "sw-neg"];
/** Non-text boundaries a user must perceive: 3:1 (WCAG 1.4.11). */
const NON_TEXT = ["sw-line-strong", "sw-accent"];

let pass = 0, fail = 0;
const ok = (n, x) => { pass++; console.log(`  PASS  ${n} — ${x}`); };
const bad = (n, x) => { fail++; console.log(`  FAIL  ${n} — ${x}`); };

for (const [theme, marker] of [["light", ".sw {"], ["dark", ':root[data-theme="dark"] .sw,']]) {
  console.log(`\n${theme.toUpperCase()}`);
  const T = tokens(marker);
  const surfaces = SURFACES.map((s) => T[s]).filter(Boolean);
  if (surfaces.length !== 3) { bad(`${theme} surfaces`, `found ${surfaces.length} of 3`); continue; }

  for (const t of TEXT) {
    if (!T[t]) { bad(`${theme} ${t}`, "token missing"); continue; }
    const worst = Math.min(...surfaces.map((s) => ratio(T[t], s)));
    worst >= 4.5
      ? ok(`${t} reads as body text`, `${worst.toFixed(2)}:1 worst case`)
      : bad(`${t} fails WCAG 1.4.3`, `${worst.toFixed(2)}:1, needs 4.5:1`);
  }
  for (const t of NON_TEXT) {
    if (!T[t]) { bad(`${theme} ${t}`, "token missing"); continue; }
    const worst = Math.min(...surfaces.map((s) => ratio(T[t], s)));
    worst >= 3
      ? ok(`${t} is a perceivable boundary`, `${worst.toFixed(2)}:1 worst case`)
      : bad(`${t} fails WCAG 1.4.11`, `${worst.toFixed(2)}:1, needs 3:1`);
  }

  // Text on a filled control is judged against that control, not the page.
  if (T["sw-accent-ink"] && T["sw-accent"]) {
    const r = ratio(T["sw-accent-ink"], T["sw-accent"]);
    r >= 4.5
      ? ok("primary button label on its own fill", `${r.toFixed(2)}:1`)
      : bad("primary button label fails WCAG 1.4.3", `${r.toFixed(2)}:1, needs 4.5:1`);
  }

  // Pure black or pure white anywhere is the tell of a palette that was not
  // designed. Nordic light is warm at the top and violet in the shadow.
  const pure = Object.entries(T).filter(([, v]) => /^#(ffffff|000000)$/i.test(v));
  pure.length === 0
    ? ok("no pure black or white", `${Object.keys(T).length} tokens`)
    : bad("pure black/white present", pure.map(([k]) => k).join(", "));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
