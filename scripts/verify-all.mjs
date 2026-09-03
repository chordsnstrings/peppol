/**
 * Run every verification suite against one server.
 *
 * They are separate scripts because each is useful alone, but running them
 * ad hoc tends to leave a trail of half-stopped dev servers behind, and each
 * one holds a Prisma connection pool open. Ninety-odd idle connections later,
 * Postgres refuses new ones and the database tests quietly *skip* rather than
 * fail — which looks like a green run. This drives them all from one place and
 * reports what actually ran.
 *
 *   BASE=http://localhost:3000 node scripts/verify-all.mjs
 */
import { spawnSync } from "node:child_process";

const BASE = process.env.BASE ?? "http://localhost:3000";

/*
 * A note for whoever meets this next. The HTTP suites each register a fresh
 * account, and registration is rate limited per address in a fixed window held
 * in the server's own memory. Running the suites two or three times against the
 * same server inside that window gets a 429 on the register call and then a
 * cascade of 401s — which reads as the product being broken and is the limiter
 * doing its job. Restart the server and run again.
 */

const SUITES = [
  { name: "unit + database", cmd: "npx", args: ["vitest", "run"], needsServer: false },
  { name: "ledger invariants", cmd: "node", args: ["scripts/verify-ledger.mjs"], needsServer: false },
  { name: "palette contrast", cmd: "node", args: ["scripts/verify-contrast.mjs"], needsServer: false },
  { name: "ledger HTTP", cmd: "node", args: ["scripts/verify-ledger-api.mjs"], needsServer: true },
  { name: "subledgers HTTP", cmd: "node", args: ["scripts/verify-ledger-ar.mjs"], needsServer: true },
  { name: "browser", cmd: "node", args: ["scripts/verify-ledger-ui.mjs"], needsServer: true },
];

let serverUp = false;
try {
  const res = await fetch(`${BASE}/login`, { signal: AbortSignal.timeout(4000) });
  serverUp = res.ok;
} catch {
  serverUp = false;
}
if (!serverUp) {
  console.log(`\nNo server answering at ${BASE} — running the suites that do not need one.\n`);
}

const results = [];
for (const s of SUITES) {
  if (s.needsServer && !serverUp) {
    results.push({ name: s.name, status: "skipped", detail: "no server" });
    continue;
  }
  console.log(`\n=== ${s.name} ===`);
  const r = spawnSync(s.cmd, s.args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BASE },
    encoding: "utf8",
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const tail = out.trim().split("\n").slice(-6).join("\n");
  console.log(tail);

  // A vitest run that skips its database tests is not a pass. It is what a
  // connection-exhausted database looks like, and it must not read as green.
  const skipped = /(\d+) skipped/.exec(out);
  if (skipped && Number(skipped[1]) > 0) {
    results.push({ name: s.name, status: "failed", detail: `${skipped[1]} tests skipped — is the database reachable?` });
    continue;
  }
  results.push({ name: s.name, status: r.status === 0 ? "passed" : "failed", detail: r.status === 0 ? "" : `exit ${r.status}` });
}

console.log("\n" + "=".repeat(52));
for (const r of results) {
  console.log(`  ${r.status.toUpperCase().padEnd(8)} ${r.name}${r.detail ? " — " + r.detail : ""}`);
}
const failed = results.filter((r) => r.status === "failed");
console.log("=".repeat(52));
console.log(failed.length ? `\n${failed.length} suite(s) failed.\n` : "\nEverything passed.\n");
process.exit(failed.length ? 1 : 0);
