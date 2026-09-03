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

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
