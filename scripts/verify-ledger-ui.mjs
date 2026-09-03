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

  console.log("\nSUBLEDGER AND REPORT SCREENS");
  // Every accounting screen has to survive having no data at all — an empty
  // state that throws is the first thing a new customer would meet.
  for (const [path, marker] of [
    ["/accounting/receivables", "Receivables"],
    ["/accounting/payables", "Payables"],
    ["/accounting/vat", "VAT return"],
    ["/accounting/statements", "Financial statements"],
    ["/accounting/bank", "Bank reconciliation"],
    ["/accounting/assets", "Fixed assets"],
    ["/accounting/year-end", "Year end"],
    ["/accounting/inventory", "Inventory"],
    ["/accounting/payroll", "Payroll"],
    ["/accounting/corporate-tax", "Corporate tax"],
    ["/accounting/budget", "Budget"],
    ["/accounting/revaluation", "revaluation"],
    ["/accounting/cash-flow", "Cash flow"],
    ["/accounting/expenses", "Expense claims"],
    ["/accounting/recurring", "Recurring"],
    ["/accounting/dimensions", "Cost centre"],
  ]) {
    await page.goto(`${B}${path}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("h1", { timeout: 20000 });
    const heading = await page.locator("h1").first().innerText();
    const crashed = await page.locator("text=Application error").count();
    check(`${path} renders`, heading.toLowerCase().includes(marker.toLowerCase()) && crashed === 0, heading);
  }

  // The statements screen is the one that has to prove an arithmetic claim.
  await page.goto(`${B}/accounting/statements`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="net-profit"]', { timeout: 20000 });
  const netProfit = (await page.locator('[data-testid="net-profit"]').innerText()).trim();
  const liabEq = (await page.locator('[data-testid="total-liab-eq"]').innerText()).trim();
  check("the statements screen shows a net result", netProfit.length > 0, netProfit);
  const bsUnbalanced = await page.locator("text=Out of balance by").count();
  check("the balance sheet balances on screen", bsUnbalanced === 0, `liabilities and equity ${liabEq}`);
  // The capital entry posted earlier in this run falls in the period that is
  // still running. Reading only closed periods would show a zero here, which
  // is how the current month used to vanish from the statements.
  check("and includes the period that has not closed yet", liabEq === "2,500.00", liabEq);
  const bsNote = await page.locator('[data-testid="bs-note"]').innerText();
  check("and explains where this year's result sits", /earned so far this year/.test(bsNote), bsNote.slice(0, 70));

  // The VAT screen must show its reconciliation rather than assert it quietly.
  await page.goto(`${B}/accounting/vat`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Reconciliation to the ledger", { timeout: 20000 });
  const agrees = await page.locator('.sw-chip:has-text("agrees")').count();
  check("the VAT return shows it reconciles to both control accounts", agrees === 2, `${agrees} of 2 agree`);

  // Bank: the import parser is the part a user meets first.
  await page.goto(`${B}/accounting/bank`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="import-statement"]', { timeout: 20000 });
  const importBtn = page.locator('[data-testid="import-statement"]');
  check("import is blocked until there is something to import",
    (await importBtn.getAttribute("aria-disabled")) === "true");

  // Every day in this file is 12 or under, so nothing in it says whether it is
  // day-first or month-first. Guessing would put every line in the wrong month
  // without a word, so it is refused — and the refusal has to point somewhere.
  await page.fill('textarea[aria-label="Bank statement to import"]',
    "Date,Description,Reference,Amount,Balance\n05/02/2026,Opening transfer,FT900,1500.00,1500.00\n07/02/2026,Card fee,,-25.50,1474.50");
  await page.click('[data-testid="import-statement"]');
  await page.waitForTimeout(1500);
  const ambiguous = await page.locator('[role="alert"], .sw-error, .sw-note').allInnerTexts();
  check("an unreadable date order is refused rather than guessed",
    ambiguous.some((t) => /date|order|import screen/i.test(t)),
    (ambiguous[0] ?? "nothing said").slice(0, 90));

  // The same file with a day above 12 settles it, and imports.
  await page.fill('textarea[aria-label="Bank statement to import"]',
    "Date,Description,Reference,Amount,Balance\n05/02/2026,Opening transfer,FT900,1500.00,1500.00\n27/02/2026,Card fee,,-25.50,1474.50");
  await page.click('[data-testid="import-statement"]');
  await page.waitForSelector('[data-testid="bank-result"]', { timeout: 20000 });
  const importNote = (await page.locator("body").innerText()).match(/Read \d+ lines? as \w+ and imported \d+[^.]*/);
  check("a statement whose date order can be settled imports", Boolean(importNote), importNote?.[0]?.slice(0, 90) ?? "no result line");

  const verdict = await page.locator('[data-testid="rec-verdict"]').innerText();
  check("the reconciliation states its position in words", verdict.length > 20, verdict.slice(0, 80));

  // Fixed assets: the form must refuse impossible estimates before the server
  // has to, and say which one is wrong.
  await page.goto(`${B}/accounting/assets`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="run-depreciation"]', { timeout: 20000 });
  await page.click('button:has-text("Add asset")');
  await page.waitForSelector('[data-testid="save-asset"]', { timeout: 10000 });
  let assetBlock = await page.locator('[data-testid="asset-blocker"]').innerText();
  check("the asset form says what is missing", /give the asset a code/i.test(assetBlock), assetBlock);

  const field = (label) => page.locator(`label:has-text("${label}")`).locator("input, select").first();
  await field("Code").fill("FA-UI-1");
  await field("Name").fill("Office fit-out");
  await field("Cost").fill("120000");
  await field("Residual value").fill("500000");
  await page.waitForTimeout(200);
  assetBlock = await page.locator('[data-testid="asset-blocker"]').innerText();
  check("a residual above cost is caught in the form", /cannot exceed the cost/i.test(assetBlock), assetBlock);

  await field("Residual value").fill("0");
  await page.waitForTimeout(200);
  const noBlock = await page.locator('[data-testid="asset-blocker"]').count();
  check("and clears once the estimate is possible", noBlock === 0);

  await page.click('[data-testid="save-asset"]');
  await page.waitForSelector("text=FA-UI-1", { timeout: 20000 });
  ok("the asset reaches the register");

  await page.click('[data-testid="run-depreciation"]');
  await page.waitForSelector('[data-testid="depreciation-result"]', { timeout: 20000 });
  const depResult = await page.locator('[data-testid="depreciation-result"]').innerText();
  check("running depreciation reports what it did", depResult.length > 10, depResult.slice(0, 90));

  // Year end: the screen has to show what closing would do, and refuse while
  // the year is still trading, before anyone can press the button.
  await page.goto(`${B}/accounting/year-end`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="close-year"]', { timeout: 20000 });
  const closeBtn = page.locator('[data-testid="close-year"]');
  check("closing is blocked while the year is still trading",
    (await closeBtn.getAttribute("aria-disabled")) === "true");
  const blockerText = await page.locator('[data-testid="close-blocker"]').first().innerText();
  check("and the reason is on the page, not hidden", /still open/i.test(blockerText), blockerText.slice(0, 80));

  const lockBox = page.locator('[data-testid="lock-periods"]');
  check("locking periods is opt-in, not the default", (await lockBox.isChecked()) === false);

  console.log("\nNAVIGATION");
  await page.goto(`${B}/accounting`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("nav[aria-label='Accounting']", { timeout: 20000 });
  const groups = await page.locator("nav[aria-label='Accounting'] .sw-tab").allInnerTexts();
  check("the nav is grouped rather than one long row", groups.length >= 4 && groups.length <= 8,
    `${groups.length} groups: ${groups.join(", ")}`);

  // Walk every group and check each destination actually resolves. A tab that
  // 404s is worse than no tab, and this is the only way to know.
  const seen = new Set();
  let broken = [];
  for (let g = 0; g < groups.length; g++) {
    await page.locator("nav[aria-label='Accounting'] .sw-tab").nth(g).click();
    await page.waitForTimeout(400);
    const subs = await page.locator("nav[aria-label='Accounting'] .sw-subtab").evaluateAll((els) =>
      els.map((e) => ({ href: e.getAttribute("href"), label: e.textContent })));
    for (const s of subs) {
      if (seen.has(s.href)) continue;
      seen.add(s.href);
      const res = await page.goto(`${B}${s.href}`, { waitUntil: "domcontentloaded" });
      const crashed = await page.locator("text=Application error").count();
      if (!res || res.status() >= 400 || crashed > 0) broken.push(`${s.label} (${s.href})`);
      await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
    }
    await page.goto(`${B}/accounting`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("nav[aria-label='Accounting']", { timeout: 15000 });
  }
  check("every nav destination resolves", broken.length === 0, broken.length ? broken.join("; ") : `${seen.size} screens reached`);

  console.log("\nTHE NEWER SCREENS");
  // Each of these is reachable and, on a fresh entity, empty. An empty screen
  // has to read as "there is nothing here yet" rather than as a failure, and
  // it has to say what the screen is for — which is the whole difference
  // between an empty state and a blank page.
  const screens = [
    ["/accounting/attention", /needs attention|attention/i],
    ["/accounting/customers", /customer/i],
    ["/accounting/sales-orders", /quote|order/i],
    ["/accounting/revenue", /revenue recognition/i],
    ["/accounting/payment-runs", /payment run/i],
    ["/accounting/petty-cash", /petty cash/i],
    ["/accounting/pricing", /price list/i],
    ["/accounting/deliveries", /delivery note/i],
    ["/accounting/subscriptions", /subscription/i],
    ["/accounting/timesheets", /timesheet|work in progress/i],
    ["/accounting/cheques", /cheque/i],
    ["/accounting/vat-schemes", /vat|scheme|capital asset/i],
    ["/accounting/comparatives", /comparative/i],
    ["/accounting/cash-flow-direct", /cash flow/i],
    ["/accounting/credit-control", /credit/i],
    ["/accounting/borrowings", /borrowing|loan/i],
    ["/accounting/numbering", /number/i],
  ];
  for (const [href, heading] of screens) {
    const res = await page.goto(`${B}${href}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(700);
    const crashed = await page.locator("text=Application error").count();
    const h1 = await page.locator("h1").first().innerText().catch(() => "");
    const body = await page.locator("body").innerText();
    check(`${href} renders`, res && res.status() < 400 && crashed === 0 && heading.test(h1 || body),
      crashed ? "application error" : (h1 || "no heading").slice(0, 60));
    check(`${href} explains itself`, body.length > 200 && !/undefined|NaN|\[object Object\]/.test(body),
      /undefined|NaN|\[object Object\]/.test(body) ? "leaked a placeholder into the page" : `${body.length} characters`);
  }

  // Every one of them has to be operable without a mouse. A screen whose only
  // control cannot be tabbed to is a screen a screen-reader user cannot use.
  await page.goto(`${B}/accounting/revenue`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("h1", { timeout: 15000 });
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const s = getComputedStyle(el);
    return { tag: el.tagName, outline: s.outlineStyle, shadow: s.boxShadow };
  });
  check("tabbing reaches a control with a visible focus ring", !!focused &&
    (focused.outline !== "none" || (focused.shadow && focused.shadow !== "none")),
    focused ? `${focused.tag} outline=${focused.outline}` : "nothing took focus");

  console.log("\nACCESSIBLE NAMES");
  // Every control a person can type into has to be announced as something. A
  // form field with no accessible name is read out as "edit text" and nothing
  // else, which on a screen full of amounts is indistinguishable from every
  // other field on it. Checked in the browser rather than by grepping, because
  // a name can come from four different places and only the browser resolves
  // all of them.
  const unnamed = [];
  for (const href of [...seen]) {
    await page.goto(`${B}${href}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    const bad = await page.evaluate(() => {
      const named = (el) => {
        if (el.getAttribute("aria-label")?.trim()) return true;
        const by = el.getAttribute("aria-labelledby");
        if (by && by.split(/\s+/).some((id) => document.getElementById(id)?.textContent?.trim())) return true;
        if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return true;
        if (el.closest("label")?.textContent?.trim()) return true;
        if (el.getAttribute("title")?.trim()) return true;
        // A checkbox inside a table cell whose row header names it is a
        // judgement call; everything else is not.
        return false;
      };
      return [...document.querySelectorAll("input:not([type=hidden]), select, textarea")]
        .filter((el) => !named(el))
        .map((el) => `${el.tagName.toLowerCase()}${el.type ? `[${el.type}]` : ""}${el.placeholder ? ` "${el.placeholder}"` : ""}`);
    });
    if (bad.length) unnamed.push(`${href}: ${bad.slice(0, 3).join(", ")}`);
  }
  check("every form control has an accessible name", unnamed.length === 0,
    unnamed.length ? unnamed.slice(0, 4).join(" | ") : `${seen.size} screens checked`);

  console.log("\nFIGURES");
  // Two rules the whole ledger typography rests on, checked on real rendered
  // pages rather than asserted in a stylesheet nobody re-reads:
  //
  //   a figure is right-aligned and set in tabular figures, so a column of
  //   amounts lines up digit under digit and the eye can compare them;
  //
  //   a negative is written in parentheses, never with a minus sign. A minus
  //   is a hyphen at small sizes and disappears; parentheses cannot be missed
  //   and are what every set of accounts has used for a century.
  const misaligned = [];
  const minuses = [];
  for (const href of [...seen]) {
    await page.goto(`${B}${href}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(400);
    const found = await page.evaluate(() => {
      const cells = [...document.querySelectorAll("td.sw-num, th.sw-num")];
      const wrong = [];
      const signed = [];
      for (const c of cells) {
        const s = getComputedStyle(c);
        const align = s.textAlign;
        const figures = s.fontVariantNumeric || "";
        if (align !== "right" && align !== "end") wrong.push(`align=${align}`);
        else if (!/tabular-nums/.test(figures)) wrong.push(`figures=${figures || "none"}`);
        const text = (c.textContent ?? "").trim();
        // An en dash is the statement convention for a nil, not a minus.
        if (/^-\s*[\d(]/.test(text) || /[\d)]\s*-$/.test(text)) signed.push(text.slice(0, 24));
      }
      return { wrong: wrong.slice(0, 3), signed: signed.slice(0, 3), count: cells.length };
    });
    if (found.wrong.length) misaligned.push(`${href}: ${found.wrong.join(", ")}`);
    if (found.signed.length) minuses.push(`${href}: ${found.signed.join(", ")}`);
  }
  check("every figure is right-aligned in tabular numerals", misaligned.length === 0,
    misaligned.length ? misaligned.slice(0, 3).join(" | ") : `${seen.size} screens checked`);
  check("a negative is written in parentheses, never with a minus sign", minuses.length === 0,
    minuses.length ? minuses.slice(0, 3).join(" | ") : "no minus signs on any figure");

  console.log("\nRESPONSIVE AND CONSOLE");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${B}/accounting/trial-balance`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("table", { timeout: 15000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no horizontal page scroll on a phone", overflow <= 1, `${overflow}px overflow`);

  // Two answers are expected rather than faults, and the browser logs both as
  // errors: the onboarding page probes /api/auth/me before anyone is signed
  // in, and the checks above deliberately hand the importer a file it cannot
  // read. A 422 is the product saying no and explaining why — which the page
  // then shows — so counting it as a defect would mean the only way to pass
  // this check is never to refuse anything.
  const realErrors = consoleErrors.filter((e) => !/status of (401|422)/.test(e));
  check("no console errors during the whole flow", realErrors.length === 0, realErrors.slice(0, 3).join(" | ") || `(${consoleErrors.length} expected pre-auth 401s ignored)`);
} catch (e) {
  bad("run", e.message);
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
