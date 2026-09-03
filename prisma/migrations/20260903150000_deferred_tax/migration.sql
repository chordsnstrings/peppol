-- Deferred tax (IAS 12).
--
-- The register is kept per reporting date rather than as a running balance.
-- The charge for a period is the movement between two dates, and a running
-- balance that gets overwritten cannot be asked what last year's position was
-- — which is exactly the question an auditor puts first.

CREATE TABLE "DeferredTaxItem" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "asOf" DATE NOT NULL,
    "code" TEXT NOT NULL, "description" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'OTHER',
    "carryingMinor" BIGINT NOT NULL,
    "taxBaseMinor" BIGINT NOT NULL,
    "rateBps" INTEGER NOT NULL DEFAULT 900,
    "unrecognisedMinor" BIGINT NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DeferredTaxItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DeferredTaxItem_category_check"
      CHECK ("category" IN ('FIXED_ASSET','PROVISION','LEASE','LOSS','REVENUE','OTHER')),
    -- A rate outside nought to a hundred percent is a typo, and a deferred tax
    -- balance computed from one is wrong by orders of magnitude.
    CONSTRAINT "DeferredTaxItem_rate_check" CHECK ("rateBps" >= 0 AND "rateBps" <= 10000),
    -- IAS 12.24: a deductible difference is an asset only so far as future
    -- profit is probable. What is written off cannot exceed what is there.
    CONSTRAINT "DeferredTaxItem_unrecognised_check" CHECK ("unrecognisedMinor" >= 0)
);
CREATE UNIQUE INDEX "DeferredTaxItem_orgId_entityId_asOf_code_key"
  ON "DeferredTaxItem"("orgId","entityId","asOf","code");
CREATE INDEX "DeferredTaxItem_orgId_entityId_asOf_idx" ON "DeferredTaxItem"("orgId","entityId","asOf");

CREATE TABLE "DeferredTaxPosting" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "asOf" DATE NOT NULL,
    "netMinor" BIGINT NOT NULL,
    "assetMinor" BIGINT NOT NULL,
    "liabilityMinor" BIGINT NOT NULL,
    "chargeMinor" BIGINT NOT NULL,
    "entryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeferredTaxPosting_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DeferredTaxPosting_sides_check"
      CHECK ("assetMinor" >= 0 AND "liabilityMinor" >= 0),
    -- The net is the two sides, so it cannot be recorded independently of them.
    CONSTRAINT "DeferredTaxPosting_net_check"
      CHECK ("netMinor" = "liabilityMinor" - "assetMinor")
);
CREATE UNIQUE INDEX "DeferredTaxPosting_orgId_entityId_asOf_key"
  ON "DeferredTaxPosting"("orgId","entityId","asOf");
CREATE INDEX "DeferredTaxPosting_orgId_entityId_idx" ON "DeferredTaxPosting"("orgId","entityId");

-- The three accounts IAS 12 presentation needs, for books opened before this.
-- Deferred tax is non-current whichever way it falls (IAS 1.56), so the asset
-- sits under 15 and the liability under 25.
INSERT INTO "Account" ("id","orgId","entityId","code","name","nameAr","type","subtype","parentId","isPostable","isControl","createdAt")
SELECT md5(random()::text || clock_timestamp()::text), b."orgId", b."entityId", v.code, v.name, v."nameAr", v.type, v.subtype,
       (SELECT p.id FROM "Account" p WHERE p."orgId" = b."orgId" AND p."entityId" = b."entityId" AND p."code" = v.parent),
       true, false, NOW()
FROM (SELECT DISTINCT "orgId", "entityId" FROM "Account") b
CROSS JOIN (VALUES
  ('1320','Deferred tax asset','أصل ضريبي مؤجل','ASSET','DEFERRED_TAX_ASSET','15'),
  ('2320','Deferred tax liability','التزام ضريبي مؤجل','LIABILITY','DEFERRED_TAX_LIABILITY','25'),
  ('7010','Deferred tax expense','مصروف الضريبة المؤجلة','EXPENSE','DEFERRED_TAX_EXPENSE',NULL)
) AS v(code,name,"nameAr",type,subtype,parent)
WHERE NOT EXISTS (
  SELECT 1 FROM "Account" a
  WHERE a."orgId" = b."orgId" AND a."entityId" = b."entityId" AND a."code" = v.code
);
