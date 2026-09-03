-- Post-dated cheques, stock locations and batches, and the VAT capital assets
-- scheme.

-- ── Cheques ──────────────────────────────────────────────────────────────
-- A cheque in the drawer is not cash and not quite a receivable either: it is
-- a receivable whose form has changed. The register carries it from the day it
-- is taken to the day it clears or bounces, because those are different events
-- with different journals — and a system that models only the last one cannot
-- say where the money is today.
CREATE TABLE "Cheque" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "number" TEXT NOT NULL, "bankName" TEXT,
    "bankAccount" TEXT NOT NULL DEFAULT '1010',
    "counterparty" TEXT NOT NULL, "counterpartyId" TEXT,
    "writtenOn" DATE NOT NULL, "dueOn" DATE NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "status" TEXT NOT NULL DEFAULT 'held',
    "settlesId" TEXT,
    "heldEntryId" TEXT, "clearedEntryId" TEXT, "bouncedEntryId" TEXT,
    "statusOn" DATE, "bounceReason" TEXT, "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Cheque_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Cheque_direction_check" CHECK ("direction" IN ('RECEIVED','ISSUED')),
    CONSTRAINT "Cheque_status_check"
      CHECK ("status" IN ('held','deposited','cleared','bounced','returned','cancelled')),
    CONSTRAINT "Cheque_amount_check" CHECK ("amountMinor" > 0),
    -- A cheque cannot fall due before it was written. Post-dated is the point;
    -- ante-dated is a typo, and it would present immediately.
    CONSTRAINT "Cheque_dates_check" CHECK ("dueOn" >= "writtenOn"),
    -- A bounce has to say why. "Returned" with no reason is a dead end for
    -- whoever has to decide whether to re-present it or sue.
    CONSTRAINT "Cheque_bounce_check" CHECK ("status" <> 'bounced' OR "bounceReason" IS NOT NULL),
    -- A cleared cheque names the entry that moved the money, so it can always
    -- be traced back to the bank.
    CONSTRAINT "Cheque_cleared_check"
      CHECK ("status" <> 'cleared' OR ("clearedEntryId" IS NOT NULL AND "statusOn" IS NOT NULL))
);
CREATE UNIQUE INDEX "Cheque_orgId_entityId_direction_number_key"
  ON "Cheque"("orgId","entityId","direction","number");
CREATE INDEX "Cheque_orgId_entityId_status_dueOn_idx" ON "Cheque"("orgId","entityId","status","dueOn");

-- ── Stock locations and batches ──────────────────────────────────────────
CREATE TABLE "StockLocation" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL, "name" TEXT NOT NULL, "nameAr" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "address" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StockLocation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StockLocation_status_check" CHECK ("status" IN ('active','closed'))
);
CREATE UNIQUE INDEX "StockLocation_orgId_entityId_code_key" ON "StockLocation"("orgId","entityId","code");
CREATE INDEX "StockLocation_orgId_entityId_status_idx" ON "StockLocation"("orgId","entityId","status");
-- One default, or none. Two would make "where did it go" ambiguous exactly
-- when nobody said, which is the case the default exists for.
CREATE UNIQUE INDEX "StockLocation_one_default"
  ON "StockLocation"("orgId","entityId") WHERE "isDefault";

CREATE TABLE "StockBatch" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL, "locationId" TEXT,
    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'BATCH',
    "receivedOn" DATE NOT NULL, "expiresOn" DATE,
    "quantityMilli" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StockBatch_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StockBatch_itemId_fkey" FOREIGN KEY ("itemId")
      REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockBatch_kind_check" CHECK ("kind" IN ('BATCH','SERIAL')),
    CONSTRAINT "StockBatch_status_check" CHECK ("status" IN ('active','consumed','expired','quarantined')),
    -- Stock cannot go negative in a batch: taking more than a batch holds means
    -- the next batch is being consumed, not that this one owes goods.
    CONSTRAINT "StockBatch_quantity_check" CHECK ("quantityMilli" >= 0),
    -- A serial number is one unit by definition. Two would make the number
    -- identify two things, which is the one thing a serial must not do.
    CONSTRAINT "StockBatch_serial_check"
      CHECK ("kind" <> 'SERIAL' OR "quantityMilli" IN (0, 1000)),
    CONSTRAINT "StockBatch_expiry_check" CHECK ("expiresOn" IS NULL OR "expiresOn" >= "receivedOn")
);
CREATE UNIQUE INDEX "StockBatch_orgId_entityId_itemId_code_key"
  ON "StockBatch"("orgId","entityId","itemId","code");
