const B = process.env.BASE ?? 'http://localhost:3000';
let cookie = '';
let pass = 0, fail = 0;
const ok = (n, extra='') => { pass++; console.log(`  PASS  ${n}${extra?' — '+extra:''}`); };
const bad = (n, e) => { fail++; console.log(`  FAIL  ${n} — ${e}`); };
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

const email = `ledger${Date.now()}@test.ae`;
const reg = await call('POST', '/api/auth/register', { name: 'Ledger Tester', email, password: 'test-password-123', orgName: 'Ledger Test LLC', locale: 'en' });
reg.status === 200 ? ok('register + session') : bad('register', reg.status + ' ' + JSON.stringify(reg.body));
const ENT = 'entity-' + Date.now();

console.log('\nLEDGER API');
let r = await call('POST', '/api/ledger/setup', { entityId: ENT, fiscalYear: '2026', startsOn: '2026-01-01' });
r.status === 200 && r.body.accounts > 50 ? ok('open books', `${r.body.accounts} accounts, ${r.body.book.functionalCurrency}`) : bad('open books', r.status + ' ' + JSON.stringify(r.body).slice(0,160));

r = await call('GET', `/api/ledger/accounts?entityId=${ENT}&q=1100`);
r.body?.accounts?.[0]?.nameAr === 'الذمم المدينة التجارية' ? ok('chart search returns bilingual account') : bad('chart search', JSON.stringify(r.body).slice(0,160));

r = await call('POST', '/api/ledger/journals', { entityId: ENT, entryDate: '2026-01-15', memo: 'Owner capital',
  lines: [{ account: '1010', debit: 5000000 }, { account: '3000', credit: 5000000 }] });
r.status === 200 && r.body.entry?.status === 'posted' ? ok('post manual journal', r.body.entry.series + '-' + r.body.entry.number) : bad('post journal', r.status + ' ' + JSON.stringify(r.body).slice(0,200));
const entryId = r.body?.entry?.id;

r = await call('POST', '/api/ledger/journals', { entityId: ENT, entryDate: '2026-01-16',
  lines: [{ account: '1010', debit: 1000 }, { account: '4000', credit: 900 }] });
r.status === 422 && /does not balance/i.test(r.body.error) ? ok('unbalanced journal rejected 422', r.body.error.slice(0,52)) : bad('unbalanced rejection', r.status + ' ' + JSON.stringify(r.body).slice(0,160));

r = await call('POST', '/api/ledger/journals', { entityId: ENT, entryDate: '2026-01-16',
  lines: [{ account: '1100', debit: 1000 }, { account: '4000', credit: 1000 }] });
r.status === 422 && /control account/i.test(r.body.error) ? ok('manual journal to control account rejected') : bad('control account rejection', r.status + ' ' + JSON.stringify(r.body).slice(0,160));

r = await call('GET', `/api/ledger/trial-balance?entityId=${ENT}&period=2026-01`);
r.body?.balanced === true && r.body.differenceMinor === '0' ? ok('trial balance ties', `${r.body.rows.length} accounts, dr ${r.body.totalDebitMinor}`) : bad('trial balance', JSON.stringify(r.body).slice(0,200));

r = await call('GET', `/api/ledger/accounts/1010?entityId=${ENT}`);
r.body?.lines?.length >= 1 && r.body.lines[0].runningMinor ? ok('drill-down with running balance', r.body.lines[0].reference) : bad('drill-down', JSON.stringify(r.body).slice(0,200));

r = await call('POST', `/api/ledger/journals/${entryId}/reverse`, { memo: 'Reversing' });
r.status === 200 && r.body.entry?.reversalOfId === undefined ? ok('reversal posted', r.body.entry.series + '-' + r.body.entry.number) : (r.status===200?ok('reversal posted'):bad('reverse', r.status + ' ' + JSON.stringify(r.body).slice(0,200)));

r = await call('GET', `/api/ledger/trial-balance?entityId=${ENT}&period=2026-01`);
r.body?.balanced === true ? ok('trial balance still ties after reversal') : bad('TB after reversal', JSON.stringify(r.body).slice(0,160));

// period close blocks posting
r = await call('GET', `/api/ledger/periods?entityId=${ENT}`);
const jan = r.body?.periods?.find(p => p.label === '2026-01');
r = await call('PATCH', '/api/ledger/periods', { periodId: jan.id, status: 'soft_closed' });
r.status === 200 ? ok('period soft-closed') : bad('soft close', JSON.stringify(r.body).slice(0,160));
r = await call('POST', '/api/ledger/journals', { entityId: ENT, entryDate: '2026-01-20',
  lines: [{ account: '1010', debit: 100 }, { account: '4000', credit: 100 }] });
r.status === 422 && /soft closed|not open|posting refused/i.test(r.body.error) ? ok('posting into a closed period refused', r.body.error.slice(0,58)) : bad('closed period', r.status + ' ' + JSON.stringify(r.body).slice(0,160));
r = await call('PATCH', '/api/ledger/periods', { periodId: jan.id, status: 'hard_closed' });
r = await call('PATCH', '/api/ledger/periods', { periodId: jan.id, status: 'open' });
r.status === 422 ? ok('hard-closed period cannot reopen directly') : bad('reopen guard', r.status + ' ' + JSON.stringify(r.body).slice(0,160));

