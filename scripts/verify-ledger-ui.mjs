/**
 * Browser test of the accounting UI against a real server and a real ledger.
 * Registers a fresh org, opens the books through the UI, keys a journal entry
 * in the grid, and follows the money through to the trial balance.
 */
import pw from "/opt/node22/lib/node_modules/playwright/index.js";
const { chromium } = pw;

const B = process.env.BASE ?? "http://localhost:3000";
let pass = 0, fail = 0;
const ok = (n, x = "") => { pass++; console.log(`  PASS  ${n}${x ? " — " + x : ""}`); };
const bad = (n, e) => { fail++; console.log(`  FAIL  ${n} — ${e}`); };
const check = (n, cond, x = "") => (cond ? ok(n, x) : bad(n, x || "assertion failed"));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

try {
  const email = `ui${Date.now()}@test.ae`;

  console.log("\nSIGN UP AND ONBOARD");
  // The real onboarding wizard, not a shortcut — it is the only path that
  // creates the org, the user and the first entity together.
  await page.goto(`${B}/onboarding`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[placeholder="Ahmed Al Marri"]', { timeout: 20000 });
  await page.fill('input[placeholder="Ahmed Al Marri"]', "Grid Tester");
  await page.fill("input[type=email]", email);
  await page.fill("input[type=password]", "test-password-123");
  await page.fill('input[placeholder="Marri Trading LLC"]', "Grid Test LLC");

  const advance = async () => {
    for (const [ph, val] of [
      ["Marri Trading LLC", "Grid Test LLC"],
      ["100 1234 5678 9003", "100000000000003"],
    ]) {
      const f = page.locator(`input[placeholder="${ph}"]`).first();
      if ((await f.count()) && !(await f.inputValue())) await f.fill(val);
    }
    const cont = page.locator('button:has-text("Continue")').first();
    if ((await cont.count()) && (await cont.isEnabled())) await cont.click();
    else await page.locator('button:has-text("Create workspace")').first().click();
    await page.waitForTimeout(900);
  };
  for (let i = 0; i < 8 && !/\/dashboard/.test(page.url()); i++) await advance();
  await page.waitForURL(/\/dashboard/, { timeout: 25000 });
  ok("registered and onboarded through the real wizard");

  console.log("\nOPEN THE BOOKS");
  await page.goto(`${B}/accounting`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=The books are not open yet", { timeout: 20000 });
  ok("empty state explains what opening the books does");
  await page.click('button:has-text("Open the books")');
  // Wait for the button to go, not for the words "Trial balance" — those are
  // also the nav tab, which is on screen the whole time.
  await page.waitForSelector('button:has-text("Open the books")', { state: "detached", timeout: 60000 });
  await page.waitForSelector('a:has-text("Open the full trial balance")', { timeout: 30000 });
  ok("books opened, overview shows the trial balance");

  console.log("\nCHART OF ACCOUNTS");
  await page.goto(`${B}/accounting/accounts`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("table", { timeout: 15000 });
  const rowCount = await page.locator("table tbody tr").count();
  check("chart is populated", rowCount > 50, `${rowCount} accounts`);
  const ar = await page.locator('td[dir="rtl"]').first().innerText();
  check("chart carries Arabic names", /[؀-ۿ]/.test(ar), ar);
  const controlChip = await page.locator('.sw-chip:has-text("control")').count();
  check("control accounts are marked", controlChip > 0, `${controlChip} marked`);

  await page.fill("#acct-search", "receiv");
  await page.waitForTimeout(200);
  const filtered = await page.locator("table tbody tr").count();
  check("one field searches both code and name", filtered > 0 && filtered < rowCount, `${filtered} of ${rowCount}`);

  console.log("\nJOURNAL ENTRY GRID");
  await page.goto(`${B}/accounting/journals/new`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="post-entry"]', { timeout: 15000 });

  let blocker = await page.locator('[data-testid="blocker"]').innerText();
  check("empty grid says exactly what is missing", /at least two lines/i.test(blocker), blocker);
  const ariaDisabled = await page.locator('[data-testid="post-entry"]').getAttribute("aria-disabled");
  check("blocked Post is aria-disabled, not silently dead", ariaDisabled === "true");

  // Line 1: debit cash. Typed as arithmetic to prove the expression parser.
  await page.locator('input[aria-label="Line 1 account"]').fill("1010");
  await page.locator('input[aria-label="Line 1 debit"]').fill("2000+500");
  await page.locator('input[aria-label="Line 1 debit"]').blur();
  await page.waitForTimeout(150);
  const debit1 = await page.locator('input[aria-label="Line 1 debit"]').inputValue();
  check("amount cell evaluates arithmetic", debit1 === "2500.00", debit1);

  blocker = await page.locator('[data-testid="blocker"]').innerText();
  check("out-of-balance message names the short side", /credits are short by 2,500\.00/i.test(blocker), blocker);

  const diffCredit = await page.locator('[data-testid="diff-credit"]').innerText();
  const diffDebit = await page.locator('[data-testid="diff-debit"]').innerText();
  check("difference sits under the column it is missing from", diffCredit.trim() === "2,500.00" && diffDebit.trim() === "", `debit:"${diffDebit}" credit:"${diffCredit}"`);

  const suggestion = await page.locator('input[aria-label="Line 2 credit"]').getAttribute("placeholder");
  check("next empty line offers the balancing figure", suggestion === "2500.00", String(suggestion));

  // Line 2: a minus typed into Debit should move itself to Credit.
  await page.locator('input[aria-label="Line 2 account"]').fill("3000");
  await page.locator('input[aria-label="Line 2 debit"]').fill("-2500");
  await page.locator('input[aria-label="Line 2 debit"]').blur();
  await page.waitForTimeout(150);
  const l2debit = await page.locator('input[aria-label="Line 2 debit"]').inputValue();
  const l2credit = await page.locator('input[aria-label="Line 2 credit"]').inputValue();
  check("a minus in Debit moves itself to Credit", l2debit === "" && l2credit === "2500.00", `debit:"${l2debit}" credit:"${l2credit}"`);

  const noBlocker = await page.locator('[data-testid="blocker"]').count();
  check("balanced entry clears the blocker", noBlocker === 0);

  await page.fill("#je-memo", "Owner capital introduced");
  await page.click('[data-testid="post-entry"]');
  await page.waitForURL(/\/accounting\/journals\?posted=/, { timeout: 20000 });
  ok("entry posted", new URL(page.url()).search);

  console.log("\nREGISTER AND DRILL-DOWN");
  await page.waitForSelector("text=Owner capital introduced", { timeout: 15000 });
  ok("posted entry appears in the register");
  await page.locator('button[aria-label^="Expand"]').first().click();
  await page.waitForTimeout(200);
  const expandedText = await page.locator("table").innerText();
  check("expanding shows both sides of the entry", /1010/.test(expandedText) && /3000/.test(expandedText));

  await page.goto(`${B}/accounting/accounts/1010`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="gl-closing"]', { timeout: 15000 });
  const closing = await page.locator('[data-testid="gl-closing"]').innerText();
  check("drill-down running balance is right", closing.trim() === "2,500.00", closing);

  console.log("\nTRIAL BALANCE");
  await page.goto(`${B}/accounting/trial-balance`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="tb-debit"]', { timeout: 15000 });
  const tbD = (await page.locator('[data-testid="tb-debit"]').innerText()).trim();
  const tbC = (await page.locator('[data-testid="tb-credit"]').innerText()).trim();
  check("trial balance ties", tbD === "2,500.00" && tbC === "2,500.00", `dr ${tbD} / cr ${tbC}`);
  const outOfBalance = await page.locator("text=Out of balance").count();
  check("no out-of-balance row when it ties", outOfBalance === 0);

  console.log("\nPERIOD CLOSE");
  await page.goto(`${B}/accounting/periods`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("table", { timeout: 15000 });
  const periodRows = await page.locator("table tbody tr").count();
  check("a fiscal year of periods exists", periodRows === 13, `${periodRows} periods (12 + adjustment)`);
  await page.locator('tr:has-text("2026-01") button:has-text("Soft close")').first().click();
  await page.waitForSelector('tr:has-text("2026-01") .sw-chip:has-text("soft closed")', { timeout: 15000 });
  ok("period soft-closes");
  await page.locator('tr:has-text("2026-01") button:has-text("Hard close")').first().click();
  await page.waitForSelector('tr:has-text("2026-01") .sw-chip:has-text("hard closed")', { timeout: 15000 });
  ok("period hard-closes");

  // A closed period must refuse a posting — from the UI, before the request.
  await page.goto(`${B}/accounting/journals/new`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#je-date", { timeout: 15000 });
  await page.fill("#je-date", "2026-01-20");
  await page.locator('input[aria-label="Line 1 account"]').fill("1010");
  await page.locator('input[aria-label="Line 1 debit"]').fill("100");
  await page.locator('input[aria-label="Line 2 account"]').fill("3000");
  await page.locator('input[aria-label="Line 2 credit"]').fill("100");
  await page.locator('input[aria-label="Line 2 credit"]').blur();
  await page.waitForTimeout(200);
  blocker = await page.locator('[data-testid="blocker"]').innerText();
  check("a closed period blocks posting with the reason", /hard closed/i.test(blocker), blocker);

  // A control account must be refused too.
  await page.fill("#je-date", "2026-02-10");
  await page.locator('input[aria-label="Line 1 account"]').fill("1100");
  await page.locator('input[aria-label="Line 1 account"]').blur();
  await page.waitForTimeout(200);
  blocker = await page.locator('[data-testid="blocker"]').innerText();
  check("a control account is refused with an explanation", /control account/i.test(blocker), blocker);

  console.log("\nSPREADSHEET PASTE AND ACCESSIBILITY");
  await page.goto(`${B}/accounting/journals/new`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="post-entry"]', { timeout: 15000 });

  // The live region must exist before it has anything to say — a role="status"
  // injected together with its text announces nothing in most screen readers.
  const liveAtRest = await page.locator('[role="status"][aria-live="polite"][aria-atomic="true"]').count();
  check("balance live region is mounted before it has content", liveAtRest === 1, `${liveAtRest} found`);

  // WCAG 2.2 SC 2.5.8: a pointer target is at least 24x24 CSS px.
  const removeBox = await page.locator('button[aria-label="Remove line 1"]').boundingBox();
  check("row action button meets the 24px target size", removeBox.width >= 24 && removeBox.height >= 24,
    `${Math.round(removeBox.width)}x${Math.round(removeBox.height)}`);
  const cellBox = await page.locator('input[aria-label="Line 1 debit"]').boundingBox();
  check("an editable row clears the target-size floor", cellBox.height >= 24, `${Math.round(cellBox.height)}px`);

  // Paste a three-line accrual the way it arrives from a spreadsheet: TSV,
  // with thousands separators and a parenthesised negative.
  const tsv = "1010\tBank transfer\t1,200.00\t\n5000\tRent\t800\t\n1010\tRefund\t(2,000.00)\t";
  await page.locator('input[aria-label="Line 1 account"]').focus();
  await page.evaluate((text) => {
    const el = document.activeElement;
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, tsv);
  await page.waitForTimeout(400);

  const note = await page.locator('[data-testid="paste-note"]').innerText();
  check("a paste is announced, never posted silently", /Pasted 3 rows/.test(note), note.split("\n")[0]);

  const pastedAcct = await page.locator('input[aria-label="Line 2 account"]').inputValue();
  const pastedMemo = await page.locator('input[aria-label="Line 2 description"]').inputValue();
  const pastedAmt = await page.locator('input[aria-label="Line 2 debit"]').inputValue();
  check("pasted cells land in the right columns", pastedAcct === "5000" && pastedMemo === "Rent" && pastedAmt === "800.00",
    `${pastedAcct} / ${pastedMemo} / ${pastedAmt}`);

  const l1 = await page.locator('input[aria-label="Line 1 debit"]').inputValue();
  check("thousands separators survive the paste", l1 === "1200.00", l1);

  // "(2,000.00)" in a Debit column is a credit, same as typing a minus.
  const l3d = await page.locator('input[aria-label="Line 3 debit"]').inputValue();
  const l3c = await page.locator('input[aria-label="Line 3 credit"]').inputValue();
  check("a parenthesised negative moves to the credit column", l3d === "" && l3c === "2000.00", `debit:"${l3d}" credit:"${l3c}"`);

  const totalD = await page.locator('[data-testid="total-debit"]').innerText();
  const totalC = await page.locator('[data-testid="total-credit"]').innerText();
  check("a pasted block that balances shows as balanced", totalD.trim() === "2,000.00" && totalC.trim() === "2,000.00",
    `dr ${totalD.trim()} / cr ${totalC.trim()}`);

  // The live region should have caught up by now and speak a sentence.
  await page.waitForTimeout(900);
  const spoken = await page.locator('[role="status"][aria-live="polite"]').innerText();
  check("the live region speaks a sentence, not a bare number", /Balanced at 2,000\.00/.test(spoken), spoken);

  console.log("\nRESPONSIVE AND CONSOLE");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${B}/accounting/trial-balance`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("table", { timeout: 15000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no horizontal page scroll on a phone", overflow <= 1, `${overflow}px overflow`);

  // The onboarding page probes /api/auth/me before anyone is signed in; that
  // 401 is the expected answer, not a fault.
  const realErrors = consoleErrors.filter((e) => !/status of 401/.test(e));
  check("no console errors during the whole flow", realErrors.length === 0, realErrors.slice(0, 3).join(" | ") || `(${consoleErrors.length} expected pre-auth 401s ignored)`);
} catch (e) {
  bad("run", e.message);
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
