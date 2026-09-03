import { defineConfig } from "vitest/config";
import path from "node:path";
import fs from "node:fs";

/**
 * The ledger tests need a database, and they guard on DATABASE_URL so that a
 * checkout without one still runs the pure tests.
 *
 * That guard used to pass only by accident: nothing here loaded .env, and the
 * variable was set as a side effect of importing the generated Prisma client,
 * which reads .env when it is first imported. A test file that checked the
 * variable before importing Prisma would have skipped its whole suite in
 * silence — and a continuous-integration run without a .env file skipped every
 * ledger test in the product while reporting green.
 *
 * It is loaded here on purpose instead, so the guard means what it says.
 */
function loadEnv() {
  const file = path.resolve(__dirname, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue;
    process.env[key] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv();

/**
 * Cap what one worker may hold open.
 *
 * Prisma's default pool is (cores * 2 + 1) connections per client, every test
 * file constructs its own client alongside the singleton the modules share,
 * and vitest runs a worker per core. On a four-core box that is comfortably
 * more than PostgreSQL's hundred, and the failure it produces is the worst
 * kind: sixty test files at once reporting "too many clients already", every
 * one of which passes on its own. A run like that reads as sixty regressions
 * and is none.
 *
 * Two connections per client is plenty — a test file does one thing at a time
 * — and the wait rather than the refusal is what makes a busy box slow instead
 * of red.
 */
function pooled(url: string | undefined): string | undefined {
  if (!url) return url;
  if (/[?&]connection_limit=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}connection_limit=2&pool_timeout=30`;
}

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Passed explicitly rather than mutated in this process: workers are
    // separate processes, and inheriting an environment by accident is how
    // the .env guard above went wrong in the first place.
    env: { ...(pooled(process.env.DATABASE_URL) ? { DATABASE_URL: pooled(process.env.DATABASE_URL)! } : {}) },
    poolOptions: {
      // Four workers against one database is already the most this is worth
      // running at; the tests are bound by round trips, not by processor.
      threads: { maxThreads: 4, minThreads: 1 },
    },
  },
});
