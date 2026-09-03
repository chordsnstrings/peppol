-- Landed cost.
--
-- IAS 2.10: the cost of inventories comprises the purchase price, import
-- duties and other non-recoverable taxes, transport, handling and other costs
-- directly attributable to the acquisition, less trade discounts and rebates.
--
-- Until now this product expensed the freight invoice. That understates
-- inventory and overstates cost of sales in the month the goods land, then
-- flatters the month they are sold, and the error is largest exactly when
-- stock is largest — which for most businesses is the year end. It is also
-- invisible: the freight sits in a cost-of-sales account looking perfectly
-- ordinary, and nothing anywhere says which goods it belonged to.
--
-- Three things this schema insists on.
--
-- A basis per charge, not per voucher. Freight follows weight or volume and
-- duty follows value; a single basis for a whole voucher is wrong for at least
-- one of the charges on it, and would be wrong silently.
--
-- The split of every share into what stayed on the shelf and what had already
-- been sold adds back to the share, checked by the database rather than by the
-- code that writes it. That is what makes the entry balance: the debits are
-- inventory plus cost of sales, and their sum is the charge being credited.
--
-- A cost-only movement. Value moves, quantity does not — which is exactly what
-- a freight invoice arriving three weeks after the container does.

-- ── The movement kind ────────────────────────────────────────────────────────
-- A landed cost is not a receipt (no goods arrived), not an adjustment (the
-- count did not change) and not a write-off. Recording it as one of those
-- would make every stock report lie about what happened.
ALTER TABLE "InventoryMovement" DROP CONSTRAINT "InventoryMovement_kind_check";
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_kind_check"
  CHECK ("kind" IN ('RECEIPT','ISSUE','ADJUSTMENT','WRITE_OFF','LANDED_COST'));

-- What makes it a landed cost rather than a receipt: no quantity moved. If it
-- ever did, the goods would have been counted in twice.
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_landed_cost_check"
  CHECK ("kind" <> 'LANDED_COST' OR "quantityMilli" = 0);

-- ── The voucher ──────────────────────────────────────────────────────────────
CREATE TABLE "LandedCostVoucher" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "shipmentRef" TEXT NOT NULL,
    "voucherDate" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "notes" TEXT,
    "appliedOn" DATE,
    "entryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LandedCostVoucher_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LandedCostVoucher_status_check"
      CHECK ("status" IN ('draft','applied','cancelled')),
    -- An applied voucher is one that reached the ledger. Without the entry it
    -- would be a claim that cost had been carried onto goods with nothing to
    -- show for it, and the stock would not tie to account 1200.
    CONSTRAINT "LandedCostVoucher_applied_check"
      CHECK ("status" <> 'applied' OR ("entryId" IS NOT NULL AND "appliedOn" IS NOT NULL))
);
CREATE UNIQUE INDEX "LandedCostVoucher_orgId_entityId_number_key"
  ON "LandedCostVoucher"("orgId","entityId","number");
CREATE INDEX "LandedCostVoucher_orgId_entityId_status_idx"
  ON "LandedCostVoucher"("orgId","entityId","status");
CREATE INDEX "LandedCostVoucher_orgId_entityId_shipmentRef_idx"
  ON "LandedCostVoucher"("orgId","entityId","shipmentRef");

-- ── The charges ──────────────────────────────────────────────────────────────
CREATE TABLE "LandedCostCharge" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "basis" TEXT NOT NULL DEFAULT 'VALUE',
    CONSTRAINT "LandedCostCharge_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LandedCostCharge_voucher_fkey" FOREIGN KEY ("voucherId")
      REFERENCES "LandedCostVoucher"("id") ON DELETE CASCADE,
    -- Nothing to spread is not a charge, and a negative one is a credit note
    -- against the supplier — a different document with a different signature.
    CONSTRAINT "LandedCostCharge_amount_check" CHECK ("amountMinor" > 0),
    CONSTRAINT "LandedCostCharge_basis_check"
      CHECK ("basis" IN ('VALUE','QUANTITY','WEIGHT','VOLUME'))
);
CREATE UNIQUE INDEX "LandedCostCharge_voucherId_lineNo_key"
  ON "LandedCostCharge"("voucherId","lineNo");
CREATE INDEX "LandedCostCharge_orgId_voucherId_idx" ON "LandedCostCharge"("orgId","voucherId");

