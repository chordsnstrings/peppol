/* Proves the ledger's database-enforced invariants. Every assertion here must
   FAIL at the database — not in application code. */
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const ORG = 'test-org-' + process.pid, ENT = 'test-entity-' + process.pid;
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  PASS  ${n}`); };
const bad = (n, e) => { fail++; console.log(`  FAIL  ${n}${e ? ' — ' + e : ''}`); };
async function rejects(name, fn, match) {
  const want = match == null ? [] : (Array.isArray(match) ? match : [match]);
  try { await fn(); bad(name, 'expected the database to refuse this'); }
  catch (e) { const m = String(e.message || e);
    if (!want.length || want.some((w) => m.includes(w))) ok(name);
    else bad(name, 'wrong error: ' + m.split('\n').pop().slice(0, 110)); }
}
async function allows(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, String(e.message).split('\n').pop().slice(0, 140)); } }

const fy = await db.fiscalYear.create({ data: { orgId: ORG, entityId: ENT, label: '2026', startsOn: new Date('2026-01-01'), endsOn: new Date('2026-12-31') } });
const open = await db.accountingPeriod.create({ data: { orgId: ORG, entityId: ENT, fiscalYearId: fy.id, seq: 1, label: '2026-01', startsOn: new Date('2026-01-01'), endsOn: new Date('2026-01-31') } });
const shut = await db.accountingPeriod.create({ data: { orgId: ORG, entityId: ENT, fiscalYearId: fy.id, seq: 2, label: '2026-02', startsOn: new Date('2026-02-01'), endsOn: new Date('2026-02-28'), status: 'hard_closed' } });
const book = await db.book.create({ data: { orgId: ORG, entityId: ENT, name: 'Primary', isDefault: true } });
const mk = (code, name, type, extra = {}) => db.account.create({ data: { orgId: ORG, entityId: ENT, code, name, type, ...extra } });
const cash = await mk('1000', 'Cash', 'ASSET');
const sales = await mk('4000', 'Sales', 'INCOME');
const header = await mk('1', 'Assets', 'ASSET', { isPostable: false });
const arCtl = await mk('1100', 'Trade receivables', 'ASSET', { isControl: true, subtype: 'AR' });
const usdOnly = await mk('1010', 'USD bank', 'ASSET', { currency: 'USD', subtype: 'BANK' });

const L = (accountId, minor, cur = 'AED') => ({ orgId: ORG, accountId, txnCurrency: cur, txnAmountMinor: BigInt(minor), functionalCurrency: 'AED', functionalAmountMinor: BigInt(minor) });
const entry = (over = {}, lines = []) => db.journalEntry.create({
  data: { orgId: ORG, entityId: ENT, bookId: book.id, periodId: open.id, series: 'GJ', number: 'N' + Math.random().toString(36).slice(2, 9),
    entryDate: new Date('2026-01-15'), status: 'posted', ...over,
    lines: { create: lines.map((l, i) => ({ lineNo: i + 1, ...l })) } },
});

console.log('\nLEDGER INVARIANTS');
await allows('balanced entry posts', () => entry({}, [L(cash.id, 10000), L(sales.id, -10000)]));
await rejects('unbalanced entry is refused', () => entry({}, [L(cash.id, 10000), L(sales.id, -9999)]), 'does not balance');
// A lone line can only balance if it is zero, which is separately refused — so
// either refusal is correct. The two-line rule is defence in depth.
await rejects('single-line entry is refused', () => entry({}, [L(cash.id, 10000)]), ['at least two lines', 'does not balance']);
await rejects('zero-amount line is refused', () => entry({}, [L(cash.id, 0), L(sales.id, 0)]), 'zero-amount');
await rejects('post into a closed period is refused', () => entry({ periodId: shut.id }, [L(cash.id, 500), L(sales.id, -500)]), 'posting refused');
await rejects('header account is not postable', () => entry({}, [L(header.id, 500), L(sales.id, -500)]), 'header account');
await rejects('manual journal to a control account is refused', () => entry({ source: 'manual' }, [L(arCtl.id, 500), L(sales.id, -500)]), 'control account');
await allows('subledger may post to a control account', () => entry({ source: 'invoice' }, [L(arCtl.id, 500), L(sales.id, -500)]));
await rejects('currency-restricted account refuses another currency', () => entry({}, [L(usdOnly.id, 500), L(sales.id, -500)]), 'only accepts');
// Cross-currency entries are legitimate; the invariant is the FUNCTIONAL balance.
await rejects('cross-currency entry that does not balance functionally is refused',
  () => entry({}, [L(cash.id, 10000, 'AED'), L(sales.id, -10000, 'AED'), L(usdOnly.id, 700, 'USD')]), 'does not balance');
await allows('cross-currency entry that balances functionally is accepted', () => entry({}, [
  { ...L(usdOnly.id, 0, 'USD'), txnAmountMinor: 10000n, functionalAmountMinor: 36730n },
  { ...L(sales.id, 0), txnAmountMinor: -36730n, functionalAmountMinor: -36730n },
]));

const posted = await entry({}, [L(cash.id, 2500), L(sales.id, -2500)]);
await rejects('posted entry cannot be deleted', () => db.journalEntry.delete({ where: { id: posted.id } }), 'cannot be deleted');
await rejects('posted entry date cannot be edited', () => db.journalEntry.update({ where: { id: posted.id }, data: { entryDate: new Date('2026-01-20') } }), 'immutable');
await rejects('lines of a posted entry cannot be edited',
  () => db.journalLine.updateMany({ where: { entryId: posted.id }, data: { txnAmountMinor: BigInt(1) } }), 'cannot be modified');
await rejects('lines cannot be deleted from a posted entry',
  () => db.journalLine.deleteMany({ where: { entryId: posted.id } }), 'cannot be deleted');
await allows('draft may be unbalanced while being written',
  () => entry({ status: 'draft' }, [L(cash.id, 10000), L(sales.id, -1)]));

// gapless numbering under concurrency
const nums = await Promise.all(Array.from({ length: 25 }, () => db.$queryRaw`SELECT gl_next_number(${ORG}, ${ENT}, 'GJ') AS n`));
const got = nums.map((r) => r[0].n);
(new Set(got).size === 25) ? ok('25 concurrent number allocations are unique') : bad('concurrent numbering collided', `${new Set(got).size}/25 unique`);
(got.includes('00001') && got.includes('00025')) ? ok('numbering is gapless 00001..00025') : bad('numbering has gaps', got.sort().slice(0, 3).join(','));


// ── Guard hardening: the three holes found by reading the guards against what
//    they are meant to guarantee rather than against what they happened to check.

// 1. Immutability is an allowlist, not a denylist. `memo` was never named in
//    the old guard, so a posted entry's description could be rewritten with no
//    trace — the exact thing the guard exists to prevent.
await rejects('memo of a posted entry cannot be rewritten',
  () => db.journalEntry.update({ where: { id: posted.id }, data: { memo: 'rewritten history' } }), 'immutable');
await rejects('provenance of a posted entry cannot be rewritten',
  () => db.journalEntry.update({ where: { id: posted.id }, data: { actorId: 'someone-else' } }), 'immutable');
await rejects('source document link of a posted entry cannot be repointed',
  () => db.journalEntry.update({ where: { id: posted.id }, data: { sourceId: 'other-doc' } }), 'immutable');

// 2. posted → draft was the two-step route around immutability: unpost, edit,
//    repost. The status machine now refuses every transition but posted →
//    reversed.
await rejects('a posted entry cannot be unposted back to draft',
  () => db.journalEntry.update({ where: { id: posted.id }, data: { status: 'draft' } }), 'never unposted');
await allows('a posted entry may be marked reversed',
  () => db.journalEntry.update({ where: { id: posted.id }, data: { status: 'reversed' } }));

// 3. The numbering race is on the FIRST allocation for a scope: with no
//    DocumentSequence row, every concurrent caller took the same NOT FOUND
//    branch and raced to INSERT. Test a scope that has never been used.
const freshScope = 'RACE' + Date.now();
const raced = await Promise.all(
  Array.from({ length: 20 }, () => db.$queryRaw`SELECT gl_next_number(${ORG}, ${ENT}, ${freshScope}) AS n`),
);
const rn = raced.map((r) => r[0].n);
(new Set(rn).size === 20)
  ? ok('20 racers on a brand-new sequence all get distinct numbers')
  : bad('first-allocation race collided', `${new Set(rn).size}/20 unique`);
(rn.includes('00001') && rn.includes('00020'))
  ? ok('a brand-new sequence is gapless 00001..00020')
  : bad('new sequence has gaps', rn.sort().slice(0, 3).join(','));

await db.$executeRaw`DELETE FROM "JournalLine" WHERE "orgId" = ${ORG}`.catch(() => {});
await db.$executeRawUnsafe(`DELETE FROM "JournalEntry" WHERE "orgId" = '${ORG}'`).catch(() => {});
await db.$disconnect();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
