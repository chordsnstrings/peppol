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

console.log('\nCROSS-TENANT');
const other = `other${Date.now()}@test.ae`;
const keep = cookie; cookie = '';
r = await call('POST', '/api/auth/register', { name: 'Other', email: other, password: 'test-password-123', orgName: 'Other LLC', locale: 'en' });
r = await call('POST', '/api/ledger/ar/post', { invoiceId: invId });
check("another tenant cannot post someone else's invoice", r.status === 404, `HTTP ${r.status}`);
cookie = keep;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
