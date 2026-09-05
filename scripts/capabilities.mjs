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

/* ---------------------------------------------------------------- join */

/*
 * The three lists above are three lists, and counting them separately is how a
 * product can hold a complete, tested, routed subledger that no screen calls.
 * That is not hypothetical: postInvoice, postReceipt, postBill and
 * postSupplierPayment were all present, all tested, all routed at
 * /api/ledger/ar/post and /api/ledger/ap/post, and the count went up by eight
 * while the daily loop an accounting product exists for — raise an invoice,
 * post it, receive against it, enter a bill, pay it — stayed unreachable from
 * every screen in the product.
 *
 * So the register joins the lists rather than concatenating them:
 *
 *   endpoint  -> screen    does any page, component or hook reach this route?
 *   operation -> anything  does anything outside its own module name it?
 *
 * Both joins read source, which is exactly the grep a person would run, and is
 * why they cannot drift from what is actually wired.
 *
 * Neither is a proof. A screen may build a path from a variable — the ageing
 * report takes endpoint="ar" and interpolates it — and no static reading will
 * see that. So the endpoint join reports CANDIDATES, and --check ratchets on
 * the count rather than demanding zero: what must never happen is the number
 * going up, because an endpoint no screen calls is a capability added to the
 * count and to nothing else.
 */

const ROUTE_FILES = walk(join(root, "src/app/api")).filter((p) => p.endsWith("route.ts"));

const UI_SRC = [
  ...walk(join(root, "src/app/(app)")),
  ...walk(join(root, "src/components")),
  ...walk(join(root, "src/hooks")),
]
  .filter((p) => /\.tsx?$/.test(p))
  .map((p) => readFileSync(p, "utf8"))
  .join("\n");

const TEST_SRC = readdirSync(join(root, "test"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => readFileSync(join(root, "test", f), "utf8"))
  .join("\n");

const ROUTE_SRC = ROUTE_FILES.map((p) => readFileSync(p, "utf8")).join("\n");

const word = (name) => new RegExp(`\\b${name}\\b`);

/*
 * A route reached through a server component rather than over the wire is
 * still reached: several screens import the ledger module directly and never
 * touch their own endpoint. So the join also asks whether any operation the
 * route imports is named in the interface.
 *
 * Short names are excluded because they collide with the language itself —
 * `reverse`, `post` and `sort` appear in any React file — and a collision here
 * would mark a genuine gap as reached, which is the one error this must not
 * make.
 */
const namedInUi = (name) => name.length > 8 && word(name).test(UI_SRC);

const endpointReached = new Map();
for (const rp of ROUTE_FILES) {
  const src = readFileSync(rp, "utf8");
  const path = rp.replace(root + "/src/app", "").replace(/\/route\.ts$/, "");
  // A dynamic segment is written [id] in the filesystem and ${id} in the
  // caller, so the literal never matches. Match the shape instead.
  const asRegex = new RegExp(
    path.replace(/[.*+?^${}()|\\]/g, "\\$&").replace(/\\\[[^\]]+\\\]|\[[^\]]+\]/g, "[^\"'`\\s)]+"),
  );
  /* Only the domain modules count. Every route imports requirePermission,
   * LedgerError and ledgerJson, and LedgerError is caught by name in a dozen
   * server components — so counting the infrastructure would mark every route
   * in the product as reached. */
  const INFRASTRUCTURE = new Set(["permissions", "post", "serialize", "balances"]);
  const imported = [...src.matchAll(/import\s*\{([^}]+)\}\s*from\s*"@\/lib\/server\/ledger\/([\w-]+)"/g)]
    .filter((m) => !INFRASTRUCTURE.has(m[2]))
    .flatMap((m) => m[1].split(",").map((n) => n.trim().replace(/^type\s+/, "")))
    .filter((n) => /^[a-zA-Z_$][\w$]*$/.test(n));
  endpointReached.set(path, asRegex.test(UI_SRC) || imported.some(namedInUi));
}

/** Ledger endpoints nothing in the interface appears to reach. */
const unreachedEndpoints = [...endpointReached]
  .filter(([path, reached]) => !reached && path.startsWith("/api/ledger/"))
  .map(([path]) => path)
  .sort();

/*
 * Operations named nowhere but their own module — not by a route, not by the
 * interface, not by another ledger module, not even by a test. That is dead
 * code rather than an unreachable feature, which is why the two are counted
 * apart.
 */
