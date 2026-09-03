-- Inventory, valued at weighted average cost.
--
-- Quantity and value are carried on the item rather than summed from the
-- movements. Weighted average cost depends on the order receipts and issues
-- actually happened in, so it cannot be re-derived from a set of rows without
-- replaying them — and replaying them would let a receipt entered late silently
-- rewrite the cost of goods that were already sold and already reported.
--
-- Movements are append-only for the same reason a posted journal entry is: a
-- correction is another movement, so the record of what was believed at the
-- time survives.
CREATE TABLE "InventoryItem" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "uom" TEXT NOT NULL DEFAULT 'EA',
    "costMethod" TEXT NOT NULL DEFAULT 'WEIGHTED_AVERAGE',
    "quantityMilli" BIGINT NOT NULL DEFAULT 0,
    "valueMinor" BIGINT NOT NULL DEFAULT 0,
    "stockAccount" TEXT NOT NULL DEFAULT '1200',
    "cogsAccount" TEXT NOT NULL DEFAULT '5000',
    "varianceAccount" TEXT NOT NULL DEFAULT '5300',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "InventoryItem_method_check"
      CHECK ("costMethod" IN ('WEIGHTED_AVERAGE','STANDARD')),
    CONSTRAINT "InventoryItem_status_check"
      CHECK ("status" IN ('active','archived')),
    -- Negative stock is almost always a missing receipt rather than a real
    -- position, and letting it through means issuing goods at a cost nobody
    -- has established. Refused at the table so no code path can create it.
    CONSTRAINT "InventoryItem_quantity_check" CHECK ("quantityMilli" >= 0),
    -- Stock cannot be worth a negative amount.
    CONSTRAINT "InventoryItem_value_check" CHECK ("valueMinor" >= 0),
    -- Value without quantity is stranded cost that will never reach the profit
    -- and loss; quantity without value is stock that will be issued for free.
    CONSTRAINT "InventoryItem_consistent_check"
      CHECK (("quantityMilli" = 0) = ("valueMinor" = 0))
);

CREATE TABLE "InventoryMovement" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "movedOn" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "quantityMilli" BIGINT NOT NULL,
    "valueMinor" BIGINT NOT NULL,
    "unitCostMinor" BIGINT NOT NULL,
    "balanceQtyMilli" BIGINT NOT NULL,
    "balanceValueMinor" BIGINT NOT NULL,
    "reference" TEXT,
    "memo" TEXT,
    "entryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "InventoryMovement_kind_check"
      CHECK ("kind" IN ('RECEIPT','ISSUE','ADJUSTMENT','WRITE_OFF')),
    -- A movement of nothing is not a movement.
    CONSTRAINT "InventoryMovement_nonzero_check"
      CHECK ("quantityMilli" <> 0 OR "valueMinor" <> 0)
);

ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "InventoryItem_orgId_entityId_sku_key" ON "InventoryItem"("orgId", "entityId", "sku");
CREATE INDEX "InventoryItem_orgId_entityId_status_idx" ON "InventoryItem"("orgId", "entityId", "status");
CREATE INDEX "InventoryMovement_orgId_itemId_movedOn_idx" ON "InventoryMovement"("orgId", "itemId", "movedOn");
CREATE INDEX "InventoryMovement_entryId_idx" ON "InventoryMovement"("entryId");