-- ── The goods ────────────────────────────────────────────────────────────────
CREATE TABLE "LandedCostLine" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "itemId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "receiptRef" TEXT NOT NULL,
    "movementId" TEXT NOT NULL,
    "quantityMilli" BIGINT NOT NULL,
    "valueMinor" BIGINT NOT NULL,
    "weightMilli" BIGINT,
    "volumeMilli" BIGINT,
    "onHandMilli" BIGINT,
    "allocatedMinor" BIGINT,
    "inventoryMinor" BIGINT,
    "cogsMinor" BIGINT,
    CONSTRAINT "LandedCostLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LandedCostLine_voucher_fkey" FOREIGN KEY ("voucherId")
      REFERENCES "LandedCostVoucher"("id") ON DELETE CASCADE,
    CONSTRAINT "LandedCostLine_quantity_check" CHECK ("quantityMilli" > 0),
    CONSTRAINT "LandedCostLine_value_check" CHECK ("valueMinor" >= 0),
    -- A weight of nothing on a line is not a measurement; it is a way of
    -- getting a free ride on a freight bill. Nil says nobody recorded one,
    -- which the allocation refuses out loud.
    CONSTRAINT "LandedCostLine_weight_check" CHECK ("weightMilli" IS NULL OR "weightMilli" > 0),
    CONSTRAINT "LandedCostLine_volume_check" CHECK ("volumeMilli" IS NULL OR "volumeMilli" > 0),
    CONSTRAINT "LandedCostLine_onhand_check"
      CHECK ("onHandMilli" IS NULL OR ("onHandMilli" >= 0 AND "onHandMilli" <= "quantityMilli")),
    -- What was carried onto the goods splits into the part still on the shelf
    -- and the part already sold, and the two add back to it exactly.
    CONSTRAINT "LandedCostLine_split_check"
      CHECK ("allocatedMinor" IS NULL
             OR ("inventoryMinor" + "cogsMinor" = "allocatedMinor"
                 AND "inventoryMinor" >= 0 AND "cogsMinor" >= 0))
);
CREATE UNIQUE INDEX "LandedCostLine_voucherId_lineNo_key" ON "LandedCostLine"("voucherId","lineNo");
CREATE INDEX "LandedCostLine_orgId_voucherId_idx" ON "LandedCostLine"("orgId","voucherId");
CREATE INDEX "LandedCostLine_orgId_itemId_idx" ON "LandedCostLine"("orgId","itemId");

-- ── What each charge put on each lot ─────────────────────────────────────────
CREATE TABLE "LandedCostAllocation" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "chargeId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "basisWeight" BIGINT NOT NULL,
    "allocatedMinor" BIGINT NOT NULL,
    "inventoryMinor" BIGINT NOT NULL,
    "cogsMinor" BIGINT NOT NULL,
    CONSTRAINT "LandedCostAllocation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LandedCostAllocation_voucher_fkey" FOREIGN KEY ("voucherId")
      REFERENCES "LandedCostVoucher"("id") ON DELETE CASCADE,
    CONSTRAINT "LandedCostAllocation_charge_fkey" FOREIGN KEY ("chargeId")
      REFERENCES "LandedCostCharge"("id") ON DELETE CASCADE,
    CONSTRAINT "LandedCostAllocation_line_fkey" FOREIGN KEY ("lineId")
      REFERENCES "LandedCostLine"("id") ON DELETE CASCADE,
    -- Largest-remainder allocation never produces a negative share, and the
    -- database says so rather than trusting that it never will.
    CONSTRAINT "LandedCostAllocation_share_check" CHECK ("allocatedMinor" >= 0 AND "basisWeight" >= 0),
    CONSTRAINT "LandedCostAllocation_split_check"
      CHECK ("inventoryMinor" + "cogsMinor" = "allocatedMinor"
             AND "inventoryMinor" >= 0 AND "cogsMinor" >= 0)
);
CREATE UNIQUE INDEX "LandedCostAllocation_chargeId_lineId_key"
  ON "LandedCostAllocation"("chargeId","lineId");
CREATE INDEX "LandedCostAllocation_orgId_voucherId_idx" ON "LandedCostAllocation"("orgId","voucherId");

-- ── What a unit weighs and how much room it takes ────────────────────────────
CREATE TABLE "LandedCostMeasure" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "unitWeightMilli" BIGINT,
    "unitVolumeMilli" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LandedCostMeasure_pkey" PRIMARY KEY ("id"),
    -- Grams and litres per whole unit. A weight of nothing is not a weight,
    -- and recording one would be the same free ride the nil case is refused for.
    CONSTRAINT "LandedCostMeasure_weight_check"
      CHECK ("unitWeightMilli" IS NULL OR "unitWeightMilli" > 0),
    CONSTRAINT "LandedCostMeasure_volume_check"
      CHECK ("unitVolumeMilli" IS NULL OR "unitVolumeMilli" > 0)
);
CREATE UNIQUE INDEX "LandedCostMeasure_orgId_entityId_itemId_key"
  ON "LandedCostMeasure"("orgId","entityId","itemId");
CREATE INDEX "LandedCostMeasure_orgId_entityId_idx" ON "LandedCostMeasure"("orgId","entityId");
