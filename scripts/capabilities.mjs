/**
 * Enumerate what this product can do, from the product itself.
 *
 * A capability register kept by hand is a register that stops agreeing with
 * the code the first week nobody updates it. This one is derived, so it is
 * either right or it is a bug in this file — and it can be diffed between
 * revisions to see what a change actually added.
 *
 * A "capability" here is one thing a user or an integration can ask the
 * product to do, or one guarantee it makes and holds:
 *
 *   operation  an exported function in a ledger module — the unit of work
 *   endpoint   an HTTP verb, or a named action within one
 *   screen     a page somebody navigates to
 *   rule       a constraint or trigger the database enforces itself
 *   check      an assertion in the verification suites
 *
 * Anything counted twice would flatter the total, so an operation reached
 * through an endpoint is counted once as each — they are different things: one
 * is what the code can do, the other is what is reachable over the wire, and a
 * product with the first and not the second has a gap.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const rows = [];
const add = (kind, area, name, detail = "") => rows.push({ kind, area, name, detail });

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

/* ---------------------------------------------------------- operations */

const LEDGER = join(root, "src/lib/server/ledger");
for (const f of readdirSync(LEDGER).filter((f) => f.endsWith(".ts")).sort()) {
  const area = f.replace(/\.ts$/, "");
  const src = readFileSync(join(LEDGER, f), "utf8");
  for (const m of src.matchAll(/^export (?:async )?function (\w+)/gm)) {
    add("operation", area, m[1]);
  }
}

/* ----------------------------------------------------------- endpoints */

for (const p of walk(join(root, "src/app/api")).filter((p) => p.endsWith("route.ts"))) {
  const src = readFileSync(p, "utf8");
  const path = p.replace(root + "/src/app", "").replace(/\/route\.ts$/, "");
  const verbs = [...src.matchAll(/^export async function (GET|POST|PUT|PATCH|DELETE)/gm)].map((m) => m[1]);
  // A switch on `action` means one endpoint carries several capabilities;
  // counting it once would understate a route that does eight things.
  const actions = [...src.matchAll(/^\s*case "([\w-]+)":/gm)].map((m) => m[1]);
  const unique = [...new Set(actions)];
  if (unique.length) {
    for (const a of unique) add("endpoint", path, `${a}`, path);
  }
  for (const v of verbs) {
    if (unique.length && v === "POST") continue;
    add("endpoint", path, v, path);
  }
}

/* ------------------------------------------------------------- screens */

const APP = join(root, "src/app/(app)");
for (const p of walk(APP).filter((p) => p.endsWith("page.tsx"))) {
  add("screen", "ui", p.replace(root + "/src/app/(app)", "").replace(/\/page\.tsx$/, "") || "/");
}

/* --------------------------------------------------------------- rules */

const MIG = join(root, "prisma/migrations");
for (const d of readdirSync(MIG).filter((d) => statSync(join(MIG, d)).isDirectory()).sort()) {
  const sql = readFileSync(join(MIG, d, "migration.sql"), "utf8");
  for (const m of sql.matchAll(/CONSTRAINT "([\w]+)"\s+CHECK/g)) add("rule", "database", m[1]);
  for (const m of sql.matchAll(/ADD CONSTRAINT "([\w]+)"\s+(?:CHECK|EXCLUDE)/g)) add("rule", "database", m[1]);
  for (const m of sql.matchAll(/CREATE TRIGGER "?([\w]+)"?/g)) add("rule", "database", m[1]);
  for (const m of sql.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\(/g)) add("rule", "database", `${m[1]}()`);
}

/* -------------------------------------------------------------- checks */

for (const f of readdirSync(join(root, "test")).filter((f) => f.endsWith(".test.ts")).sort()) {
  const src = readFileSync(join(root, "test", f), "utf8");
  for (const m of src.matchAll(/^\s*it\(\s*["'`](.+?)["'`]/gm)) {
    add("check", f.replace(/\.test\.ts$/, ""), m[1]);
  }
}
for (const f of readdirSync(join(root, "scripts")).filter((f) => f.startsWith("verify-"))) {
  const src = readFileSync(join(root, "scripts", f), "utf8");
  const n = [...src.matchAll(/\b(?:ok|check)\(\s*["'`](.+?)["'`]/g)].length;
  for (let i = 0; i < n; i++) add("check", f.replace(/\.mjs$/, ""), `assertion ${i + 1}`);
}

/* -------------------------------------------------------------- output */

const seen = new Set();
const unique = rows.filter((r) => {
  const k = `${r.kind}:${r.area}:${r.name}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

const byKind = {};
for (const r of unique) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ total: unique.length, byKind, rows: unique }, null, 2));
} else {
  for (const [kind, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${kind}`);
  }
  console.log(`  ${String(unique.length).padStart(5)}  TOTAL`);
}