CREATE INDEX "StockBatch_orgId_entityId_expiresOn_idx" ON "StockBatch"("orgId","entityId","expiresOn");

ALTER TABLE "InventoryItem"
  ADD COLUMN "reorderLevelMilli" BIGINT,
  ADD COLUMN "defaultLocationId" TEXT;
-- Nil means nobody has set a level, which is a different fact from a level of
-- nothing — and a level of nothing means "tell me the moment it runs out".
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_reorder_check"
  CHECK ("reorderLevelMilli" IS NULL OR "reorderLevelMilli" >= 0);

ALTER TABLE "InventoryMovement"
  ADD COLUMN "locationId" TEXT,
  ADD COLUMN "batchId" TEXT;

-- ── VAT capital assets scheme ────────────────────────────────────────────
-- Input tax recovered on a capital asset is adjusted over ten years for a
-- building and five for anything else, as the proportion of taxable use
-- changes. It is the single most-missed obligation in UAE VAT, because it
-- falls due years after the purchase everyone has forgotten about.
CREATE TABLE "CapitalAssetItem" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL, "description" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'OTHER',
    "acquiredOn" DATE NOT NULL, "firstUsedOn" DATE NOT NULL,
    "costMinor" BIGINT NOT NULL,
    "inputTaxMinor" BIGINT NOT NULL,
    "originalUseBps" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CapitalAssetItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CapitalAssetItem_category_check" CHECK ("category" IN ('BUILDING','OTHER')),
    CONSTRAINT "CapitalAssetItem_status_check" CHECK ("status" IN ('active','disposed','ended')),
    CONSTRAINT "CapitalAssetItem_cost_check" CHECK ("costMinor" > 0),
    CONSTRAINT "CapitalAssetItem_tax_check" CHECK ("inputTaxMinor" >= 0),
    -- A proportion outside nought to a hundred percent is a typo, and the
    -- adjustment computed from one is wrong by orders of magnitude.
    CONSTRAINT "CapitalAssetItem_use_check"
      CHECK ("originalUseBps" >= 0 AND "originalUseBps" <= 10000),
    -- The adjustment period starts from first use, which cannot precede the
    -- purchase.
    CONSTRAINT "CapitalAssetItem_dates_check" CHECK ("firstUsedOn" >= "acquiredOn")
);
CREATE UNIQUE INDEX "CapitalAssetItem_orgId_entityId_code_key"
  ON "CapitalAssetItem"("orgId","entityId","code");
CREATE INDEX "CapitalAssetItem_orgId_entityId_status_idx" ON "CapitalAssetItem"("orgId","entityId","status");

CREATE TABLE "CapitalAssetAdjustment" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "assetId" TEXT NOT NULL,
    "interval" INTEGER NOT NULL,
    "assessedOn" DATE NOT NULL,
    "useBps" INTEGER NOT NULL,
    "adjustmentMinor" BIGINT NOT NULL,
    "entryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CapitalAssetAdjustment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CapitalAssetAdjustment_assetId_fkey" FOREIGN KEY ("assetId")
      REFERENCES "CapitalAssetItem"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    -- Ten intervals for a building, five for anything else; the module holds
    -- which, the database holds that it is one of them.
    CONSTRAINT "CapitalAssetAdjustment_interval_check"
      CHECK ("interval" >= 1 AND "interval" <= 10),
    CONSTRAINT "CapitalAssetAdjustment_use_check"
      CHECK ("useBps" >= 0 AND "useBps" <= 10000)
);
CREATE UNIQUE INDEX "CapitalAssetAdjustment_assetId_interval_key"
  ON "CapitalAssetAdjustment"("assetId","interval");
CREATE INDEX "CapitalAssetAdjustment_orgId_assetId_idx" ON "CapitalAssetAdjustment"("orgId","assetId");
