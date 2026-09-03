"use client";

import * as React from "react";
import Link from "next/link";
import { Figure, PageHead, Panel } from "@/components/ledger/primitives";

/**
 * The living design reference for the accounting surfaces.
 *
 * Everything measurable on this page is measured in the browser, from the
 * stylesheet that actually shipped — token values, contrast ratios, resolved
 * lengths, even how much of the page the Josef Frank rose is allowed to cover.
 * Nothing is transcribed. A design document that quotes its own numbers is a
 * document that is wrong the first time somebody edits a token, and this one
 * has to survive that.
 *
 * The page is also a conformance test of itself: every rule it states, it
 * obeys — tokens only, square data surfaces, parentheses on every negative,
 * a caption on every table, and a 24px floor under every target.
 */

/* ------------------------------------------------------------- the roles --- */

type Role = "surface" | "text" | "boundary" | "on-accent" | "decorative";

interface TokenSpec {
  name: string;
  role: Role;
  note: string;
}

/** Every colour token in the stylesheet, and what it is allowed to be. */
const COLOUR_TOKENS: TokenSpec[] = [
  { name: "sw-ground", role: "surface", note: "The limewash wall the ledger sits on." },
  { name: "sw-surface", role: "surface", note: "Paper — panels, table bodies, totals rows." },
  { name: "sw-surface-2", role: "surface", note: "Recessed: header bands, section rows, row hover." },
  { name: "sw-accent-soft", role: "surface", note: "The only tinted surface — the sub-tab you are on." },
  { name: "sw-fg", role: "text", note: "Ink. Violet-biased, never pure black." },
  { name: "sw-fg-muted", role: "text", note: "Column headings, secondary prose, source columns." },
  { name: "sw-fg-faint", role: "text", note: "A statement zero, a placeholder — present but quiet." },
  { name: "sw-accent", role: "text", note: "Links, focus rings, the primary fill." },
  { name: "sw-accent-ink", role: "on-accent", note: "The label on the primary button — judged against its own fill." },
  { name: "sw-debit", role: "text", note: "Chrome only: the rail under a Debit heading. Never a numeral." },
  { name: "sw-credit", role: "text", note: "Chrome only: the rail under a Credit heading. Never a numeral." },
  { name: "sw-pos", role: "text", note: "Numerals only, plus the border of an “ok” chip." },
  { name: "sw-neg", role: "text", note: "Numerals only, plus error chrome that carries a word beside it." },
  { name: "sw-warn", role: "text", note: "The text and border of a warning chip." },
  { name: "sw-line-strong", role: "boundary", note: "Input borders and totals rules — a boundary a user must perceive." },
  { name: "sw-line", role: "decorative", note: "The row hairline. Decorative, and exempt from SC 1.4.11." },
  { name: "sw-frank", role: "decorative", note: "Josef Frank rose. A 3px rail on a note, never a fill, never text." },
];

/** The lengths. These are the ones that decide whether a row can be used. */
const MEASURE_TOKENS: { name: string; note: string; floor?: number; exact?: number }[] = [
  { name: "sw-radius-ledger", note: "Data surfaces. Square, because a rounded corner on a cell is a lie about where the cell ends.", exact: 0 },
  { name: "sw-radius-control", note: "Interactive chrome only — buttons, inputs, the sub-tab pill." },
  { name: "sw-row-dense", note: "A read-only row. Dense is correct here; nothing in it is a pointer target." },
  { name: "sw-row-entry", note: "An editable row. Holds an in-cell input, so it carries the SC 2.5.8 floor.", floor: 24 },
  { name: "sw-touch-min", note: "Row action buttons and small controls — the 2.5.8 floor itself.", floor: 24 },
  { name: "sw-fs-figure", note: "Every figure in the ledger. 13px, so never AA-large: the 4.5:1 bar applies." },
  { name: "sw-fs-label", note: "Column headings and chips." },
  { name: "sw-col-amount", note: "The amount column, fixed so figures line up across panels." },
  { name: "sw-num-gutter", note: "Where the parentheses of a negative hang, outside the digit column." },
];

/* ------------------------------------------------------ measuring, live --- */

interface ColourRow extends TokenSpec {
  value: string;
  ratio: number | null;
  threshold: number | null;
  against: string;
}
interface MeasureRow {
  name: string;
  value: string;
  px: number | null;
  note: string;
  verdict: "pass" | "fail" | null;
}
interface Measurement {
  theme: string;
  colours: ColourRow[];
  measures: MeasureRow[];
  font: string;
  frankShare: number | null;
}

const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const luminance = ([r, g, b]: number[]) =>
  0.2126 * lin(r / 255) + 0.7152 * lin(g / 255) + 0.0722 * lin(b / 255);
const contrast = (a: number[], b: number[]) => {
  const x = luminance(a);
  const y = luminance(b);
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
};