console.log('\nTHE NEWER SUBLEDGERS');
// A second entity, because the first one's January is now hard-closed and
// these checks are about the modules rather than about the period guard.
const E2 = 'entity2-' + Date.now();
r = await call('POST', '/api/ledger/setup', { entityId: E2, fiscalYear: '2026', startsOn: '2026-01-01' });
r.status === 200 ? ok('second entity opened') : bad('second entity', r.status + ' ' + JSON.stringify(r.body).slice(0,160));

// Counterparties: a limit never set and a limit of nothing are different facts.
r = await call('POST', '/api/ledger/counterparties', { entityId: E2, action: 'create',
  counterparty: { code: 'C-1', name: 'Gulf Logistics LLC', kind: 'CUSTOMER', paymentTerms: 60 } });
r.status === 200 ? ok('counterparty created') : bad('counterparty create', r.status + ' ' + JSON.stringify(r.body).slice(0,200));

r = await call('GET', `/api/ledger/counterparties?entityId=${E2}&view=credit&code=C-1`);
r.status === 200 && r.body?.headroomMinor === null
  ? ok('a credit limit never set reads as unassessed, not as nil')
  : bad('credit headroom', r.status + ' ' + JSON.stringify(r.body).slice(0,200));

// Revenue: allocation must sum to the transaction price exactly.
r = await call('POST', '/api/ledger/revenue', { entityId: E2, action: 'create', contract: {
  code: 'RC-1', customerName: 'Gulf Logistics LLC', signedOn: '2026-01-05', priceMinor: '1000',
  obligations: [
    { description: 'Licence', standalonePriceMinor: '7', timing: 'POINT_IN_TIME' },
    { description: 'Support', standalonePriceMinor: '11', timing: 'OVER_TIME' },
    { description: 'Training', standalonePriceMinor: '13', timing: 'POINT_IN_TIME' },
  ] } });
const alloc = (r.body?.contract?.obligations ?? []).map(o => o.allocatedMinor);
r.status === 200 && alloc.join(',') === '226,355,419'
  ? ok('the transaction price is allocated to the last minor unit', alloc.join('/'))
  : bad('revenue allocation', r.status + ' ' + JSON.stringify(r.body).slice(0,240));

r = await call('POST', '/api/ledger/revenue', { entityId: E2, action: 'bill', code: 'RC-1', amountMinor: '1000' });
r.status === 200 ? ok('billing recorded against the contract') : bad('revenue bill', r.status + ' ' + JSON.stringify(r.body).slice(0,200));
r = await call('POST', '/api/ledger/revenue', { entityId: E2, action: 'run', code: 'RC-1', on: '2026-01-31' });
r.status === 200 && r.body?.contractLiabilityMinor === '1000'
  ? ok('billing ahead of delivery is carried as a contract liability')
  : bad('revenue run', r.status + ' ' + JSON.stringify(r.body).slice(0,200));
r = await call('POST', '/api/ledger/revenue', { entityId: E2, action: 'run', code: 'RC-1', on: '2026-01-31' });
r.status === 200 && r.body?.posted === false
  ? ok('a second run posts nothing, because the position has not moved')
  : bad('revenue idempotence', r.status + ' ' + JSON.stringify(r.body).slice(0,200));

r = await call('POST', '/api/ledger/revenue', { entityId: E2, action: 'bill', code: 'RC-1', amountMinor: '1' });
r.status === 422 && /above its transaction price/i.test(r.body?.error ?? '')
  ? ok('over-billing a contract is refused', r.body.error.slice(0, 60))
  : bad('over-billing guard', r.status + ' ' + JSON.stringify(r.body).slice(0,200));

// Sales orders: a promise is not a transaction, so nothing reaches the ledger.
r = await call('GET', `/api/ledger/trial-balance?entityId=${E2}&period=2026-01`);
const tbBefore = r.body?.totalDebitMinor;
r = await call('POST', '/api/ledger/sales-orders', { entityId: E2, action: 'create', order: {
  kind: 'QUOTE', customerName: 'Gulf Logistics LLC', issuedOn: '2026-01-10', validUntil: '2026-02-10',
  lines: [{ description: 'Pallets', quantityMilli: '2000', unitPriceMinor: '50000', taxCode: 'STANDARD_5' }] } });
r.status === 200 ? ok('quotation raised', r.body?.order?.number ?? '') : bad('quote', r.status + ' ' + JSON.stringify(r.body).slice(0,240));
r = await call('GET', `/api/ledger/trial-balance?entityId=${E2}&period=2026-01`);
r.body?.totalDebitMinor === tbBefore
  ? ok('a quotation leaves the ledger untouched, as a promise should')
  : bad('quote touched the ledger', `${tbBefore} -> ${r.body?.totalDebitMinor}`);

