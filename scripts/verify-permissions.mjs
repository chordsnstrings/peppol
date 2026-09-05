/**
 * Proves that every permission the product offers is actually checked, and
 * that every route that changes something checks one.
 *
 * The roles screen says "Grant one role and enforcement begins", and
 * `createRole` refuses an unknown key on the stated grounds that "a permission
 * nobody can check is a permission nobody holds". Both of those are promises
 * about source that nothing was holding source to. Seven of the twenty-one keys
 * once appeared only in the catalogue and its own test, and forty-nine of the
 * sixty-seven ledger routes called no guard at all — so a role could be granted,
 * shown on screen with its effects spelled out, and enforce nothing.
 *
 * This reads source. It cannot run a request and it does not try: what it
 * checks is that the wiring exists, which is the part that rots silently. The
 * HTTP suites check that the wiring works.
 *
 *   node scripts/verify-permissions.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let pass = 0;
let fail = 0;
const ok = (n, extra = "") => { pass++; console.log(`  PASS  ${n}${extra ? ` — ${extra}` : ""}`); };
const bad = (n, e) => { fail++; console.log(`  FAIL  ${n}${e ? ` — ${e}` : ""}`); };

const read = (p) => readFileSync(p, "utf8");

/** Every route.ts under a directory, recursively. */
function routesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name === "route.ts") out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

const CATALOGUE = "src/lib/server/ledger/permissions.ts";
const source = read(CATALOGUE);

/* ------------------------------------------------------------ the catalogue */

