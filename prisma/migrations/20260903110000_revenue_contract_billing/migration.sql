-- Revenue contracts need to know what has been invoiced against them, because
-- IFRS 15 presentation is the difference between what was billed and what was
-- earned: bill ahead and you hold a contract liability, earn ahead and you hold
-- a contract asset. Without the billed figure the difference cannot be found.

ALTER TABLE "RevenueContract"
  ADD COLUMN "billedMinor" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "revenueAccount" TEXT NOT NULL DEFAULT '4100';

-- Billing is cumulative and only ever goes up; a credit note against a contract
-- is a modification, which changes the price, not the history of what was sent.
ALTER TABLE "RevenueContract"
  ADD CONSTRAINT "RevenueContract_billed_check" CHECK ("billedMinor" >= 0);

-- The two accounts IFRS 15 presentation needs. They are seeded into every new
-- chart, but an entity whose books were opened before this migration would not
-- have them, and a posting to a missing account fails at the ledger with a
-- message about the account rather than about the contract.
INSERT INTO "Account" ("id", "orgId", "entityId", "code", "name", "nameAr", "type", "subtype", "parentId", "isPostable", "isControl", "createdAt")
SELECT
  md5(random()::text || clock_timestamp()::text), p."orgId", p."entityId", v.code, v.name, v."nameAr", v.type, v.subtype, p.id, true, false, NOW()
FROM (VALUES
  ('1310', 'Contract assets (unbilled revenue)', 'أصول العقود (إيرادات غير مفوترة)', 'ASSET', 'CONTRACT_ASSET', '10'),
  ('2310', 'Contract liabilities (deferred revenue)', 'التزامات العقود (إيرادات مؤجلة)', 'LIABILITY', 'CONTRACT_LIABILITY', '20'),
  ('6360', 'Interest and finance costs', 'الفوائد وتكاليف التمويل', 'EXPENSE', 'FINANCE_COST', '6')
) AS v(code, name, "nameAr", type, subtype, parent)
JOIN "Account" p ON p."code" = v.parent
WHERE NOT EXISTS (
  SELECT 1 FROM "Account" a
  WHERE a."orgId" = p."orgId" AND a."entityId" = p."entityId" AND a."code" = v.code
);
