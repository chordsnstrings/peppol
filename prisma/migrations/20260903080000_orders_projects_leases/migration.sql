-- Purchase orders, goods receipts, projects and leases.

CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "number" TEXT NOT NULL, "supplierName" TEXT NOT NULL, "supplierTrn" TEXT,
    "orderedOn" DATE NOT NULL, "expectedOn" DATE,
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "status" TEXT NOT NULL DEFAULT 'draft', "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PurchaseOrder_status_check"
      CHECK ("status" IN ('draft','open','part_received','received','closed','cancelled')),
    CONSTRAINT "PurchaseOrder_dates_check" CHECK ("expectedOn" IS NULL OR "expectedOn" >= "orderedOn")
);

CREATE TABLE "PurchaseOrderLine" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "orderId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL, "description" TEXT NOT NULL, "sku" TEXT,
    "quantityMilli" BIGINT NOT NULL, "unitPriceMinor" BIGINT NOT NULL,
    "accountCode" TEXT,
    "receivedMilli" BIGINT NOT NULL DEFAULT 0,
    "invoicedMilli" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id"),
    -- Ordering nothing is not an order, and a negative order is a return.
    CONSTRAINT "PurchaseOrderLine_qty_check" CHECK ("quantityMilli" > 0),
    CONSTRAINT "PurchaseOrderLine_price_check" CHECK ("unitPriceMinor" >= 0),
    -- Receiving or invoicing more than was ordered is the thing three-way
    -- matching exists to catch, so it cannot be recorded silently.
    CONSTRAINT "PurchaseOrderLine_received_check"
      CHECK ("receivedMilli" >= 0 AND "receivedMilli" <= "quantityMilli"),
    CONSTRAINT "PurchaseOrderLine_invoiced_check"
      CHECK ("invoicedMilli" >= 0 AND "invoicedMilli" <= "quantityMilli")
);

CREATE TABLE "GoodsReceipt" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL, "number" TEXT NOT NULL,
    "receivedOn" DATE NOT NULL, "entryId" TEXT, "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GoodsReceipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GoodsReceiptLine" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "receiptId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "quantityMilli" BIGINT NOT NULL, "valueMinor" BIGINT NOT NULL,
    CONSTRAINT "GoodsReceiptLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GoodsReceiptLine_qty_check" CHECK ("quantityMilli" > 0)
);

CREATE TABLE "Project" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL, "name" TEXT NOT NULL, "customerName" TEXT,
    "startsOn" DATE NOT NULL, "endsOn" DATE,
    "budgetMinor" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Project_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Project_status_check" CHECK ("status" IN ('active','on_hold','complete','cancelled')),
    CONSTRAINT "Project_dates_check" CHECK ("endsOn" IS NULL OR "endsOn" >= "startsOn"),
    CONSTRAINT "Project_budget_check" CHECK ("budgetMinor" >= 0)
);

CREATE TABLE "Lease" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL, "name" TEXT NOT NULL, "lessor" TEXT,
    "startsOn" DATE NOT NULL, "endsOn" DATE NOT NULL,
    "paymentMinor" BIGINT NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'MONTHLY',
    "discountRateBps" INTEGER NOT NULL,
    "initialLiabilityMinor" BIGINT NOT NULL DEFAULT 0,
    "initialRouMinor" BIGINT NOT NULL DEFAULT 0,
    "liabilityMinor" BIGINT NOT NULL DEFAULT 0,
    "accumRouDepMinor" BIGINT NOT NULL DEFAULT 0,
    "chargedTo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Lease_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Lease_frequency_check" CHECK ("frequency" IN ('MONTHLY','QUARTERLY','ANNUAL')),
    CONSTRAINT "Lease_status_check" CHECK ("status" IN ('draft','active','ended')),
    CONSTRAINT "Lease_dates_check" CHECK ("endsOn" > "startsOn"),
    CONSTRAINT "Lease_payment_check" CHECK ("paymentMinor" > 0),
    -- A negative discount rate would grow the liability by discounting it, and
    -- a rate above 100% a year is a data-entry error rather than a policy.
    CONSTRAINT "Lease_rate_check" CHECK ("discountRateBps" >= 0 AND "discountRateBps" <= 10000),
    CONSTRAINT "Lease_liability_check" CHECK ("liabilityMinor" >= 0),
    CONSTRAINT "Lease_period_check" CHECK ("chargedTo" IS NULL OR "chargedTo" ~ '^[0-9]{4}-[0-9]{2}$')
);

ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_receiptId_fkey"
  FOREIGN KEY ("receiptId") REFERENCES "GoodsReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "PurchaseOrder_orgId_entityId_number_key" ON "PurchaseOrder"("orgId","entityId","number");
CREATE INDEX "PurchaseOrder_orgId_entityId_status_idx" ON "PurchaseOrder"("orgId","entityId","status");
CREATE UNIQUE INDEX "PurchaseOrderLine_orderId_lineNo_key" ON "PurchaseOrderLine"("orderId","lineNo");
CREATE INDEX "PurchaseOrderLine_orgId_orderId_idx" ON "PurchaseOrderLine"("orgId","orderId");
CREATE UNIQUE INDEX "GoodsReceipt_orgId_entityId_number_key" ON "GoodsReceipt"("orgId","entityId","number");
CREATE INDEX "GoodsReceipt_orgId_orderId_idx" ON "GoodsReceipt"("orgId","orderId");
CREATE INDEX "GoodsReceiptLine_receiptId_idx" ON "GoodsReceiptLine"("receiptId");
CREATE UNIQUE INDEX "Project_orgId_entityId_code_key" ON "Project"("orgId","entityId","code");
CREATE INDEX "Project_orgId_entityId_status_idx" ON "Project"("orgId","entityId","status");
CREATE UNIQUE INDEX "Lease_orgId_entityId_code_key" ON "Lease"("orgId","entityId","code");
CREATE INDEX "Lease_orgId_entityId_status_idx" ON "Lease"("orgId","entityId","status");
