-- Sales orders and quotations, petty cash floats, and saved report layouts.

CREATE TABLE "SalesOrder" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'QUOTE',
    "customerCode" TEXT, "customerName" TEXT NOT NULL, "customerTrn" TEXT,
    "issuedOn" DATE NOT NULL, "validUntil" DATE,
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SalesOrder_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SalesOrder_kind_check" CHECK ("kind" IN ('QUOTE','ORDER')),
    CONSTRAINT "SalesOrder_status_check" CHECK ("status" IN
        ('draft','sent','accepted','part_invoiced','invoiced','declined','expired','cancelled')),
    -- An offer that expires before it is made is not an offer.
    CONSTRAINT "SalesOrder_valid_check" CHECK ("validUntil" IS NULL OR "validUntil" >= "issuedOn"),
    -- Only a quote expires. An order that has been accepted stays accepted.
    CONSTRAINT "SalesOrder_expiry_kind_check" CHECK ("status" <> 'expired' OR "kind" = 'QUOTE')
);
CREATE UNIQUE INDEX "SalesOrder_orgId_entityId_number_key" ON "SalesOrder"("orgId","entityId","number");
CREATE INDEX "SalesOrder_orgId_entityId_status_idx" ON "SalesOrder"("orgId","entityId","status");

CREATE TABLE "SalesOrderLine" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "orderId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL, "description" TEXT NOT NULL, "sku" TEXT,
    "quantityMilli" BIGINT NOT NULL, "unitPriceMinor" BIGINT NOT NULL,
    "discountBps" INTEGER NOT NULL DEFAULT 0,
    "taxCode" TEXT NOT NULL DEFAULT 'SR',
    "accountCode" TEXT,
    "invoicedMilli" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "SalesOrderLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SalesOrderLine_orderId_fkey" FOREIGN KEY ("orderId")
        REFERENCES "SalesOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SalesOrderLine_qty_check" CHECK ("quantityMilli" > 0),
    CONSTRAINT "SalesOrderLine_price_check" CHECK ("unitPriceMinor" >= 0),
    -- A discount over the whole line would invert the price.
    CONSTRAINT "SalesOrderLine_discount_check" CHECK ("discountBps" >= 0 AND "discountBps" <= 10000),
    -- You cannot invoice more than was ordered.
    CONSTRAINT "SalesOrderLine_invoiced_check"
        CHECK ("invoicedMilli" >= 0 AND "invoicedMilli" <= "quantityMilli")
);
CREATE UNIQUE INDEX "SalesOrderLine_orderId_lineNo_key" ON "SalesOrderLine"("orderId","lineNo");
CREATE INDEX "SalesOrderLine_orgId_orderId_idx" ON "SalesOrderLine"("orgId","orderId");

CREATE TABLE "PettyCashFund" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL, "name" TEXT NOT NULL, "custodian" TEXT NOT NULL,
    "floatMinor" BIGINT NOT NULL,
    "accountCode" TEXT NOT NULL DEFAULT '1020',
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PettyCashFund_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PettyCashFund_status_check" CHECK ("status" IN ('active','closed')),
    -- An imprest float of nothing is not a float.
    CONSTRAINT "PettyCashFund_float_check" CHECK ("floatMinor" > 0)
);
CREATE UNIQUE INDEX "PettyCashFund_orgId_entityId_code_key" ON "PettyCashFund"("orgId","entityId","code");
CREATE INDEX "PettyCashFund_orgId_entityId_status_idx" ON "PettyCashFund"("orgId","entityId","status");

CREATE TABLE "PettyCashMovement" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "fundId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL, "kind" TEXT NOT NULL,
    "movedOn" DATE NOT NULL, "description" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "accountCode" TEXT, "vatMinor" BIGINT NOT NULL DEFAULT 0,
    "supplierTrn" TEXT, "receiptRef" TEXT, "entryId" TEXT,
    CONSTRAINT "PettyCashMovement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PettyCashMovement_fundId_fkey" FOREIGN KEY ("fundId")
        REFERENCES "PettyCashFund"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PettyCashMovement_kind_check"
        CHECK ("kind" IN ('OPENING','SPEND','REIMBURSE','RETURN')),
    -- The kind carries the direction, so the amount is always a magnitude.
    CONSTRAINT "PettyCashMovement_amount_check" CHECK ("amountMinor" > 0),
    -- Only a spend has an expense account and recoverable input tax behind it.
    CONSTRAINT "PettyCashMovement_spend_check"
        CHECK ("kind" = 'SPEND' OR ("accountCode" IS NULL AND "vatMinor" = 0)),
    CONSTRAINT "PettyCashMovement_vat_check" CHECK ("vatMinor" >= 0 AND "vatMinor" <= "amountMinor")
);
CREATE UNIQUE INDEX "PettyCashMovement_fundId_seq_key" ON "PettyCashMovement"("fundId","seq");
CREATE INDEX "PettyCashMovement_orgId_fundId_idx" ON "PettyCashMovement"("orgId","fundId");

CREATE TABLE "ReportLayout" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL, "name" TEXT NOT NULL,
    "basis" TEXT NOT NULL DEFAULT 'PROFIT',
    "rows" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReportLayout_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReportLayout_basis_check" CHECK ("basis" IN ('BALANCE','PROFIT')),
    CONSTRAINT "ReportLayout_status_check" CHECK ("status" IN ('active','archived')),
    -- A layout with no rows renders an empty page and looks like a bug.
    CONSTRAINT "ReportLayout_rows_check" CHECK (jsonb_array_length("rows") > 0)
);
CREATE UNIQUE INDEX "ReportLayout_orgId_entityId_code_key" ON "ReportLayout"("orgId","entityId","code");
CREATE INDEX "ReportLayout_orgId_entityId_status_idx" ON "ReportLayout"("orgId","entityId","status");
