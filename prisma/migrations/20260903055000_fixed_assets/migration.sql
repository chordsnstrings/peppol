-- Fixed assets.
--
-- The register is deliberately not derivable from the ledger: an asset's useful
-- life, method and residual value are estimates a person made, and the ledger
-- records only their consequences. Keeping them here is what lets the two be
-- compared — a register that disagrees with account 1500 is a finding, and it
-- can only be a finding if they are separate records.
--
-- `accumulatedMinor` and `depreciatedTo` are carried on the row rather than
-- recomputed. A schedule that recalculates history would rewrite prior periods
-- every time an estimate changed, and under IAS 16 a change in estimate is
-- prospective, not retrospective.
CREATE TABLE "FixedAsset" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "category" TEXT NOT NULL DEFAULT 'EQUIPMENT',
    "acquiredOn" DATE NOT NULL,
    "costMinor" BIGINT NOT NULL,
    "residualMinor" BIGINT NOT NULL DEFAULT 0,
    "method" TEXT NOT NULL DEFAULT 'STRAIGHT_LINE',
    "usefulLifeMonths" INTEGER NOT NULL,
    "ratePercent" DECIMAL(6,3),
    "assetAccount" TEXT NOT NULL DEFAULT '1500',
    "accumAccount" TEXT NOT NULL DEFAULT '1590',
    "expenseAccount" TEXT NOT NULL DEFAULT '6600',
    "accumulatedMinor" BIGINT NOT NULL DEFAULT 0,
    "depreciatedTo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "disposedOn" DATE,
    "proceedsMinor" BIGINT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FixedAsset_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FixedAsset_method_check"
      CHECK ("method" IN ('STRAIGHT_LINE','REDUCING_BALANCE')),
    CONSTRAINT "FixedAsset_status_check"
      CHECK ("status" IN ('active','disposed','written_off')),
    -- An asset that cost nothing is not an asset, and a negative cost is a
    -- credit note that has been filed in the wrong place.
    CONSTRAINT "FixedAsset_cost_check" CHECK ("costMinor" > 0),
    -- Residual above cost would depreciate upwards.
    CONSTRAINT "FixedAsset_residual_check"
      CHECK ("residualMinor" >= 0 AND "residualMinor" <= "costMinor"),
    CONSTRAINT "FixedAsset_life_check" CHECK ("usefulLifeMonths" > 0),
    -- Depreciation can never exceed the depreciable amount. This is the
    -- invariant the whole schedule exists to respect, so the database holds it
    -- rather than trusting every code path that writes here.
    CONSTRAINT "FixedAsset_accumulated_check"
      CHECK ("accumulatedMinor" >= 0 AND "accumulatedMinor" <= "costMinor" - "residualMinor"),
    -- Reducing balance needs a rate; straight line must not carry one.
    CONSTRAINT "FixedAsset_rate_check"
      CHECK (("method" = 'REDUCING_BALANCE') = ("ratePercent" IS NOT NULL)),
    -- A disposed asset records when, and nothing else may.
    CONSTRAINT "FixedAsset_disposal_check"
      CHECK (("status" = 'active') = ("disposedOn" IS NULL))
);

CREATE UNIQUE INDEX "FixedAsset_orgId_entityId_code_key" ON "FixedAsset"("orgId", "entityId", "code");
CREATE INDEX "FixedAsset_orgId_entityId_status_idx" ON "FixedAsset"("orgId", "entityId", "status");
