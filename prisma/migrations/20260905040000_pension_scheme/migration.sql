-- Pension scheme membership, and the account it is owed into.
--
-- Payroll accrued Article 51 end-of-service gratuity for every employee. Article
-- 51 of Federal Decree-Law 33/2021 gives that gratuity to the *foreign* worker;
-- a UAE national in the private sector is covered by the pension and social
-- security scheme under Federal Law 7/1999 instead. Accruing both provides for
-- the same service twice, and accruing neither of the pension contributions
-- understates the monthly cost of employing them.
--
-- Membership is a declared field rather than one inferred from nationality.
-- Eligibility is a legal fact about a person — a GCC national may or may not be
-- enrolled under the Insurance Protection Extension Programme, a UAE national
-- may be registered late — and a passport field does not settle it. The same
-- reasoning the related-party note already follows: declared, never detected.

ALTER TABLE "Employee"
  ADD COLUMN "nationality" TEXT,
  ADD COLUMN "pensionScheme" TEXT NOT NULL DEFAULT 'NONE';

ALTER TABLE "Employee"
  ADD CONSTRAINT "Employee_pension_scheme_check"
  CHECK ("pensionScheme" IN ('NONE','GPSSA','GCC_HOME_STATE'));

-- Contributions withheld from the employee and owed by the employer, together,
-- because the authority is paid one amount and reconciles one liability.
INSERT INTO "Account" ("id","orgId","entityId","code","name","nameAr","type","subtype","parentId","isPostable","isControl","createdAt")
SELECT md5(random()::text || clock_timestamp()::text || '2230'), b."orgId", b."entityId",
       '2230', 'Pension contributions payable', 'اشتراكات التقاعد المستحقة', 'LIABILITY', 'PAYROLL',
       (SELECT p.id FROM "Account" p WHERE p."orgId" = b."orgId" AND p."entityId" = b."entityId" AND p."code" = '20'),
       true, false, NOW()
FROM (SELECT DISTINCT "orgId", "entityId" FROM "Account") b
WHERE NOT EXISTS (
  SELECT 1 FROM "Account" a WHERE a."orgId" = b."orgId" AND a."entityId" = b."entityId" AND a."code" = '2230'
);