const keys = [...source.matchAll(/\{\s*key:\s*"([a-z_.]+)"/g)].map((m) => m[1]);

console.log("\nPERMISSIONS");

keys.length >= 20
  ? ok(`the catalogue is readable — ${keys.length} permissions`)
  : bad("the catalogue could not be read", `found ${keys.length} keys, expected at least 20`);

const duplicates = keys.filter((k, i) => keys.indexOf(k) !== i);
duplicates.length === 0
  ? ok("no permission is declared twice")
  : bad("a permission is declared twice", [...new Set(duplicates)].join(", "));

/* -------------------------------------------------- every key is checked ---- */

const ROUTES = routesUnder("src/app/api");
const bodies = new Map(ROUTES.map((p) => [p, read(p)]));
const allRouteSource = [...bodies.values()].join("\n");

const unchecked = keys.filter((k) => !allRouteSource.includes(`"${k}"`));
unchecked.length === 0
  ? ok(`every permission is required by at least one route — ${keys.length} of ${keys.length}`)
  : bad(
      `${unchecked.length} permission(s) are granted by the roles screen and checked nowhere`,
      unchecked.join(", "),
    );

/* --------------------------------- every route that writes checks something - */

/*
 * A GET may legitimately be open where the session alone is the control — but a
 * POST, PUT, PATCH or DELETE changes something, and the roles screen promises
 * that granting a role begins enforcing it. So a mutating ledger route with no
 * guard is a promise not kept.
 *
 * Routes outside `api/ledger` are excluded deliberately: auth, billing and the
 * platform-admin surfaces have their own controls (`requireWritableSession`,
 * `assertPlatformAdmin`) and answer to a different question.
 */
const LEDGER = ROUTES.filter((p) => p.startsWith("src/app/api/ledger/"));
const MUTATING = /export async function (POST|PUT|PATCH|DELETE)\b/;

const unguarded = LEDGER.filter((p) => MUTATING.test(bodies.get(p)) && !bodies.get(p).includes("requirePermission"));
unguarded.length === 0
  ? ok(`every ledger route that changes something asks who is asking — ${LEDGER.length} routes`)
  : bad(
      `${unguarded.length} ledger route(s) change something and check no permission`,
      unguarded.map((p) => p.replace("src/app/api/ledger/", "").replace("/route.ts", "")).join(", "),
    );

/* ------------------------------------ every route that reads asks too ------- */

/*
 * A GET is not exempt, and treating it as one was how fourteen routes came to
 * be readable by anybody with a session: the journals, the bank reconciliation,
 * the corporate tax computation, the expense claims with what is owed to staff,
 * and the roles overview showing who may do what.
 *
 * `ledger.read` is the key most of them want, and the shipped Viewer holds it —
 * so guarding a read costs an ordinary reader nothing and costs a person with
 * no role the whole ledger. A route that is genuinely open says so on the line
 * above with the same `open-read:` marker convention the org-wide exception
 * uses, in the source rather than in a list somewhere else.
 */
const OPEN_READ_MARKER = "open-read:";

/**
 * The body of one exported handler, so a guard on the POST does not count as a
 * guard on the GET — which is what most of these files look like.
 */
function handlerBody(source, verb) {
  const start = source.search(new RegExp(`export async function ${verb}\\b`));
  if (start === -1) return null;
  const rest = source.slice(start + 1);
  const next = rest.search(/export async function [A-Z]+\b/);
  return next === -1 ? rest : rest.slice(0, next);
}

const unread = [];
for (const p of LEDGER) {
  const get = handlerBody(bodies.get(p), "GET");
  if (get === null) continue;
  if (get.includes("requirePermission")) continue;
  if (get.includes(OPEN_READ_MARKER)) continue;
  unread.push(p.replace("src/app/api/ledger/", "").replace("/route.ts", ""));
}
unread.length === 0
  ? ok("every ledger route that reads asks who is asking, or says why it need not")
  : bad(
      `${unread.length} ledger route(s) are readable by anybody with a session`,
      unread.join(", "),
    );

/* ---------------------------------------- a guard names a key that exists --- */

/*
 * `createRole` refuses an unknown key so a typo cannot become a permission
 * nobody holds. The same typo in a ROUTE is worse and nothing refuses it: the
 * guard would ask for a key no role can grant, so the route becomes unreachable
 * for everybody the moment any role is configured.
 */
const known = new Set(keys);
const invented = [];
for (const [p, body] of bodies) {
  for (const m of body.matchAll(/permission:\s*"([a-z_.]+)"/g)) {
    if (!known.has(m[1])) invented.push(`${p.replace("src/app/api/", "")}: ${m[1]}`);
  }
}
invented.length === 0
  ? ok("every guard names a permission the catalogue defines")
  : bad("a guard asks for a permission no role can grant", invented.join(", "));

/* ------------------------------------ a guard is scoped to one entity ------- */

/*
 * `permissionsOf` narrows a person's grants to one entity only when it is given
 * one — and most guards were not giving it one. A role granted on entity A
 * therefore satisfied a guard for a document in entity B, which is the same
 * cross-entity hole `gl_line_guard` closes inside the ledger and the reason
 * `outstandingOnOrder` was rescoped.
 *
 * So a route that knows which entity it is acting on has to say so. A route
 * that genuinely acts across the whole organisation — roles, a consolidation
 * group, an intercompany report — legitimately does not, and says why on the
 * line above, in the source, where somebody changing it will read it.
 */
const ORG_WIDE_MARKER = "org-wide:";

const unscoped = [];
for (const p of LEDGER) {
  const body = bodies.get(p);
  // A route that never sees an entity has none to pass.
  if (!/entityId/.test(body)) continue;
  const lines = body.split("\n");
  lines.forEach((line, i) => {
    if (!line.includes("requirePermission({")) return;
    if (line.includes("entityId")) return;
    // The reason may sit on the line above or in the comment block before it.
    const before = lines.slice(Math.max(0, i - 6), i).join("\n");
    if (before.includes(ORG_WIDE_MARKER)) return;
    unscoped.push(`${p.replace("src/app/api/ledger/", "").replace("/route.ts", "")}:${i + 1}`);
  });
}
unscoped.length === 0
  ? ok("every guard is scoped to the entity it is acting on, or says why not")
  : bad(
      `${unscoped.length} guard(s) ask org-wide in a route that knows its entity`,
      unscoped.slice(0, 12).join(", ") + (unscoped.length > 12 ? `, and ${unscoped.length - 12} more` : ""),
    );

/* ------------------------------------------- the no-roles escape hatch ------ */

/*
 * The one behaviour that must never change: a workspace that has configured no
 * roles behaves exactly as it did before roles existed. A release that silently
 * locks somebody out of their own books at a month end is worse than no
 * permissions at all — and now that fifty-odd routes call the guard, this
 * sentence is what stands between an upgrade and a locked workspace.
 */
/(no roles configured)/.test(source)
  ? ok("a workspace with no roles configured is still allowed everything")
  : bad("the no-roles escape hatch is gone", "check(): every route now guarded would lock an unconfigured workspace out");

/* --------------------------------------------- separation of duties holds --- */

const conflicts = [...source.matchAll(/\[\s*"([a-z_.]+)"\s*,\s*"([a-z_.]+)"\s*\]/g)].flat().filter((s) => s.includes("."));
const unknownInConflicts = conflicts.filter((k) => !known.has(k));
unknownInConflicts.length === 0
  ? ok("every separation-of-duties pair names a real permission")
  : bad("a conflict pair names a permission that does not exist", [...new Set(unknownInConflicts)].join(", "));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
