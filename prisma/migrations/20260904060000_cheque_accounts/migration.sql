-- Cheque accounts, kept out of cash.
--
-- A post-dated cheque received discharges the customer's debt without anything
-- arriving in the bank. The obvious home for it is 1050 "Undeposited funds",
-- and that is where the cheque subledger first put it — but cashflow.ts,
-- forecast.ts and equity.ts all count 1050 among cash and cash equivalents, so
-- a ninety-day cheque parked there is reported as cash. IAS 7.7 asks for an
-- insignificant risk of a change in value, and a post-dated cheque is nothing
-- but that risk. Reporting it as cash is exactly the error the subledger
-- exists to prevent, one level up.
--
-- 2060 is the mirror. When our own dated cheque is handed over, the supplier's
-- open account is discharged — leaving it in 2000 would show a payables ageing
-- a debt no invoice carries any more — but folding it into 2050 "Accrued
-- expenses" would bury a dated, bank-bound commitment among estimates.

INSERT INTO "Account" ("id","orgId","entityId","code","name","nameAr","type","subtype","parentId","isPostable","isControl","createdAt")
SELECT md5(random()::text || clock_timestamp()::text || c."code"), b."orgId", b."entityId",
       c."code", c."name", c."nameAr", c."type", NULL,
       (SELECT p.id FROM "Account" p WHERE p."orgId" = b."orgId" AND p."entityId" = b."entityId" AND p."code" = c."parent"),
       true, false, NOW()
FROM (SELECT DISTINCT "orgId", "entityId" FROM "Account") b
CROSS JOIN (VALUES
  ('1060', 'Cheques in hand (post-dated)',      'شيكات برسم التحصيل',  'ASSET',     '10'),
  ('2060', 'Cheques issued, not yet presented', 'شيكات صادرة لم تقدم', 'LIABILITY', '20')
) AS c("code","name","nameAr","type","parent")
WHERE NOT EXISTS (
  SELECT 1 FROM "Account" a WHERE a."orgId" = b."orgId" AND a."entityId" = b."entityId" AND a."code" = c."code"
);