const LEDGER_SRC_BY_AREA = new Map();
for (const f of readdirSync(LEDGER).filter((f) => f.endsWith(".ts"))) {
  LEDGER_SRC_BY_AREA.set(f.replace(/\.ts$/, ""), readFileSync(join(LEDGER, f), "utf8"));
}
const OUTSIDE = [ROUTE_SRC, UI_SRC, TEST_SRC].join("\n");

const unreachedOperations = unique
  .filter((r) => r.kind === "operation")
  .filter((op) => {
    const re = word(op.name);
    if (re.test(OUTSIDE)) return false;
    for (const [area, src] of LEDGER_SRC_BY_AREA) {
      if (area !== op.area && re.test(src)) return false;
    }
    return true;
  });


/*
 * The target this product was asked to reach.
 *
 * It was given as a number, never as a list — which means it cannot be
 * "ticked off", only measured against. So the register is derived from the
 * source and the number is asserted here, in the verification suite, where a
 * regression that removes capabilities fails the build rather than passing
 * quietly. A count in a document is a claim; a count in a gate is a fact.
 *
 * Checks are excluded from the total on purpose. An assertion is how a
 * capability is held, not another capability, and adding the two together
 * would flatter the figure by the amount of testing.
 */
const TARGET = 1084;
const capabilities = unique.filter((r) => r.kind !== "check").length;

if (process.argv.includes("--list")) {
  // Every row, so the total can be audited rather than believed.
  for (const r of unique.filter((x) => x.kind !== "check")) {
    console.log([r.kind, r.area, r.name, r.detail].filter(Boolean).join("\t"));
  }
  process.exit(0);
}

if (process.argv.includes("--check")) {
  const short = TARGET - capabilities;
  if (short > 0) {
    console.log(`  FAIL  ${capabilities} capabilities — ${short} short of the ${TARGET} asked for`);
    console.log(`\n0 passed, 1 failed\n`);
    process.exit(1);
  }
  console.log(`  PASS  ${capabilities} capabilities against a target of ${TARGET} — ${capabilities - TARGET} beyond it`);
  for (const [kind, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    if (kind === "check") continue;
    console.log(`  PASS  ${n} ${kind}${n === 1 ? "" : "s"}`);
  }
  console.log(`  PASS  ${byKind.check ?? 0} checks hold them`);

  /*
   * A ratchet, not a target. Both figures are gaps that were there before
   * anybody counted them, and a gate that failed until every one was closed
   * would be a gate nobody could run. What must not happen is the number going
   * UP. Lower these as they are closed; never raise them.
   */
  const UNREACHED_ENDPOINTS_CEILING = 4;
  const UNREACHED_OPERATIONS_CEILING = 11;

  let failed = 0;
  const ratchet = (n, ceiling, what) => {
    if (n > ceiling) {
      failed++;
      console.log(`  FAIL  ${n} ${what}, against a ceiling of ${ceiling} — ${n - ceiling} more than there were. Run --gaps to see them.`);
    } else {
      console.log(`  PASS  ${n} ${what}, within the ceiling of ${ceiling}`);
    }
  };
  ratchet(unreachedEndpoints.length, UNREACHED_ENDPOINTS_CEILING, "ledger endpoints no screen appears to reach");
  ratchet(unreachedOperations.length, UNREACHED_OPERATIONS_CEILING, "operations nothing outside their own module names");

  const passed = Object.keys(byKind).length + 2 - failed;
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

if (process.argv.includes("--gaps")) {
  // What the join found, so it can be worked through rather than argued with.
  console.log(`\n${unreachedEndpoints.length} ledger endpoints no page, component or hook appears to reach.`);
  console.log("Some will be reached through a path built from a variable, which no static reading can see.\n");
  for (const path of unreachedEndpoints) console.log(`  ${path}`);
  console.log(`\n${unreachedOperations.length} exported operations nothing outside their own module names — not a route,`);
  console.log("not the interface, not another ledger module, not a test.\n");
  for (const op of unreachedOperations) console.log(`  ${op.area}.${op.name}`);
  console.log("");
  process.exit(0);
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ total: unique.length, capabilities, target: TARGET, byKind, rows: unique }, null, 2));
} else {
  for (const [kind, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${kind}`);
  }
  console.log(`  ${String(unique.length).padStart(5)}  TOTAL`);
}
