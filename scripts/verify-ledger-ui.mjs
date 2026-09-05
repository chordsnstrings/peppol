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

/**
 * Type into a React-controlled input.
 *
 * `page.fill()` sets the DOM value and dispatches an `input` event, which is
 * usually enough — but React keeps a `_valueTracker` on the node and drops the
 * event when the tracker already holds the new value. Setting through the
 * prototype's own setter updates the tracker first, so React sees the change.
 *
 * The symptom when this goes wrong is the worst kind: every field on screen
 * holds the right value, the form looks filled in, and the Continue button
 * stays disabled — because the component's state was never told. That is
 * indistinguishable from a product defect until somebody reads the tracker.
 */
/**
 * Wait until React has hydrated the page.
 *
 * `domcontentloaded` means the markup is there, not that anything is listening
 * to it. A value set before hydration lands on inert DOM: the field shows the
 * text, the component's state never hears about it, and the form sits there
 * looking filled in with its Continue button disabled — which reads exactly
 * like a broken product and is not one.
 *
 * React marks every node it has attached to with a `__reactFiber$…` key, so
 * that is the signal rather than a sleep somebody will have to lengthen later.
 */
async function hydrated(selector) {
  // Generous, because a dev server compiles a route on its first hit and can
  // take several seconds before the page even exists. Against the production
  // build this suite is written for, it returns immediately.
  await page.waitForSelector(selector, { timeout: 60000 });
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactFiber$"));
    },
    selector,
    { timeout: 60000 },
  );
}

/**
 * Navigate, tolerating a client-side navigation already in flight.
 *
 * The app routes on its own after onboarding and after opening the books, and a
 * `goto` issued into the middle of one is aborted by it — `net::ERR_ABORTED`,
 * which reads as the server refusing the page and is nothing of the kind. One
 * retry after the in-flight navigation lands is enough; a second failure is a
 * real one and is allowed to throw.
 */
/**
 * The blocker once the grid has finished resolving.
 *
 * "Every line with an amount needs an account" is what it says for the moment
 * between leaving a cell and the code being matched against the chart. Reading
 * it then and reporting it is how a suite turns a race into a defect, so this
 * waits for that message to give way to whatever the real answer is.
 */
async function settledBlocker() {
  const el = page.locator('[data-testid="blocker"]');
  // Patient on purpose. This suite is meant to run against a production build,
  // where the chart and the periods arrive in a few hundred milliseconds; a dev
  // server compiling a route on first hit can take several seconds, and a check
  // that gives up first reports the load as the answer.
  for (let i = 0; i < 100; i++) {
    if ((await el.count()) === 0) return "";
    const text = (await el.innerText().catch(() => "")).trim();
    // Both of these are what the grid says while it is still loading: the chart
    // it resolves account codes against, and the periods it checks the date
    // against. Reading either one and reporting it is how a suite turns a load
    // into a defect.
    if (text && !/needs an account|no accounting period covering/.test(text)) return text;
    await page.waitForTimeout(120);
  }
  return (await el.innerText().catch(() => "")).trim();
}

async function go(url) {
  try {
    return await page.goto(url, { waitUntil: "domcontentloaded" });
  } catch (e) {
    if (!/ERR_ABORTED/.test(String(e))) throw e;
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    return await page.goto(url, { waitUntil: "domcontentloaded" });
  }
}