/** Ask the browser what a token actually resolves to, rather than assuming. */
function rgbOf(probe: HTMLElement, value: string): number[] | null {
  if (!value.trim()) return null;
  probe.style.color = "rgb(0, 0, 0)";
  probe.style.color = value.trim();
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(getComputedStyle(probe).color);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function measureAll(root: HTMLElement): Measurement {
  const cs = getComputedStyle(root);
  const token = (n: string) => cs.getPropertyValue(`--${n}`).trim();

  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;left:-9999px;top:0";
  root.appendChild(probe);

  try {
    const surfaces = ["sw-ground", "sw-surface", "sw-surface-2"]
      .map((s) => rgbOf(probe, token(s)))
      .filter((c): c is number[] => c !== null);

    const colours: ColourRow[] = COLOUR_TOKENS.map((spec) => {
      const value = token(spec.name);
      const self = rgbOf(probe, value);
      const fg = rgbOf(probe, token("sw-fg"));
      const accent = rgbOf(probe, token("sw-accent"));

      // Each token is judged against the worst thing it can legitimately land
      // on — a surface token against the ink that sits on it, a text token
      // against the darkest of the three surfaces, the button label against
      // its own fill. Never against a best case.
      if (spec.role === "surface") {
        return {
          ...spec, value, against: "--sw-fg on it", threshold: 4.5,
          ratio: self && fg ? contrast(fg, self) : null,
        };
      }
      if (spec.role === "on-accent") {
        return {
          ...spec, value, against: "--sw-accent", threshold: 4.5,
          ratio: self && accent ? contrast(self, accent) : null,
        };
      }
      const worst = self && surfaces.length
        ? Math.min(...surfaces.map((s) => contrast(self, s)))
        : null;
      return {
        ...spec, value, against: "worst of the three surfaces",
        threshold: spec.role === "text" ? 4.5 : spec.role === "boundary" ? 3 : null,
        ratio: worst,
      };
    });

    const measures: MeasureRow[] = MEASURE_TOKENS.map((m) => {
      const value = token(m.name);
      probe.style.width = "";
      probe.style.display = "block";
      probe.style.width = value;
      const px = value ? probe.getBoundingClientRect().width : null;
      probe.style.display = "";
      probe.style.width = "";
      const verdict =
        m.floor !== undefined && px !== null ? (px >= m.floor ? "pass" : "fail") :
        m.exact !== undefined && px !== null ? (px === m.exact ? "pass" : "fail") :
        null;
      return { name: m.name, value, px, note: m.note, verdict };
    });

    // How much of this page the one warm accent is allowed to cover. Counted,
    // not asserted: every element painted or ruled in Frank rose, over the
    // area of the page itself.
    const frank = rgbOf(probe, token("sw-frank"));
    let share: number | null = null;
    if (frank) {
      const frankRgb = `rgb(${frank[0]}, ${frank[1]}, ${frank[2]})`;
      const page = root.getBoundingClientRect();
      let painted = 0;
      root.querySelectorAll<HTMLElement>("*").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return;
        const s = getComputedStyle(el);
        if (s.backgroundColor === frankRgb) painted += r.width * r.height;
        const edge = (colour: string, width: string, length: number) =>
          colour === frankRgb ? (parseFloat(width) || 0) * length : 0;
        painted += edge(s.borderTopColor, s.borderTopWidth, r.width);
        painted += edge(s.borderBottomColor, s.borderBottomWidth, r.width);
        painted += edge(s.borderLeftColor, s.borderLeftWidth, r.height);
        painted += edge(s.borderRightColor, s.borderRightWidth, r.height);
      });
      const area = page.width * page.height;
      share = area > 0 ? (painted / area) * 100 : null;
    }

    const dark =
      document.documentElement.classList.contains("dark") ||
      document.documentElement.getAttribute("data-theme") === "dark";

    return {
      theme: dark ? "dark" : "light",
      colours,
      measures,
      font: cs.getPropertyValue("--sw-font").trim(),
      frankShare: share,
    };
  } finally {
    probe.remove();
  }
}

/* ------------------------------------------------------------ the page --- */

