-- FIFO costing and net realisable value.
--
-- Weighted average carries one cost per item and needs no history: the average
-- after each movement is enough to value what is left. First-in-first-out
-- cannot be reconstructed from that — an average discards which receipt each
-- unit came from, and that is exactly what FIFO needs to know. So the layers
-- are the record, not a cache of one.

ALTER TABLE "InventoryItem" ADD COLUMN "nrvMinor" BIGINT;

-- IAS 2.9 carries stock at the lower of cost and net realisable value. A NULL
-- means nobody has assessed it, which is a different fact from an assessment
-- of nothing, so the column is nullable rather than defaulted to zero.
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_nrv_check"
  CHECK ("nrvMinor" IS NULL OR "nrvMinor" >= 0);

ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_costMethod_check"
  CHECK ("costMethod" IN ('WEIGHTED_AVERAGE','FIFO'));

CREATE TABLE "InventoryLayer" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "itemId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "receivedOn" DATE NOT NULL,
    "quantityMilli" BIGINT NOT NULL,
    "remainingMilli" BIGINT NOT NULL,
    "unitCostMinor" BIGINT NOT NULL,
    "movementId" TEXT,
    CONSTRAINT "InventoryLayer_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "InventoryLayer_itemId_fkey" FOREIGN KEY ("itemId")
      REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "InventoryLayer_quantity_check" CHECK ("quantityMilli" > 0),
    -- A layer cannot have more left than came in, and cannot go negative:
    -- issuing more than a layer holds means the next layer is consumed, not
    -- that this one owes stock.
    CONSTRAINT "InventoryLayer_remaining_check"
      CHECK ("remainingMilli" >= 0 AND "remainingMilli" <= "quantityMilli"),
    CONSTRAINT "InventoryLayer_cost_check" CHECK ("unitCostMinor" >= 0)
);
CREATE UNIQUE INDEX "InventoryLayer_itemId_seq_key" ON "InventoryLayer"("itemId","seq");
CREATE INDEX "InventoryLayer_orgId_itemId_receivedOn_idx" ON "InventoryLayer"("orgId","itemId","receivedOn");

-- Every item that exists today is on weighted average and has no layers, which
-- is correct: switching an item to FIFO mid-life would need a cost per unit for
-- stock already on hand, and the only honest source for that is a stock count.
