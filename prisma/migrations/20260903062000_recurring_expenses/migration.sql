-- Recurring journals and employee expense claims.

CREATE TABLE "RecurringJournal" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'MONTHLY',
    "startsOn" DATE NOT NULL,
    "endsOn" DATE,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "lastRunPeriod" TEXT,
    "lines" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'STANDING',
    "autoReverse" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringJournal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RecurringJournal_frequency_check"
      CHECK ("frequency" IN ('MONTHLY','QUARTERLY','ANNUAL')),
    CONSTRAINT "RecurringJournal_kind_check"
      CHECK ("kind" IN ('ACCRUAL','PREPAYMENT','STANDING')),
    CONSTRAINT "RecurringJournal_status_check"
      CHECK ("status" IN ('active','paused','ended')),
    CONSTRAINT "RecurringJournal_dates_check" CHECK ("endsOn" IS NULL OR "endsOn" >= "startsOn"),
    CONSTRAINT "RecurringJournal_period_check"
      CHECK ("lastRunPeriod" IS NULL OR "lastRunPeriod" ~ '^[0-9]{4}-[0-9]{2}$')
);

CREATE TABLE "ExpenseClaim" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "employeeName" TEXT NOT NULL,
    "claimedOn" DATE NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "rejectedReason" TEXT,
    "entryId" TEXT,
    "paidEntryId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpenseClaim_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ExpenseClaim_status_check"
      CHECK ("status" IN ('draft','submitted','approved','rejected','posted','paid')),
    -- An approved claim records who approved it and when. Approval with no
    -- approver is not a control, it is a checkbox.
    CONSTRAINT "ExpenseClaim_approval_check"
      CHECK (("status" NOT IN ('approved','posted','paid')) OR ("approvedAt" IS NOT NULL AND "approvedBy" IS NOT NULL)),
    -- A rejection has to say why.
    CONSTRAINT "ExpenseClaim_rejection_check"
      CHECK (("status" <> 'rejected') OR ("rejectedReason" IS NOT NULL)),
    -- A posted claim names the entry it produced.
    CONSTRAINT "ExpenseClaim_entry_check"
      CHECK (("status" NOT IN ('posted','paid')) OR ("entryId" IS NOT NULL))
);

CREATE TABLE "ExpenseClaimLine" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "spentOn" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "netMinor" BIGINT NOT NULL,
    "vatMinor" BIGINT NOT NULL DEFAULT 0,
    "supplierTrn" TEXT,
    "vatRecoverable" BOOLEAN NOT NULL DEFAULT false,
    "receiptRef" TEXT,

    CONSTRAINT "ExpenseClaimLine_pkey" PRIMARY KEY ("id"),
    -- A claim line of nothing is not a claim line.
    CONSTRAINT "ExpenseClaimLine_net_check" CHECK ("netMinor" <> 0),
    CONSTRAINT "ExpenseClaimLine_vat_check" CHECK ("vatMinor" >= 0),
    -- Input VAT is only recoverable against a valid tax invoice showing the
    -- supplier's TRN (UAE VAT Decree-Law Art 55). Claiming it without one is
    -- the commonest expense-claim error, so the table refuses it outright.
    CONSTRAINT "ExpenseClaimLine_vat_recoverable_check"
      CHECK (NOT "vatRecoverable" OR ("supplierTrn" IS NOT NULL AND "vatMinor" > 0))
);

ALTER TABLE "ExpenseClaimLine" ADD CONSTRAINT "ExpenseClaimLine_claimId_fkey"
  FOREIGN KEY ("claimId") REFERENCES "ExpenseClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "RecurringJournal_orgId_entityId_code_key" ON "RecurringJournal"("orgId", "entityId", "code");
CREATE INDEX "RecurringJournal_orgId_entityId_status_idx" ON "RecurringJournal"("orgId", "entityId", "status");
CREATE UNIQUE INDEX "ExpenseClaim_orgId_entityId_reference_key" ON "ExpenseClaim"("orgId", "entityId", "reference");
CREATE INDEX "ExpenseClaim_orgId_entityId_status_idx" ON "ExpenseClaim"("orgId", "entityId", "status");
CREATE INDEX "ExpenseClaimLine_claimId_idx" ON "ExpenseClaimLine"("claimId");