// Petty cash: the imprest identity is the whole feature.
r = await call('POST', '/api/ledger/petty-cash', { entityId: E2, action: 'open',
  code: 'PC-1', name: 'Front desk float', custodian: 'Reception', floatMinor: '50000', openedOn: '2026-01-05' });
r.status === 200 ? ok('petty cash float opened') : bad('petty cash open', r.status + ' ' + JSON.stringify(r.body).slice(0,240));
r = await call('GET', `/api/ledger/petty-cash?entityId=${E2}`);
r.status === 200 && r.body?.summary?.outOfBalanceCount === 0 && (r.body?.funds ?? []).length === 1
  ? ok('cash on hand plus unreimbursed receipts equals the float')
  : bad('imprest identity', r.status + ' ' + JSON.stringify(r.body).slice(0,240));

// Attention: the list has to answer in one request.
r = await call('GET', `/api/ledger/attention?entityId=${E2}`);
r.status === 200 && Array.isArray(r.body?.findings)
  ? ok('the attention list answers in one request', `${r.body.findings.length} findings, ${(r.body.failed ?? []).length} checks failed`)
  : bad('attention', r.status + ' ' + JSON.stringify(r.body).slice(0,240));

// Payment runs: nothing to pay is a refusal with a reason, not an empty run.
r = await call('POST', '/api/ledger/payment-runs', { entityId: E2, action: 'propose', runDate: '2026-01-31' });
r.status === 200 || (r.status === 422 && (r.body?.error ?? '').length > 20)
  ? ok('a payment run either proposes or says why it cannot', (r.body?.error ?? 'proposed').slice(0, 60))
  : bad('payment run propose', r.status + ' ' + JSON.stringify(r.body).slice(0,240));

// Every one of these answers 422 with a sentence, never a bare 500.
for (const [path, body] of [
  ['/api/ledger/revenue', { entityId: E2, action: 'run', code: 'NOPE', on: '2026-01-31' }],
  ['/api/ledger/counterparties', { entityId: E2, action: 'archive', code: 'NOPE' }],
  ['/api/ledger/petty-cash', { entityId: E2, action: 'reimburse', fundId: 'nope', movedOn: '2026-01-31' }],
]) {
  r = await call('POST', path, body);
  r.status >= 400 && r.status < 500 && /[a-z]{4,}/.test(r.body?.error ?? '')
    ? ok(`${path} refuses an unknown thing with a sentence`, (r.body.error ?? '').slice(0, 50))
    : bad(`${path} refusal`, r.status + ' ' + JSON.stringify(r.body).slice(0,160));
}

// Every route, swept.
//
// The checks above test the routes somebody thought to test. This enumerates
// the route files from disk instead, so a route added tomorrow is covered the
// day it lands rather than the day somebody remembers it. Two things are asked
// of every one of them, and they are the two things no route may ever get
// wrong:
//
//   it must not answer 5xx — a crash is a crash whatever caused it, and a
//   route that throws on a GET with a valid entity has a bug in it;
//
//   if it refuses, it must refuse with a sentence. Several of these need
//   parameters this sweep does not know (a date range, a period, a document
//   id) and 400 is the right answer to that — but "400" on its own is not an
//   answer anybody can act on.
console.log('\nEVERY ROUTE ANSWERS');
const { readdirSync, existsSync } = await import('node:fs');
const routes = readdirSync('src/app/api/ledger', { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(`src/app/api/ledger/${e.name}/route.ts`))
  .map((e) => e.name)
  .sort();

const crashed = [];
const mute = [];
for (const name of routes) {
  r = await call('GET', `/api/ledger/${name}?entityId=${E2}`);
  if (r.status >= 500) crashed.push(`${name} ${r.status}`);
  else if (r.status >= 400 && !/[a-z]{4,}/.test(r.body?.error ?? '')) mute.push(`${name} ${r.status}`);
}
crashed.length === 0
  ? ok(`no route crashes on a GET`, `${routes.length} routes`)
  : bad('routes that answered 5xx', crashed.join(', ').slice(0, 200));
mute.length === 0
  ? ok('every refusal carries a sentence somebody can act on')
  : bad('routes that refused without saying why', mute.join(', ').slice(0, 200));

// auth
cookie = '';
r = await call('GET', `/api/ledger/trial-balance?entityId=${ENT}&period=2026-01`);
r.status === 401 ? ok('unauthenticated request refused 401') : bad('auth guard', r.status);

// And not one of them is readable without a session. One route that forgot
// requireSession is one route that hands the whole ledger to anybody who knows
// an entity id, and it would never show up in a test of the routes somebody
// remembered.
const open = [];
for (const name of routes) {
  r = await call('GET', `/api/ledger/${name}?entityId=${E2}`);
  if (r.status !== 401) open.push(`${name} ${r.status}`);
}
open.length === 0
  ? ok('every ledger route refuses an unauthenticated read', `${routes.length} routes`)
  : bad('routes readable with no session', open.join(', ').slice(0, 200));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
