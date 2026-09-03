-- Delivery notes.
--
-- Between an order and an invoice there is a lorry, and until now the product
-- had nowhere to record it. That gap is not cosmetic: goods delivered and not
-- yet invoiced are revenue a distribution business has earned and cannot see,
-- and the cost of them has already left inventory. A business that cannot list
-- them is guessing at its own margin every month end.
--
-- A delivery note is a document, not a journal. Dispatching moves cost out of
-- inventory through the ordinary issue path; the revenue stays on the invoice.
-- The two are separate events on purpose — conflating them is what produces a
-- ledger where the stock is gone and nobody was ever billed.

CREATE TABLE "DeliveryNote" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "orderId" TEXT,
    "customerName" TEXT NOT NULL,
    "deliveredOn" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "carrier" TEXT,
    "trackingRef" TEXT,
    "signedBy" TEXT,
    "signedOn" DATE,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DeliveryNote_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DeliveryNote_status_check"
      CHECK ("status" IN ('draft','dispatched','delivered','cancelled')),
    -- A signature belongs to a delivery, not to a piece of paper somebody is
    -- still typing. Signing a draft would let a note be signed for goods that
    -- never left.
    CONSTRAINT "DeliveryNote_signed_check"
      CHECK ("signedBy" IS NULL OR "status" IN ('delivered','dispatched')),
    CONSTRAINT "DeliveryNote_signed_date_check"
      CHECK (("signedBy" IS NULL) = ("signedOn" IS NULL))
);
CREATE UNIQUE INDEX "DeliveryNote_orgId_entityId_number_key"
  ON "DeliveryNote"("orgId","entityId","number");
CREATE INDEX "DeliveryNote_orgId_entityId_deliveredOn_idx"
  ON "DeliveryNote"("orgId","entityId","deliveredOn");
CREATE INDEX "DeliveryNote_orgId_orderId_idx" ON "DeliveryNote"("orgId","orderId");

CREATE TABLE "DeliveryNoteLine" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "orderLineId" TEXT,
    "sku" TEXT,
    "description" TEXT NOT NULL,
    "quantityMilli" BIGINT NOT NULL,
    "costMinor" BIGINT,
    "movementId" TEXT,
    CONSTRAINT "DeliveryNoteLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DeliveryNoteLine_note_fkey" FOREIGN KEY ("noteId")
      REFERENCES "DeliveryNote"("id") ON DELETE CASCADE,
    -- Delivering nothing is not a delivery, and delivering a negative quantity
    -- is a return, which is a different document with a different signature.
    CONSTRAINT "DeliveryNoteLine_quantity_check" CHECK ("quantityMilli" > 0),
    CONSTRAINT "DeliveryNoteLine_cost_check" CHECK ("costMinor" IS NULL OR "costMinor" >= 0),
    -- A cost without the movement that produced it cannot be traced back to
    -- the stock it came out of, which is the only thing that makes it
    -- defensible.
    CONSTRAINT "DeliveryNoteLine_movement_check"
      CHECK ("costMinor" IS NULL OR "movementId" IS NOT NULL)
);
CREATE UNIQUE INDEX "DeliveryNoteLine_noteId_lineNo_key" ON "DeliveryNoteLine"("noteId","lineNo");
CREATE INDEX "DeliveryNoteLine_orgId_noteId_idx" ON "DeliveryNoteLine"("orgId","noteId");
CREATE INDEX "DeliveryNoteLine_orgId_orderLineId_idx" ON "DeliveryNoteLine"("orgId","orderLineId");
