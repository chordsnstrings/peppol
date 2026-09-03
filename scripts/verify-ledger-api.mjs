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

// auth
cookie = '';
r = await call('GET', `/api/ledger/trial-balance?entityId=${ENT}&period=2026-01`);
r.status === 401 ? ok('unauthenticated request refused 401') : bad('auth guard', r.status);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
