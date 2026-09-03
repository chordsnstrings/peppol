/**
 * The receivables subledger over HTTP: raise a real invoice through the
 * document store, post it, receive against it, and check that the ageing, the
 * control account and the trial balance all agree.
 */
const B = process.env.BASE ?? 'http://localhost:3000';
let cookie = '';
let pass = 0, fail = 0;
const ok = (n, x = '') => { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); };
const bad = (n, e) => { fail++; console.log(`  FAIL  ${n} — ${e}`); };
const check = (n, c, x = '') => (c ? ok(n, x) : bad(n, x || 'assertion failed'));

async function call(method, path, body) {
  const r = await fetch(B + path, {
    method,
    headers: { 'content-type': 'application/json', origin: B, ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}

const email = `ar${Date.now()}@test.ae`;
const ENT = 'ent-ar-' + Date.now();
let r = await call('POST', '/api/auth/register', { name: 'AR Tester', email, password: 'test-password-123', orgName: 'AR Test LLC', locale: 'en' });
check('register', r.status === 200, `HTTP ${r.status}`);

r = await call('POST', '/api/ledger/setup', { entityId: ENT, fiscalYear: '2026', startsOn: '2026-01-01' });
check('books opened', r.status === 200, `${r.body?.accounts} accounts`);

const invId = 'inv-' + Date.now();
const invoice = {
  id: invId, entityId: ENT, direction: 'OUTBOUND', docType: 'TAX_INVOICE',
  number: 'INV-2026-001', issueDate: '2026-02-14', supplyDate: '2026-02-14', currency: 'AED',
  buyer: { nameEn: 'Al Marri Trading LLC', trn: '100000000000003' },
  seller: { nameEn: 'AR Test LLC' },
  lines: [
    { id: 'l1', lineNo: 1, description: 'Consulting', qty: 1, unitCode: 'C62', unitPriceMinor: 200000,
      taxProfileCode: 'STANDARD_5', lineNetMinor: 200000, lineVatMinor: 10000 },
    { id: 'l2', lineNo: 2, description: 'Export freight', qty: 1, unitCode: 'C62', unitPriceMinor: 50000,
      taxProfileCode: 'ZERO_EXPORT', lineNetMinor: 50000, lineVatMinor: 0 },
  ],
  totals: { taxExclusiveMinor: 250000, vatMinor: 10000, taxInclusiveMinor: 260000, payableMinor: 260000, perCategory: [] },
  lifecycleStatus: 'DRAFT', exchangeStatus: 'NOT_SENT', reportingStatusC2: 'NOT_REPORTED',
  source: 'EDITOR', compliance: { taxableEventDate: '2026-02-14', daysRemaining: 14, breached: false },
  createdAt: '2026-02-14T00:00:00Z', updatedAt: '2026-02-14T00:00:00Z',
};

r = await call('POST', '/api/store/invoices', invoice);
check('invoice saved to the document store', r.status === 200, `HTTP ${r.status}`);

console.log('\nPOSTING RULES');
r = await call('POST', '/api/ledger/ar/post', { invoiceId: invId });
check('a draft invoice is refused', r.status === 422 && /draft/i.test(r.body?.error ?? ''), r.body?.error?.slice(0, 70));

r = await call('POST', '/api/store/invoices', { ...invoice, lifecycleStatus: 'READY' });
check('invoice finalised', r.status === 200);

r = await call('POST', '/api/ledger/ar/post', { invoiceId: invId });
check('invoice posts to the ledger', r.status === 200 && r.body?.alreadyPosted === false, r.body?.reference ?? JSON.stringify(r.body).slice(0, 90));
const ref = r.body?.reference;

r = await call('POST', '/api/ledger/ar/post', { invoiceId: invId });
check('posting the same invoice again is a no-op', r.status === 200 && r.body?.alreadyPosted === true && r.body?.reference === ref, r.body?.reference);

console.log('\nWHAT IT DID TO THE BOOKS');
r = await call('GET', `/api/ledger/accounts/1100?entityId=${ENT}`);
const arLine = r.body?.lines?.[0];
check('the receivable is debited with the gross', arLine?.debitMinor === '260000', `dr ${arLine?.debitMinor}`);
check('a control account was reached by its subledger', r.body?.lines?.length === 1, `${r.body?.lines?.length} movements`);

r = await call('GET', `/api/ledger/accounts/4200?entityId=${ENT}`);
check('zero-rated exports land in their own revenue account', r.body?.lines?.[0]?.creditMinor === '50000', `cr ${r.body?.lines?.[0]?.creditMinor}`);

r = await call('GET', `/api/ledger/accounts/2100?entityId=${ENT}`);
check('output VAT is separated from revenue', r.body?.lines?.[0]?.creditMinor === '10000', `cr ${r.body?.lines?.[0]?.creditMinor}`);

r = await call('GET', `/api/ledger/trial-balance?entityId=${ENT}&period=2026-02`);
check('the trial balance ties after posting an invoice', r.body?.balanced === true, `dr ${r.body?.totalDebitMinor} cr ${r.body?.totalCreditMinor}`);

console.log('\nRECEIPTS AND AGEING');
r = await call('GET', `/api/ledger/ar/ageing?entityId=${ENT}&asOf=2026-03-01`);
check('the invoice shows as outstanding', r.body?.totalMinor === '260000', `total ${r.body?.totalMinor}`);
check('and ages from its own date', r.body?.open?.[0]?.daysOld === 15, `${r.body?.open?.[0]?.daysOld} days`);

r = await call('POST', '/api/ledger/ar/post', { invoiceId: invId, kind: 'receipt', paymentId: 'pay-1', receivedOn: '2026-02-25', bankAmountMinor: 100000 });
check('a part payment posts', r.status === 200, r.body?.reference ?? JSON.stringify(r.body).slice(0, 80));

r = await call('GET', `/api/ledger/ar/ageing?entityId=${ENT}&asOf=2026-03-01`);
check('only the unpaid balance stays open', r.body?.totalMinor === '160000', `total ${r.body?.totalMinor}`);
check('the item still ages from the invoice, not the receipt', r.body?.open?.[0]?.daysOld === 15, `${r.body?.open?.[0]?.daysOld} days`);

r = await call('POST', '/api/ledger/ar/post', { invoiceId: invId, kind: 'receipt', paymentId: 'pay-2', receivedOn: '2026-02-27', bankAmountMinor: 160000 });
check('the balancing payment posts', r.status === 200, r.body?.reference);

r = await call('GET', `/api/ledger/ar/ageing?entityId=${ENT}&asOf=2026-03-01`);
check('a settled invoice leaves the ageing report', r.body?.totalMinor === '0' && r.body?.open?.length === 0, `total ${r.body?.totalMinor}, ${r.body?.open?.length} open`);

r = await call('GET', `/api/ledger/trial-balance?entityId=${ENT}&period=2026-02`);
const tbAr = r.body?.rows?.find(x => x.code === '1100');
check('the receivable control account nets to zero', tbAr === undefined || tbAr.balanceMinor === '0', `balance ${tbAr?.balanceMinor ?? 'absent'}`);
check('and the trial balance still ties', r.body?.balanced === true, `diff ${r.body?.differenceMinor}`);

console.log('\nPAYABLES — THE BUYER SIDE');
const billId = 'bill-' + Date.now();
const bill = {
  id: billId, entityId: ENT, direction: 'INBOUND', docType: 'TAX_INVOICE',
  number: 'SUP-9001', issueDate: '2026-02-10', supplyDate: '2026-02-10', currency: 'AED',
  buyer: { nameEn: 'AR Test LLC' }, seller: { nameEn: 'Gulf Supplies LLC', trn: '100000000000011' },
  lines: [
    { id: 'b1', lineNo: 1, description: 'Office rent', qty: 1, unitCode: 'C62', unitPriceMinor: 300000,
      taxProfileCode: 'STANDARD_5', lineNetMinor: 300000, lineVatMinor: 15000 },
    { id: 'b2', lineNo: 2, description: 'Overseas consultancy', qty: 1, unitCode: 'C62', unitPriceMinor: 100000,
      taxProfileCode: 'REVERSE_CHARGE', lineNetMinor: 100000, lineVatMinor: 0 },
  ],
  totals: { taxExclusiveMinor: 400000, vatMinor: 15000, taxInclusiveMinor: 415000, payableMinor: 415000, perCategory: [] },
  lifecycleStatus: 'SENT', exchangeStatus: 'NOT_SENT', reportingStatusC2: 'NOT_REPORTED',
  source: 'INGEST', compliance: { taxableEventDate: '2026-02-10', daysRemaining: 14, breached: false },
  createdAt: '2026-02-10T00:00:00Z', updatedAt: '2026-02-10T00:00:00Z',
};
r = await call('POST', '/api/store/invoices', bill);
check('supplier bill saved', r.status === 200, `HTTP ${r.status}`);

r = await call('POST', '/api/ledger/ap/post', { billId, coding: { b1: '6100' } });
check('bill posts to the ledger', r.status === 200 && r.body?.alreadyPosted === false, r.body?.reference ?? JSON.stringify(r.body).slice(0, 90));
check('reverse charge is self-accounted at 5%', r.body?.reverseChargeMinor === '5000', `${r.body?.reverseChargeMinor} fils`);

r = await call('POST', '/api/ledger/ap/post', { billId });
check('posting the same bill again is a no-op', r.body?.alreadyPosted === true, r.body?.reference);

r = await call('GET', `/api/ledger/accounts/6100?entityId=${ENT}`);
check('the coded line lands in rent, not in a suspense account', r.body?.lines?.[0]?.debitMinor === '300000', `dr ${r.body?.lines?.[0]?.debitMinor}`);

r = await call('GET', `/api/ledger/accounts/2100?entityId=${ENT}`);
const outputVat = (r.body?.lines ?? []).reduce((a, l) => a + BigInt(l.creditMinor) - BigInt(l.debitMinor), 0n);
check('self-accounted VAT reaches the output box', outputVat === 15000n, `output VAT ${outputVat} (10,000 on sales + 5,000 reverse charge)`);

r = await call('GET', `/api/ledger/accounts/1350?entityId=${ENT}`);
const inputVat = (r.body?.lines ?? []).reduce((a, l) => a + BigInt(l.debitMinor) - BigInt(l.creditMinor), 0n);
check('and the same amount is reclaimable as input VAT', inputVat === 20000n, `input VAT ${inputVat} (15,000 charged + 5,000 reclaimed)`);

r = await call('GET', `/api/ledger/ap/ageing?entityId=${ENT}&asOf=2026-03-01`);
check('the bill shows as owed, reported positive', r.body?.totalMinor === '415000', `total ${r.body?.totalMinor}`);

r = await call('POST', '/api/ledger/ap/post', { billId, kind: 'payment', paymentId: 'sp-1', paidOn: '2026-02-28', bankAmountMinor: 415000 });
check('the supplier payment posts', r.status === 200, r.body?.reference ?? JSON.stringify(r.body).slice(0,80));

r = await call('GET', `/api/ledger/ap/ageing?entityId=${ENT}&asOf=2026-03-01`);
check('a paid bill leaves the payables report', r.body?.totalMinor === '0' && r.body?.open?.length === 0, `total ${r.body?.totalMinor}`);

r = await call('GET', `/api/ledger/trial-balance?entityId=${ENT}&period=2026-02`);
check('the trial balance ties across both subledgers', r.body?.balanced === true, `diff ${r.body?.differenceMinor}`);

console.log('\nVAT 201 RETURN');
r = await call('GET', `/api/ledger/vat?entityId=${ENT}&from=2026-02-01&to=2026-02-28`);
const b = (side, n) => (r.body?.[side] ?? []).find(x => x.box === n);
check('standard-rated sales reach box 1', b('sales','1')?.amountMinor === '200000' && b('sales','1')?.vatMinor === '10000',
  `${b('sales','1')?.amountMinor} @ ${b('sales','1')?.vatMinor}`);
check('zero-rated exports reach box 4 with no VAT figure', b('sales','4')?.amountMinor === '50000' && b('sales','4')?.vatMinor === null,
  `${b('sales','4')?.amountMinor} / vat ${JSON.stringify(b('sales','4')?.vatMinor)}`);
check('the reverse-charge supply reaches box 3', b('sales','3')?.vatMinor === '5000', `${b('sales','3')?.vatMinor}`);
check('standard-rated expenses reach box 9', b('expenses','9')?.amountMinor === '300000' && b('expenses','9')?.vatMinor === '15000',
  `${b('expenses','9')?.amountMinor} @ ${b('expenses','9')?.vatMinor}`);
check('and the same reverse charge is recoverable in box 10', b('expenses','10')?.vatMinor === '5000', `${b('expenses','10')?.vatMinor}`);
check('the net position is right', r.body?.totalOutputVatMinor === '15000' && r.body?.totalInputVatMinor === '20000' && r.body?.netVatMinor === '-5000',
  `out ${r.body?.totalOutputVatMinor} in ${r.body?.totalInputVatMinor} net ${r.body?.netVatMinor}`);
check('a net reclaim is reported as a reclaim, not a payment', r.body?.payable === false, `payable ${r.body?.payable}`);
check('the return reconciles to both VAT control accounts',
  r.body?.reconciliation?.outputMatches === true && r.body?.reconciliation?.inputMatches === true,
  `2100 ${r.body?.reconciliation?.outputVatPerLedgerMinor} / 1350 ${r.body?.reconciliation?.inputVatPerLedgerMinor}`);
check('and files no warnings when everything is coded', (r.body?.warnings ?? []).length === 0, JSON.stringify(r.body?.warnings ?? []).slice(0, 120));

r = await call('GET', `/api/ledger/vat?entityId=${ENT}&from=2026-02-28&to=2026-02-01`);
check('a backwards period is refused', r.status === 422, `HTTP ${r.status}`);

console.log('\nCROSS-TENANT');
const other = `other${Date.now()}@test.ae`;
const keep = cookie; cookie = '';
r = await call('POST', '/api/auth/register', { name: 'Other', email: other, password: 'test-password-123', orgName: 'Other LLC', locale: 'en' });
r = await call('POST', '/api/ledger/ar/post', { invoiceId: invId });
check("another tenant cannot post someone else's invoice", r.status === 404, `HTTP ${r.status}`);
r = await call('POST', '/api/ledger/ap/post', { billId });
check("another tenant cannot post someone else's bill", r.status === 404, `HTTP ${r.status}`);
r = await call('GET', `/api/ledger/ap/ageing?entityId=${ENT}`);
check("another tenant sees nothing in this entity's payables", r.status !== 200 || r.body?.totalMinor === '0', `HTTP ${r.status} total ${r.body?.totalMinor}`);
cookie = keep;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
