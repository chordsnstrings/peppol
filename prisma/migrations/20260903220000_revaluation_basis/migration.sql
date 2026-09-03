-- Two facts a revaluation needs and the register could not hold.
--
-- 1. Depreciation after a revaluation is charged on the revalued amount over
--    the REMAINING life (IAS 16.31). The register restates cost and clears
--    accumulated depreciation, but it dates depreciation from the acquisition,
--    so without knowing when the current basis started it would spread the new
--    amount over the original life again and quietly extend the asset's life
--    by however long it had already run.
--
-- 2. The IAS 36.117 ceiling — what the asset would be carried at had no
--    impairment been recognised — depreciates over the life that remained when
--    the impairment happened. The register no longer holds that afterwards, so
--    the event records it.

ALTER TABLE "FixedAsset" ADD COLUMN "basisFrom" DATE;
ALTER TABLE "AssetRevaluation" ADD COLUMN "lifeRemainingMonths" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "AssetRevaluation" ADD CONSTRAINT "AssetRevaluation_life_check"
  CHECK ("lifeRemainingMonths" >= 0);