export default function DesignReferencePage() {
  const root = React.useRef<HTMLDivElement>(null);
  const [m, setM] = React.useState<Measurement | null>(null);

  React.useEffect(() => {
    const el = root.current;
    if (!el) return;
    const run = () => setM(measureAll(el));
    // One frame late, so the first measurement is taken after layout rather
    // than during it — otherwise every rect comes back zero.
    const raf = requestAnimationFrame(run);

    const observer = new MutationObserver(run);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"],
    });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", run);
    window.addEventListener("resize", run);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      media.removeEventListener("change", run);
      window.removeEventListener("resize", run);
    };
  }, []);

  return (
    <div ref={root}>
      <PageHead
        title="Design"
        sub="The Swedish design language these accounting screens are built from, stated as rules and shown as live specimens. Every value below is read out of the stylesheet in your browser, in the theme you are actually in — so this page cannot drift away from what shipped."
      />

      <div className="grid gap-4">
        <Principles />
        <ColourTokens m={m} />
        <MeasureTokens m={m} />
        <ColourRules />
        <Numerals />
        <Primitives />
        <NotDone frankShare={m?.frankShare ?? null} />
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- pieces --- */

function Section({ title, children, id }: { title: string; id: string; children: React.ReactNode }) {
  return (
    <Panel className="overflow-hidden">
      <div
        className="border-b px-3 py-2"
        style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}
      >
        <h2 className="sw-label" id={id}>{title}</h2>
      </div>
      <div className="p-4">{children}</div>
    </Panel>
  );
}

