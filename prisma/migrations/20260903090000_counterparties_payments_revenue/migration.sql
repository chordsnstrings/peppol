-- Counterparties, payment runs and revenue contracts.

CREATE TABLE "Counterparty" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL, "name" TEXT NOT NULL, "nameAr" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "trn" TEXT, "email" TEXT, "phone" TEXT,
    "paymentTerms" INTEGER NOT NULL DEFAULT 30,
    "creditLimitMinor" BIGINT,
    "onHold" BOOLEAN NOT NULL DEFAULT false, "holdReason" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'AED', "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Counterparty_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Counterparty_kind_check" CHECK ("kind" IN ('CUSTOMER','SUPPLIER','BOTH')),
    CONSTRAINT "Counterparty_status_check" CHECK ("status" IN ('active','archived')),
    -- Negative terms would make an invoice due before it was raised.
    CONSTRAINT "Counterparty_terms_check" CHECK ("paymentTerms" >= 0 AND "paymentTerms" <= 365),
    CONSTRAINT "Counterparty_limit_check" CHECK ("creditLimitMinor" IS NULL OR "creditLimitMinor" >= 0),
    -- A hold has to say why. "On hold" with no reason is a dead end for
    -- whoever has to decide whether to release it.
    CONSTRAINT "Counterparty_hold_check" CHECK (NOT "onHold" OR "holdReason" IS NOT NULL)
);

CREATE TABLE "PaymentRun" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "reference" TEXT NOT NULL, "runDate" DATE NOT NULL,
    "bankAccount" TEXT NOT NULL DEFAULT '1010',
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "approvedBy" TEXT, "approvedAt" TIMESTAMP(3), "releasedAt" TIMESTAMP(3),
    "entryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaymentRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PaymentRun_status_check" CHECK ("status" IN ('draft','approved','released','cancelled')),
    -- Money cannot leave without someone having approved it, and a released
    -- run must name the entry that moved it.
    CONSTRAINT "PaymentRun_approval_check"
      CHECK ("status" NOT IN ('approved','released') OR ("approvedBy" IS NOT NULL AND "approvedAt" IS NOT NULL)),
    CONSTRAINT "PaymentRun_release_check"
      CHECK ("status" <> 'released' OR ("entryId" IS NOT NULL AND "releasedAt" IS NOT NULL))
);

CREATE TABLE "PaymentRunItem" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "runId" TEXT NOT NULL,
    "billId" TEXT, "billNumber" TEXT NOT NULL, "supplierName" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "excluded" BOOLEAN NOT NULL DEFAULT false, "excludeReason" TEXT,
    CONSTRAINT "PaymentRunItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PaymentRunItem_amount_check" CHECK ("amountMinor" > 0),
    -- Something dropped from a payment run without a reason is something the
    -- supplier will chase and nobody can explain.
    CONSTRAINT "PaymentRunItem_exclude_check" CHECK (NOT "excluded" OR "excludeReason" IS NOT NULL)
);

CREATE TABLE "RevenueContract" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL, "customerName" TEXT NOT NULL,
    "signedOn" DATE NOT NULL, "priceMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RevenueContract_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RevenueContract_status_check" CHECK ("status" IN ('active','complete','cancelled')),
    CONSTRAINT "RevenueContract_price_check" CHECK ("priceMinor" > 0)
);

CREATE TABLE "PerformanceObligation" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "contractId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL, "description" TEXT NOT NULL,
    "standalonePriceMinor" BIGINT NOT NULL,
    "allocatedMinor" BIGINT NOT NULL DEFAULT 0,
    "timing" TEXT NOT NULL DEFAULT 'POINT_IN_TIME',
    "recognisedMinor" BIGINT NOT NULL DEFAULT 0,
    "progressBps" INTEGER NOT NULL DEFAULT 0,
    "satisfiedOn" DATE,
    CONSTRAINT "PerformanceObligation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PerformanceObligation_timing_check" CHECK ("timing" IN ('POINT_IN_TIME','OVER_TIME')),
    CONSTRAINT "PerformanceObligation_standalone_check" CHECK ("standalonePriceMinor" > 0),
    -- Recognising more than was allocated to an obligation is revenue taken
    -- twice, which is the failure IFRS 15's allocation step exists to prevent.
    CONSTRAINT "PerformanceObligation_recognised_check"
      CHECK ("recognisedMinor" >= 0 AND "recognisedMinor" <= "allocatedMinor"),
    CONSTRAINT "PerformanceObligation_progress_check"
      CHECK ("progressBps" >= 0 AND "progressBps" <= 10000)
);

ALTER TABLE "PaymentRunItem" ADD CONSTRAINT "PaymentRunItem_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "PaymentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PerformanceObligation" ADD CONSTRAINT "PerformanceObligation_contractId_fkey"
  FOREIGN KEY ("contractId") REFERENCES "RevenueContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Counterparty_orgId_entityId_code_key" ON "Counterparty"("orgId","entityId","code");
CREATE INDEX "Counterparty_orgId_entityId_kind_status_idx" ON "Counterparty"("orgId","entityId","kind","status");
CREATE UNIQUE INDEX "PaymentRun_orgId_entityId_reference_key" ON "PaymentRun"("orgId","entityId","reference");
CREATE INDEX "PaymentRun_orgId_entityId_status_idx" ON "PaymentRun"("orgId","entityId","status");
CREATE INDEX "PaymentRunItem_runId_idx" ON "PaymentRunItem"("runId");
CREATE UNIQUE INDEX "RevenueContract_orgId_entityId_code_key" ON "RevenueContract"("orgId","entityId","code");
CREATE INDEX "RevenueContract_orgId_entityId_status_idx" ON "RevenueContract"("orgId","entityId","status");
CREATE UNIQUE INDEX "PerformanceObligation_contractId_seq_key" ON "PerformanceObligation"("contractId","seq");
CREATE INDEX "PerformanceObligation_orgId_contractId_idx" ON "PerformanceObligation"("orgId","contractId");
