-- Revaluation and impairment of fixed assets (IAS 16 and IAS 36).
--
-- The rule that shapes the whole thing is IAS 16.39-40: an increase goes to the
-- revaluation surplus in equity, except to the extent it reverses a decrease
-- previously charged to profit, which goes back to profit; and a decrease goes
-- to profit, except to the extent of a surplus already held for that asset,
-- which comes out of equity first.
--
-- "For that asset" is the part that dictates the schema. The split cannot be
-- computed from an entity-wide surplus — one asset's surplus cannot absorb
-- another's fall — so both the surplus and the impairment charged so far are
-- carried per asset, and every event is kept rather than netted into a running
-- figure.

ALTER TABLE "FixedAsset"
  ADD COLUMN "surplusMinor" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "impairedMinor" BIGINT NOT NULL DEFAULT 0;

-- A revaluation surplus is a credit balance or it is nothing; a negative one
-- would be a deficit, which IAS 16 does not recognise — that is an expense.
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_surplus_check" CHECK ("surplusMinor" >= 0);
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_impaired_check" CHECK ("impairedMinor" >= 0);

CREATE TABLE "AssetRevaluation" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL, "seq" INTEGER NOT NULL,
    "revaluedOn" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "carryingBeforeMinor" BIGINT NOT NULL,
    "fairValueMinor" BIGINT NOT NULL,
    "movementMinor" BIGINT NOT NULL,
    "toSurplusMinor" BIGINT NOT NULL DEFAULT 0,
    "toProfitMinor" BIGINT NOT NULL DEFAULT 0,
    "surplusAfterMinor" BIGINT NOT NULL DEFAULT 0,
    "basis" TEXT, "entryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssetRevaluation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AssetRevaluation_assetId_fkey" FOREIGN KEY ("assetId")
      REFERENCES "FixedAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AssetRevaluation_kind_check"
      CHECK ("kind" IN ('REVALUATION','IMPAIRMENT','REVERSAL')),
    -- A revaluation to a negative amount is not a valuation.
    CONSTRAINT "AssetRevaluation_fair_check" CHECK ("fairValueMinor" >= 0),
    -- The split is the whole rule, so the database holds it: the two halves
    -- always add to the movement, and neither is invented.
    CONSTRAINT "AssetRevaluation_split_check"
      CHECK ("toSurplusMinor" + "toProfitMinor" = "movementMinor"),
    CONSTRAINT "AssetRevaluation_movement_check"
      CHECK ("movementMinor" = "fairValueMinor" - "carryingBeforeMinor"),
    CONSTRAINT "AssetRevaluation_surplus_check" CHECK ("surplusAfterMinor" >= 0)
);
CREATE UNIQUE INDEX "AssetRevaluation_assetId_seq_key" ON "AssetRevaluation"("assetId","seq");
CREATE INDEX "AssetRevaluation_orgId_entityId_revaluedOn_idx"
  ON "AssetRevaluation"("orgId","entityId","revaluedOn");

-- The two accounts this needs, for books opened before now. The surplus is
-- equity because IAS 16.39 puts it in other comprehensive income, not profit.
INSERT INTO "Account" ("id","orgId","entityId","code","name","nameAr","type","subtype","parentId","isPostable","isControl","createdAt")
SELECT md5(random()::text || clock_timestamp()::text), b."orgId", b."entityId", v.code, v.name, v."nameAr", v.type, v.subtype,
       (SELECT p.id FROM "Account" p WHERE p."orgId" = b."orgId" AND p."entityId" = b."entityId" AND p."code" = v.parent),
       true, false, NOW()
FROM (SELECT DISTINCT "orgId", "entityId" FROM "Account") b
CROSS JOIN (VALUES
  ('3300','Revaluation surplus','فائض إعادة التقييم','EQUITY','REVALUATION_SURPLUS','3'),
  ('6650','Impairment losses','خسائر انخفاض القيمة','EXPENSE','IMPAIRMENT','6')
) AS v(code,name,"nameAr",type,subtype,parent)
WHERE NOT EXISTS (
  SELECT 1 FROM "Account" a
  WHERE a."orgId" = b."orgId" AND a."entityId" = b."entityId" AND a."code" = v.code
);