async function fill(sel, value) {
  const loc = typeof sel === "string" ? page.locator(sel).first() : sel;
  await loc.focus();
  await loc.evaluate((el, v) => {
    const proto = el instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  // And then leave the cell, because that is what a person does and because
  // several controls here commit on blur rather than on every keystroke — the
  // amount cells evaluate their arithmetic there, and a minus typed in Debit
  // moves itself to Credit there. Filling without leaving tests half of it.
  await loc.blur();
}

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
  await go(`${B}/onboarding`);
  await hydrated('input[placeholder="Ahmed Al Marri"]');
  await fill('input[placeholder="Ahmed Al Marri"]', "Grid Tester");
  await fill("input[type=email]", email);
  await fill("input[type=password]", "test-password-123");
  await fill('input[placeholder="Marri Trading LLC"]', "Grid Test LLC");

  const advance = async () => {
    for (const [ph, val] of [
      ["Marri Trading LLC", "Grid Test LLC"],
      ["100 1234 5678 9003", "100000000000003"],
    ]) {
      const f = page.locator(`input[placeholder="${ph}"]`).first();
      if ((await f.count()) && !(await f.inputValue())) await fill(f, val);
    }
    // The last step's button says "Create workspace" and navigates. Both are
    // checked for existence before being clicked: clicking a button that is not
    // there waits thirty seconds and then reports a timeout, which says nothing
    // about which step the wizard was actually on.
    const cont = page.locator('button:has-text("Continue")').first();
    if ((await cont.count()) && (await cont.isEnabled())) {
      await cont.click();
      await page.waitForTimeout(700);
      return true;
    }
    const create = page.locator('button:has-text("Create workspace")').first();
    if ((await create.count()) && (await create.isEnabled())) {
      await create.click();
      await page.waitForURL(/\/dashboard/, { timeout: 30000 });
      return true;
    }
    return false;
  };
  for (let i = 0; i < 8 && !/\/dashboard/.test(page.url()); i++) {
    if (!(await advance())) break;
  }
  await page.waitForURL(/\/dashboard/, { timeout: 25000 });
  // The dashboard does its own client-side work on arrival, and a goto issued
  // into the middle of that is aborted by it. Waiting for the page to settle is
  // not a sleep for luck: it is waiting for the navigation that has already
  // started to finish before starting another.
  await page.waitForLoadState("domcontentloaded");
  await hydrated("body");
  ok("registered and onboarded through the real wizard");

  console.log("\nOPEN THE BOOKS");
  await go(`${B}/accounting`);
  await page.waitForSelector("text=The books are not open yet", { timeout: 20000 });
  ok("empty state explains what opening the books does");
  await page.click('button:has-text("Open the books")');
  // Wait for the button to go, not for the words "Trial balance" — those are
  // also the nav tab, which is on screen the whole time.
  await page.waitForSelector('button:has-text("Open the books")', { state: "detached", timeout: 60000 });
  await page.waitForSelector('a:has-text("Open the full trial balance")', { timeout: 30000 });
  ok("books opened, overview shows the trial balance");

  console.log("\nCHART OF ACCOUNTS");
  await go(`${B}/accounting/accounts`);
  await page.waitForSelector("table", { timeout: 15000 });
  const rowCount = await page.locator("table tbody tr").count();
  check("chart is populated", rowCount > 50, `${rowCount} accounts`);
  const ar = await page.locator('td[dir="rtl"]').first().innerText();
  check("chart carries Arabic names", /[؀-ۿ]/.test(ar), ar);
  const controlChip = await page.locator('.sw-chip:has-text("control")').count();
  check("control accounts are marked", controlChip > 0, `${controlChip} marked`);

  await fill("#acct-search", "receiv");
  await page.waitForTimeout(200);
  const filtered = await page.locator("table tbody tr").count();
  check("one field searches both code and name", filtered > 0 && filtered < rowCount, `${filtered} of ${rowCount}`);

  console.log("\nJOURNAL ENTRY GRID");
  await go(`${B}/accounting/journals/new`);
  await page.waitForSelector('[data-testid="post-entry"]', { timeout: 15000 });

  let blocker = await page.locator('[data-testid="blocker"]').innerText();
  check("empty grid says exactly what is missing", /at least two lines/i.test(blocker), blocker);
  const ariaDisabled = await page.locator('[data-testid="post-entry"]').getAttribute("aria-disabled");
  check("blocked Post is aria-disabled, not silently dead", ariaDisabled === "true");

  // Line 1: debit cash. Typed as arithmetic to prove the expression parser.
  await fill(page.locator('input[aria-label="Line 1 account"]'), "1010");
  await fill(page.locator('input[aria-label="Line 1 debit"]'), "2000+500");
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
  await fill(page.locator('input[aria-label="Line 2 account"]'), "3000");
  await fill(page.locator('input[aria-label="Line 2 debit"]'), "-2500");
  await page.locator('input[aria-label="Line 2 debit"]').blur();
  await page.waitForTimeout(150);
  const l2debit = await page.locator('input[aria-label="Line 2 debit"]').inputValue();
  const l2credit = await page.locator('input[aria-label="Line 2 credit"]').inputValue();
  check("a minus in Debit moves itself to Credit", l2debit === "" && l2credit === "2500.00", `debit:"${l2debit}" credit:"${l2credit}"`);

  // The grid resolves an account code against the chart it has loaded, so the
  // blocker clears a beat after the cell is left rather than in the same tick.
  // Waiting for it is what a person does; sampling once at a fixed delay is how
  // a suite reports a race as a defect.
  await page.waitForSelector("text=ready to post", { timeout: 5000 }).catch(() => {});
  const gridBlocker = await page.locator('[data-testid="blocker"]').innerText().catch(() => "");
  // Not just gone — replaced by the sentence that says it is ready. A blocker
  // that disappears while the button stays dead is the failure this pair of
  // checks exists to tell apart.
  const readyText = await page.locator("text=ready to post").count();
  check("balanced entry clears the blocker", gridBlocker === "" && readyText > 0,
    gridBlocker ? `still blocked: ${gridBlocker}` : "no 'ready to post' line");

  await fill("#je-memo", "Owner capital introduced");
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

  await go(`${B}/accounting/accounts/1010`);
  await page.waitForSelector('[data-testid="gl-closing"]', { timeout: 15000 });
  const closing = await page.locator('[data-testid="gl-closing"]').innerText();
  check("drill-down running balance is right", closing.trim() === "2,500.00", closing);

  console.log("\nTRIAL BALANCE");
  await go(`${B}/accounting/trial-balance`);
  await page.waitForSelector('[data-testid="tb-debit"]', { timeout: 15000 });
  const tbD = (await page.locator('[data-testid="tb-debit"]').innerText()).trim();
  const tbC = (await page.locator('[data-testid="tb-credit"]').innerText()).trim();
  check("trial balance ties", tbD === "2,500.00" && tbC === "2,500.00", `dr ${tbD} / cr ${tbC}`);
  const outOfBalance = await page.locator("text=Out of balance").count();
  check("no out-of-balance row when it ties", outOfBalance === 0);

  console.log("\nPERIOD CLOSE");
  await go(`${B}/accounting/periods`);
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
  await go(`${B}/accounting/journals/new`);
  await page.waitForSelector("#je-date", { timeout: 15000 });
  await fill("#je-date", "2026-01-20");
  await fill(page.locator('input[aria-label="Line 1 account"]'), "1010");
  await fill(page.locator('input[aria-label="Line 1 debit"]'), "100");
  await fill(page.locator('input[aria-label="Line 2 account"]'), "3000");
  await fill(page.locator('input[aria-label="Line 2 credit"]'), "100");
  await page.locator('input[aria-label="Line 2 credit"]').blur();
  blocker = await settledBlocker();
  check("a closed period blocks posting with the reason", /hard closed/i.test(blocker), blocker);

  // A control account must be refused too.
  await fill("#je-date", "2026-02-10");
  await fill(page.locator('input[aria-label="Line 1 account"]'), "1100");
  await page.locator('input[aria-label="Line 1 account"]').blur();
  blocker = await settledBlocker();
  check("a control account is refused with an explanation", /control account/i.test(blocker), blocker);

  console.log("\nSPREADSHEET PASTE AND ACCESSIBILITY");
  await go(`${B}/accounting/journals/new`);
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

  // The live region is debounced on purpose — a screen reader announcing every
  // keystroke is unusable — so this waits for it to catch up rather than
  // sampling at a delay somebody will have to lengthen later.
  await page.waitForFunction(
    () => /Balanced at/.test(document.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? ""),
    undefined,
    { timeout: 8000 },
  ).catch(() => {});
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
    await go(`${B}${path}`);
    await page.waitForSelector("h1", { timeout: 20000 });
    const heading = await page.locator("h1").first().innerText();
    const crashed = await page.locator("text=Application error").count();
    check(`${path} renders`, heading.toLowerCase().includes(marker.toLowerCase()) && crashed === 0, heading);
  }

  // The statements screen is the one that has to prove an arithmetic claim.
  await go(`${B}/accounting/statements`);
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
  await go(`${B}/accounting/vat`);
  await page.waitForSelector("text=Reconciliation to the ledger", { timeout: 20000 });
  const agrees = await page.locator('.sw-chip:has-text("agrees")').count();
  check("the VAT return shows it reconciles to both control accounts", agrees === 2, `${agrees} of 2 agree`);

  // Bank: the import parser is the part a user meets first.
  await go(`${B}/accounting/bank`);
  await page.waitForSelector('[data-testid="import-statement"]', { timeout: 20000 });
  const importBtn = page.locator('[data-testid="import-statement"]');
  check("import is blocked until there is something to import",
    (await importBtn.getAttribute("aria-disabled")) === "true");

  // Every day in this file is 12 or under, so nothing in it says whether it is
  // day-first or month-first. Guessing would put every line in the wrong month
  // without a word, so it is refused — and the refusal has to point somewhere.
  await fill('textarea[aria-label="Bank statement to import"]',
    "Date,Description,Reference,Amount,Balance\n05/02/2026,Opening transfer,FT900,1500.00,1500.00\n07/02/2026,Card fee,,-25.50,1474.50");
  await page.click('[data-testid="import-statement"]');
  // Wait for the refusal rather than sleeping for it. The page carries notes of
  // its own — the reconciliation says "Nothing. Every line the bank reported is
  // accounted for." whatever happens here — so a sample taken too early reads
  // one of those and reports the refusal as missing.
  // A NON-EMPTY alert. The page carries an empty live region for announcements,
  // so waiting for the selector alone returns instantly and samples the screen
  // before the refusal has arrived.
  await page.waitForFunction(
    () => [...document.querySelectorAll('[role="alert"]')].some((e) => (e.textContent ?? "").trim().length > 0),
    undefined,
    { timeout: 20000 },
  ).catch(() => {});
  const ambiguous = await page.locator('[role="alert"], .sw-error, .sw-note').allInnerTexts();
  check("an unreadable date order is refused rather than guessed",
    ambiguous.some((t) => /day-first|month-first|date order|import screen/i.test(t)),
    // Say what WAS on screen, not just the first note on the page — the whole
    // point of this check is which sentence the user got.
    (ambiguous.find((t) => /refus|could|cannot/i.test(t)) ?? ambiguous[0] ?? "nothing said").slice(0, 120));

  // The same file with a day above 12 settles it, and imports.
  await fill('textarea[aria-label="Bank statement to import"]',
    "Date,Description,Reference,Amount,Balance\n05/02/2026,Opening transfer,FT900,1500.00,1500.00\n27/02/2026,Card fee,,-25.50,1474.50");
  await page.click('[data-testid="import-statement"]');
  await page.waitForSelector('[data-testid="bank-result"]', { timeout: 20000 });
  const importNote = (await page.locator("body").innerText()).match(/Read \d+ lines? as \w+ and imported \d+[^.]*/);
  check("a statement whose date order can be settled imports", Boolean(importNote), importNote?.[0]?.slice(0, 90) ?? "no result line");

  const verdict = await page.locator('[data-testid="rec-verdict"]').innerText();
  check("the reconciliation states its position in words", verdict.length > 20, verdict.slice(0, 80));

  // Fixed assets: the form must refuse impossible estimates before the server
  // has to, and say which one is wrong.
  await go(`${B}/accounting/assets`);
  await page.waitForSelector('[data-testid="run-depreciation"]', { timeout: 20000 });
  await page.click('button:has-text("Add asset")');
  await page.waitForSelector('[data-testid="save-asset"]', { timeout: 10000 });
  let assetBlock = await page.locator('[data-testid="asset-blocker"]').innerText();
  check("the asset form says what is missing", /give the asset a code/i.test(assetBlock), assetBlock);

  const field = (label) => page.locator(`label:has-text("${label}")`).locator("input, select").first();
  await fill(field("Code"), "FA-UI-1");
  await fill(field("Name"), "Office fit-out");
  await fill(field("Cost"), "120000");
  await fill(field("Residual value"), "500000");
  await page.waitForTimeout(200);
  assetBlock = await page.locator('[data-testid="asset-blocker"]').innerText();
  check("a residual above cost is caught in the form", /cannot exceed the cost/i.test(assetBlock), assetBlock);

  await fill(field("Residual value"), "0");
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
  await go(`${B}/accounting/year-end`);
  await page.waitForSelector('[data-testid="close-year"]', { timeout: 20000 });
  const closeBtn = page.locator('[data-testid="close-year"]');
  check("closing is blocked while the year is still trading",
    (await closeBtn.getAttribute("aria-disabled")) === "true");
  const blockerText = await page.locator('[data-testid="close-blocker"]').first().innerText();
  check("and the reason is on the page, not hidden", /still open/i.test(blockerText), blockerText.slice(0, 80));

  const lockBox = page.locator('[data-testid="lock-periods"]');
  check("locking periods is opt-in, not the default", (await lockBox.isChecked()) === false);

  console.log("\nNAVIGATION");
  await go(`${B}/accounting`);
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
      const res = await go(`${B}${s.href}`);
      const crashed = await page.locator("text=Application error").count();
      if (!res || res.status() >= 400 || crashed > 0) broken.push(`${s.label} (${s.href})`);
      await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
    }
    await go(`${B}/accounting`);
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
    ["/accounting/related-parties", /related part/i],
    ["/accounting/notifications", /notification/i],
    ["/accounting/trade-finance", /trade finance|letter of credit/i],
    ["/accounting/landed-cost", /landed cost/i],
  ];
  for (const [href, heading] of screens) {
    const res = await go(`${B}${href}`);
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
  await go(`${B}/accounting/revenue`);
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
    await go(`${B}${href}`);
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
    await go(`${B}${href}`);
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
  await go(`${B}/accounting/trial-balance`);
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