/** A labelled specimen. The label is a heading, not a caption in a colour. */
function Spec({ label, children, note }: { label: string; children: React.ReactNode; note?: string }) {
  return (
    <div>
      <h3 className="sw-label">{label}</h3>
      {note && <p className="sw-sub mt-0.5 max-w-[68ch]">{note}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/**
 * A rule, with the right answer and the wrong one beside it. The wrong one is
 * marked in words as well as by where it sits — the point of the rule is that
 * position and colour are never asked to carry meaning on their own.
 */
function Rule({
  rule, why, right, wrong, rightNote, wrongNote,
}: {
  rule: string; why: string;
  right: React.ReactNode; wrong: React.ReactNode;
  rightNote: string; wrongNote: string;
}) {
  return (
    <div style={{ borderTop: "1px solid var(--sw-line)", paddingTop: "0.9rem" }}>
      <h3 className="text-[0.9375rem] font-semibold">{rule}</h3>
      <p className="sw-sub mt-1 max-w-[74ch]">{why}</p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="p-3" style={{ border: "1px solid var(--sw-line)" }}>
          <p><span className="sw-chip sw-chip-ok">correct</span></p>
          <div className="mt-2">{right}</div>
          <p className="sw-sub mt-2">{rightNote}</p>
        </div>
        <div className="p-3" style={{ border: "1px solid var(--sw-line)" }}>
          <p><span className="sw-chip sw-chip-bad">avoid</span></p>
          <div className="mt-2">{wrong}</div>
          <p className="sw-sub mt-2">{wrongNote}</p>
        </div>
      </div>
    </div>
  );
}

function Principles() {
  return (
    <Section id="principles" title="Three principles, and what each one costs">
      <div className="grid gap-4 lg:grid-cols-3">
        <div>
          <h3 className="text-[0.9375rem] font-semibold">lagom — exactly enough</h3>
          <p className="sw-sub mt-1">
            Nothing on screen a bookkeeper cannot use. Lagom is not minimalism: a trial balance of two
            hundred dense rows is right, and a page of whitespace with six figures on it is not.
          </p>
          <p className="sw-sub mt-2">
            <strong>In this product:</strong> a read-only row is{" "}
            <span className="sw-code">--sw-row-dense</span> and holds one line of figures with no chrome
            around it. An editable row is taller — not for air, but because it contains a pointer target.
          </p>
        </div>
        <div>
          <h3 className="text-[0.9375rem] font-semibold">funkis — the structure is drawn</h3>
          <p className="sw-sub mt-1">
            Form follows function, and the structure is shown rather than hidden behind a hover or a menu.
            Data surfaces are square; only interactive chrome takes a radius.
          </p>
          <p className="sw-sub mt-2">
            <strong>In this product:</strong> the accounting nav draws both of its levels at once instead of
            folding the second into a dropdown, and a table cell has a 0px radius while the button inside it
            has 3px.
          </p>
        </div>
        <div>
          <h3 className="text-[0.9375rem] font-semibold">ljusinsläpp — letting the light in</h3>
          <p className="sw-sub mt-1">
            A warm limewash ground rather than the clinical white that makes an eight-hour ledger session
            hurt. Dark is the same palette rotated, not inverted — paper becomes stained oak.
          </p>
          <p className="sw-sub mt-2">
            <strong>In this product:</strong> the page ground is{" "}
            <span className="sw-code">--sw-ground</span>, panels sit a shade lighter on{" "}
            <span className="sw-code">--sw-surface</span>, and no token anywhere is pure white or pure black —
            the contrast gate fails the build if one appears.
          </p>
        </div>
      </div>
    </Section>
  );
}

function Swatch({ value }: { value: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block align-middle"
      style={{
        width: "2.25rem",
        height: "1.25rem",
        background: value || "transparent",
        border: "1px solid var(--sw-line-strong)",
      }}
    />
  );
}

function Verdict({ ratio, threshold }: { ratio: number | null; threshold: number | null }) {
  if (threshold === null) {
    return <span className="sw-chip" title="Decorative — no contrast minimum applies">exempt</span>;
  }
  if (ratio === null) return <span className="sw-chip">measuring</span>;
  return ratio >= threshold
    ? <span className="sw-chip sw-chip-ok">pass {threshold}:1</span>
    : <span className="sw-chip sw-chip-bad">fail {threshold}:1</span>;
}

function ColourTokens({ m }: { m: Measurement | null }) {
  return (
    <Section id="tokens" title="Colour tokens, measured where they land">
      <p className="sw-sub max-w-[80ch]">
        Sweden&rsquo;s DOS-lagen points at EN 301 549, which points at WCAG 2.1 AA, so this is a legal gate
        rather than a preference. Every text token is measured against the <em>worst</em> surface it can land
        on, not the kindest one; the primary button label is measured against its own fill; a surface is
        measured against the ink that sits on it.{" "}
        {m ? <>Read from the stylesheet in <strong>{m.theme}</strong> theme.</> : "Measuring…"}{" "}
        <code>scripts/verify-contrast.mjs</code> runs the same arithmetic in the build.
      </p>

      <div className="sw-scroll mt-3">
        <table className="sw-table">
          <caption className="sr-only">
            Every colour token, its computed value, and its measured contrast ratio
          </caption>
          <thead>
            <tr>
              <th style={{ width: "3.5rem" }}><span className="sr-only">Swatch</span></th>
              <th style={{ minWidth: "11rem" }}>Token</th>
              <th style={{ width: "6rem" }}>Value</th>
              <th className="sw-num" style={{ width: "6rem" }}>Ratio</th>
              <th style={{ width: "9rem" }}>Measured against</th>
              <th style={{ width: "8rem" }}>Verdict</th>
              <th className="hidden lg:table-cell">What it is for</th>
            </tr>
          </thead>
          <tbody>
            {(m?.colours ?? COLOUR_TOKENS.map((t) => ({
              ...t, value: "", ratio: null, threshold: null, against: "",
            }) as ColourRow)).map((c) => (
              <tr key={c.name}>
                <td><Swatch value={c.value} /></td>
                <th scope="row" style={{ fontWeight: 400 }}>
                  <span className="sw-code">--{c.name}</span>
                </th>
                <td className="sw-code">{c.value || "…"}</td>
                <td className="sw-num">{c.ratio === null ? <span className="sw-zero">–</span> : `${c.ratio.toFixed(2)}:1`}</td>
                <td className="sw-sub">{c.against}</td>
                <td><Verdict ratio={c.ratio} threshold={c.threshold} /></td>
                <td className="hidden lg:table-cell sw-sub">{c.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="sw-sub mt-2 max-w-[80ch]">
        Two tokens are exempt and say so rather than quietly failing:{" "}
        <span className="sw-code">--sw-line</span> is the decorative row hairline, and{" "}
        <span className="sw-code">--sw-frank</span> is a 3px rail that never carries text or meaning on its
        own. Everything else has a number and a verdict.
      </p>
    </Section>
  );
}

function MeasureTokens({ m }: { m: Measurement | null }) {
  return (
    <Section id="measure" title="Measure and geometry">
      <p className="sw-sub max-w-[80ch]">
        Type sizes, row heights and cell padding are in <code>rem</code> so they grow with the reader&rsquo;s
        base font size; hairlines, focus rings and radii stay in <code>px</code> because a 1px rule that
        scales becomes a 3px rule. The pixel column below is what these resolve to right now, at your
        current root font size.
      </p>
      <div className="sw-scroll mt-3">
        <table className="sw-table">
          <caption className="sr-only">Length tokens, their declared value and what they resolve to</caption>
          <thead>
            <tr>
              <th style={{ minWidth: "11rem" }}>Token</th>
              <th style={{ width: "6rem" }}>Declared</th>
              <th className="sw-num" style={{ width: "6rem" }}>Resolves to</th>
              <th style={{ width: "8rem" }}>Verdict</th>
              <th className="hidden md:table-cell">Why it is that</th>
            </tr>
          </thead>
          <tbody>
            {(m?.measures ?? MEASURE_TOKENS.map((t) => ({
              name: t.name, value: "", px: null, note: t.note, verdict: null,
            }) as MeasureRow)).map((r) => (
              <tr key={r.name}>
                <th scope="row" style={{ fontWeight: 400 }}>
                  <span className="sw-code">--{r.name}</span>
                </th>
                <td className="sw-code">{r.value || "…"}</td>
                <td className="sw-num">{r.px === null ? <span className="sw-zero">–</span> : `${r.px.toFixed(2)}px`}</td>
                <td>
                  {r.verdict === "pass" ? <span className="sw-chip sw-chip-ok">meets the floor</span>
                    : r.verdict === "fail" ? <span className="sw-chip sw-chip-bad">below the floor</span>
                    : <span className="sw-chip">no gate</span>}
                </td>
                <td className="hidden md:table-cell sw-sub">{r.note}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={4}>Typeface</th>
              <td className="sw-sub">{m?.font || "…"}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="sw-sub mt-2 max-w-[80ch]">
        WCAG 2.2 SC 2.5.8 wants a 24&times;24 CSS px pointer target.{" "}
        <span className="sw-code">--sw-touch-min</span> is the floor itself and{" "}
        <span className="sw-code">--sw-row-entry</span> is the row height that clears it with an input inside
        — which is why the editable grid is not as dense as the read-only one. Density yields to the target
        size, never the other way round.
      </p>
    </Section>
  );
}

function ColourRules() {
  return (
    <Section id="rules" title="The colour rules, shown rather than described">
      <p className="sw-sub max-w-[80ch]">
        Roughly one man in twelve cannot separate the Falu red from the ink, and a ledger gets printed,
        photocopied and faxed. So colour is a second signal here, never the first one.
      </p>

      <div className="mt-4 grid gap-4">
        <Rule
          rule="Debit and credit tint chrome, never a numeral"
          why="The debit/credit pair says which column you are in — a property of the table, not of the amount. Tinting the figures costs you the one thing the figure column has to do, which is read as one uninterrupted run of ink."
          right={
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">Correct: debit and credit marked by a header rail, figures in ink</caption>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th className="sw-col-debit sw-num" style={{ width: "7rem" }}>Debit</th>
                    <th className="sw-col-credit sw-num" style={{ width: "7rem" }}>Credit</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="sw-code">1010</td>
                    <td className="sw-num"><Figure minor={250000} colour={false} /></td>
                    <td className="sw-num"><span className="sw-zero">–</span></td>
                  </tr>
                  <tr>
                    <td className="sw-code">3000</td>
                    <td className="sw-num"><span className="sw-zero">–</span></td>
                    <td className="sw-num"><Figure minor={250000} colour={false} /></td>
                  </tr>
                </tbody>
              </table>
            </div>
          }
          rightNote="A 2px rail under the heading, drawn with --sw-debit and --sw-credit. The figures stay ink."
          wrong={
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">Avoid: debit and credit colour applied to the figures themselves</caption>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th className="sw-num" style={{ width: "7rem" }}>Debit</th>
                    <th className="sw-num" style={{ width: "7rem" }}>Credit</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="sw-code">1010</td>
                    <td className="sw-num" style={{ color: "var(--sw-debit)" }}>2,500.00</td>
                    <td className="sw-num"><span className="sw-zero">–</span></td>
                  </tr>
                  <tr>
                    <td className="sw-code">3000</td>
                    <td className="sw-num"><span className="sw-zero">–</span></td>
                    <td className="sw-num" style={{ color: "var(--sw-credit)" }}>2,500.00</td>
                  </tr>
                </tbody>
              </table>
            </div>
          }
          wrongNote="Two tinted columns and no heading rail. The column is already named; the tint only makes the figures harder to compare."
        />

        <Rule
          rule="Positive and negative colour numerals, never chrome"
          why="--sw-pos and --sw-neg mean “this quantity is above or below zero”. Spend them on a header band or a row fill and they stop meaning that, so the one place they are load-bearing stops working."
          right={
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">Correct: the sign lives on the figure</caption>
                <tbody>
                  <tr>
                    <th scope="row">Net movement</th>
                    <td className="sw-num" style={{ width: "8rem" }}><Figure minor={-124075} zero="zero" /></td>
                  </tr>
                  <tr>
                    <th scope="row">Closing cash</th>
                    <td className="sw-num"><Figure minor={981200} zero="zero" /></td>
                  </tr>
                </tbody>
              </table>
            </div>
          }
          rightNote="The figure carries the sign, in parentheses and in Falu red. The row header stays ink."
          wrong={
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">Avoid: the sign moved onto the row chrome</caption>
                <tbody>
                  <tr>
                    <th scope="row" style={{ background: "var(--sw-neg)", color: "var(--sw-accent-ink)" }}>
                      Net movement
                    </th>
                    <td className="sw-num" style={{ width: "8rem" }}>1,240.75</td>
                  </tr>
                  <tr>
                    <th scope="row">Closing cash</th>
                    <td className="sw-num">9,812.00</td>
                  </tr>
                </tbody>
              </table>
            </div>
          }
          wrongNote="A red band and a bare figure. Print it and the row is simply wrong — 1,240.75 reads as money coming in."
        />

        <Rule
          rule="Colour is never the only carrier"
          why="Every negative is written in parentheses whether or not it is coloured, because the parenthesis is the part that survives a monochrome print, a colour-blind reader and a screen reader reading the cell aloud."
          right={
            <p className="text-[0.9375rem] tabular-nums">
              <span className="sw-num-neg">(1,240.75)</span>{" "}
              <span className="sw-sub">— accrued, reversing on the first of next month</span>
            </p>
          }
          rightNote="Parentheses first, colour second. Remove the colour and nothing is lost."
          wrong={
            <p className="text-[0.9375rem] tabular-nums">
              <span className="sw-num-neg">1,240.75</span>{" "}
              <span className="sw-sub">— accrued, reversing on the first of next month</span>
            </p>
          }
          wrongNote="Red and nothing else. One reader in twelve sees a positive figure, and so does the printer."
        />

        <Rule
          rule="One warm accent, held under two per cent"
          why="The Josef Frank rose is the single moment of warmth in the palette. It works because it is rare: it marks a note and nothing else, as a rail, never as a fill and never as text."
          right={<div className="sw-note">Depreciation posts one month at a time and is never recomputed.</div>}
          rightNote="A 3px rail on the reading edge. Everything else on the note is ordinary ink on paper."
          wrong={
            <div className="p-3" style={{ background: "var(--sw-frank)", color: "var(--sw-fg)" }}>
              Depreciation posts one month at a time and is never recomputed.
            </div>
          }
          wrongNote="A filled panel spends the whole accent budget in one place — and rose is a decorative token, so text on it has no measured contrast to stand on."
        />
      </div>
    </Section>
  );
}

const ALIGNMENT: { label: string; minor: number }[] = [
  { label: "Bank", minor: 900 },
  { label: "Trade receivables", minor: 125000 },
  { label: "Accruals", minor: -4830075 },
  { label: "Share capital", minor: 700000000 },
  { label: "Suspense", minor: 0 },
];

function Numerals() {
  return (
    <Section id="numerals" title="How a figure is written">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="grid gap-4 content-start">
          <Spec
            label="A negative is in parentheses"
            note="The accounting convention, and the only negative marker that survives a photocopier. fmtMinor writes it; the colour is applied separately and never alone."
          >
            <span className="text-[0.9375rem] tabular-nums"><Figure minor={-4830075} /></span>
            <span className="sw-sub">is minus 48,300.75</span>
          </Spec>

          <Spec
            label="A statement zero is an en dash"
            note="A zero in a statement means “nothing here”, not “a balance of 0.00”. Written as 0.00 it competes with the real figures around it; written as a dash it steps back."
          >
            <span className="text-[0.9375rem] tabular-nums"><Figure minor={0} /></span>
            <span className="sw-sub">against</span>
            <span className="text-[0.9375rem] tabular-nums"><Figure minor={0} zero="zero" colour={false} /></span>
            <span className="sw-sub">where a total genuinely is zero</span>
          </Spec>

          <Spec
            label="A slashed zero decides an account code"
            note="0 against O is the difference between an account that exists and one that does not. The whole surface sets font-feature-settings: “tnum” 1, “zero” 1, and .sw-code asks for slashed-zero again explicitly."
          >
            <span className="sw-code text-[1.0625rem]">1010</span>
            <span className="sw-sub">against the letters</span>
            <span className="sw-code text-[1.0625rem]">lOlO</span>
          </Spec>
        </div>

        <div>
          <h3 className="sw-label">Tabular figures line the column up</h3>
          <p className="sw-sub mt-0.5">
            Every digit is the same width, so a column of wildly different magnitudes still stacks on the
            decimal point — and the parentheses of a negative hang outside the digit column, in{" "}
            <span className="sw-code">--sw-num-gutter</span>, rather than shunting the digits left.
          </p>
          <div className="sw-scroll mt-2">
            <table className="sw-table">
              <caption className="sr-only">
                A column of varied-width figures, to show that tabular numerals keep them aligned
              </caption>
              <thead>
                <tr>
                  <th>Account</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Balance</th>
                </tr>
              </thead>
              <tbody>
                {ALIGNMENT.map((r) => (
                  <tr key={r.label}>
                    <td>{r.label}</td>
                    <td className="sw-num"><Figure minor={r.minor} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Total</th>
                  <td className="sw-num">
                    <Figure
                      minor={ALIGNMENT.reduce((a, r) => a + r.minor, 0)}
                      zero="zero"
                      colour={false}
                    />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="sw-sub mt-2">
            The totals row is a <code>&lt;th scope=&quot;row&quot;&gt;</code>, so a screen reader announces
            &ldquo;Total&rdquo; with the figure instead of reading a number out of context, and the table
            carries a <code>&lt;caption class=&quot;sr-only&quot;&gt;</code> saying what it is.
          </p>
        </div>
      </div>
    </Section>
  );
}

function Primitives() {
  return (
    <Section id="primitives" title="The primitives, live">
      <div className="grid gap-5">
        <Spec
          label="sw-btn"
          note="A blocked action is never a silently dead button. It keeps aria-disabled rather than the disabled attribute, so it stays focusable, and the reason sits beside it in words."
        >
          <button type="button" className="sw-btn">Add line</button>
          <button type="button" className="sw-btn sw-btn-primary">Post entry</button>
          <button type="button" className="sw-btn sw-btn-sm">Soft close</button>
          <button
            type="button"
            className="sw-btn sw-btn-primary"
            aria-disabled="true"
            aria-describedby="design-blocker"
          >
            Post entry
          </button>
          <span id="design-blocker" className="sw-sub">
            A journal needs at least two lines with an amount.
          </span>
        </Spec>

        <Spec
          label="sw-icon-btn and sw-link-btn"
          note="Sized to SC 2.5.8 rather than to the glyph inside them — which is how a 12px caret ends up being the whole target. Every icon-only control carries an aria-label."
        >
          <button type="button" className="sw-icon-btn" aria-label="Remove this line">×</button>
          <button type="button" className="sw-icon-btn" aria-label="Expand this entry">▸</button>
          <button type="button" className="sw-link sw-link-btn">Reverse</button>
          <p className="sw-sub max-w-[68ch]">
            An ordinary{" "}
            <Link href="/accounting/trial-balance" className="sw-link">link inside a sentence</Link>{" "}
            takes the inline exception in SC 2.5.8 instead, because its size is set by the line-height of
            the text around it. A link alone in a table cell does not, which is what sw-link-btn is for.
          </p>
        </Spec>

        <Spec label="sw-input, sw-select and the small pair">
          <label className="sr-only" htmlFor="design-input">Specimen text input</label>
          <input id="design-input" className="sw-input" style={{ width: "14rem" }} placeholder="Code or name" />
          <label className="sr-only" htmlFor="design-select">Specimen select</label>
          <select id="design-select" className="sw-select" style={{ width: "9rem" }} defaultValue="2026-02">
            <option value="2026-01">2026-01</option>
            <option value="2026-02">2026-02</option>
          </select>
          <label className="sr-only" htmlFor="design-select-sm">Specimen small select</label>
          <select id="design-select-sm" className="sw-select sw-select-sm" style={{ width: "9rem" }} defaultValue="6350">
            <option value="6350">6350 Bank charges</option>
            <option value="4900">4900 Other income</option>
          </select>
        </Spec>

        <div>
          <h3 className="sw-label">sw-cell — the editable grid</h3>
          <p className="sw-sub mt-0.5 max-w-[74ch]">
            Cell inputs are chromeless until touched, because the grid lines already say where the cell is.
            A cell whose text is not an amount takes a rail and <code>aria-invalid</code>, and the reason
            appears under the grid — the rail is never the only signal.
          </p>
          <div className="sw-scroll mt-2">
            <table className="sw-table sw-grid">
              <caption className="sr-only">A specimen journal entry grid with one unreadable amount</caption>
              <thead>
                <tr>
                  <th style={{ width: "3rem" }}>#</th>
                  <th style={{ minWidth: "12rem" }}>Account</th>
                  <th className="sw-col-debit sw-num" style={{ width: "var(--sw-col-amount)" }}>Debit</th>
                  <th className="sw-col-credit sw-num" style={{ width: "var(--sw-col-amount)" }}>Credit</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="sw-code" style={{ paddingInlineStart: "0.625rem" }}>1</td>
                  <td>
                    <input className="sw-cell" aria-label="Specimen line 1 account" defaultValue="1010" />
                  </td>
                  <td><input className="sw-cell sw-cell-num" aria-label="Specimen line 1 debit" defaultValue="2,500.00" /></td>
                  <td><input className="sw-cell sw-cell-num" aria-label="Specimen line 1 credit" /></td>
                </tr>
                <tr>
                  <td className="sw-code" style={{ paddingInlineStart: "0.625rem" }}>2</td>
                  <td>
                    <input className="sw-cell" aria-label="Specimen line 2 account" defaultValue="3000" />
                  </td>
                  <td>
                    <input
                      className="sw-cell sw-cell-num sw-cell-invalid"
                      aria-label="Specimen line 2 debit"
                      aria-invalid
                      defaultValue="two thousand"
                    />
                  </td>
                  <td><input className="sw-cell sw-cell-num" aria-label="Specimen line 2 credit" /></td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={2} style={{ textAlign: "end" }}>Totals</th>
                  <td className="sw-num"><Figure minor={250000} zero="zero" colour={false} /></td>
                  <td className="sw-num"><Figure minor={0} zero="zero" colour={false} /></td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="sw-sub mt-2">One of the amounts is not a number.</p>
        </div>

        <Spec
          label="sw-chip"
          note="A chip always carries a word. The border and text take a token, so the chip still says what it means with the colour removed."
        >
          <span className="sw-chip">header</span>
          <span className="sw-chip sw-chip-ok">agrees</span>
          <span className="sw-chip sw-chip-warn">soft closed</span>
          <span className="sw-chip sw-chip-bad">differs</span>
          <span className="sw-chip sw-chip-accent">control</span>
        </Spec>

        <div>
          <h3 className="sw-label">sw-note and sw-error</h3>
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            <div className="sw-note">
              Pasted 3 rows. Nothing has been posted — check the lines, then post.
            </div>
            <div className="sw-error">
              2026-01 is hard closed. Post the correction into an open period instead.
            </div>
          </div>
          <p className="sw-sub mt-2 max-w-[74ch]">
            A note is rose; an error is Falu red and, in the product, carries{" "}
            <code>role=&quot;alert&quot;</code> so it reaches a screen reader without stealing focus. The
            specimen above omits the role, because a live region on a reference page announces nothing
            useful. Both say the whole thing in words — neither leans on the colour of its rail.
          </p>
        </div>

        <div>
          <h3 className="sw-label">sw-tabs and sw-subtab</h3>
          <p className="sw-sub mt-0.5 max-w-[74ch]">
            Two levels, both drawn. The group row is an underline; the second level is a quieter pill, so the
            two read as a hierarchy rather than competing. The current one is marked with{" "}
            <code>aria-current</code>, not by colour alone — it is also the only one in a heavier weight.
          </p>
          <div className="mt-2">
            <div className="sw-tabs sw-scroll">
              <span className="sw-tab" aria-current="page">Record</span>
              <span className="sw-tab">Money</span>
              <span className="sw-tab">Reports</span>
            </div>
            <div className="sw-scroll mt-1.5 flex gap-1">
              <span className="sw-subtab" aria-current="page">Overview</span>
              <span className="sw-subtab">Journals</span>
              <span className="sw-subtab">Chart of accounts</span>
            </div>
          </div>
        </div>

        <Spec
          label="Type"
          note="Four sizes and no more: a page title, body, a figure, and an uppercase label for column headings and chips."
        >
          <span className="sw-title">Trial balance</span>
          <span className="sw-sub">Cumulative to the end of the chosen period</span>
          <span className="sw-label">Total debits</span>
          <span className="sw-code">4950</span>
        </Spec>
      </div>
    </Section>
  );
}

function NotDone({ frankShare }: { frankShare: number | null }) {
  return (
    <Section id="not-done" title="What this system deliberately does not do">
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        <div>
          <h3 className="text-[0.9375rem] font-semibold">No shadows for elevation</h3>
          <p className="sw-sub mt-1">
            A panel is separated by a hairline and a change of surface value, not by a drop shadow. Shadows
            imply a light source that a ledger does not have, they blur the edge of the thing they are
            meant to define, and on a dense table twenty of them turn the page to mud.
          </p>
        </div>
        <div>
          <h3 className="text-[0.9375rem] font-semibold">No zebra striping</h3>
          <p className="sw-sub mt-1">
            Alternating row fills are a workaround for rows that are too tall and columns that are too far
            apart. The hairline under each row does the same job with a tenth of the ink, and hover shades
            the row you are actually on — which is the one you needed help with.
          </p>
        </div>
        <div>
          <h3 className="text-[0.9375rem] font-semibold">No colour as the only carrier</h3>
          <p className="sw-sub mt-1">
            Every state that matters is written as well as coloured: a negative has parentheses, a chip has
            a word, an invalid cell has <code>aria-invalid</code> and a sentence, a current tab has{" "}
            <code>aria-current</code> and a heavier weight.
          </p>
        </div>
        <div>
          <h3 className="text-[0.9375rem] font-semibold">No radius on a data surface</h3>
          <p className="sw-sub mt-1">
            <span className="sw-code">--sw-radius-ledger</span> is 0px and stays 0px. Only interactive
            chrome takes <span className="sw-code">--sw-radius-control</span>, so a rounded corner is a
            reliable signal that something can be clicked.
          </p>
        </div>
        <div>
          <h3 className="text-[0.9375rem] font-semibold">No icon without a name</h3>
          <p className="sw-sub mt-1">
            An icon-only control carries an <code>aria-label</code> naming the row it acts on —
            &ldquo;Remove line 3&rdquo;, not &ldquo;Remove&rdquo; — and is sized to the target floor rather
            than to the glyph.
          </p>
        </div>
        <div>
          <h3 className="text-[0.9375rem] font-semibold">No second warm accent</h3>
          <p className="sw-sub mt-1">
            The Frank rose is held under two per cent of the screen. On this page, measured live, it covers{" "}
            <strong>{frankShare === null ? "…" : `${frankShare.toFixed(3)}%`}</strong> of the painted area —
            counted from the rails actually drawn, not asserted.
          </p>
        </div>
      </div>
    </Section>
  );
}
