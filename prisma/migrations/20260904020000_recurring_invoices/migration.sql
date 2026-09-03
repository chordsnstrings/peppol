-- Subscriptions: an invoice that recurs on its own schedule.
--
-- The lines are held as data rather than as a document, because a template is
-- not an invoice — it is the instruction for making one, and every invoice it
-- makes is a separate document with its own number, its own date and its own
-- life. What each run raised is recorded, so a template can say what it has
-- done and a retry cannot raise the same period twice.

CREATE TABLE "RecurringInvoice" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "customerCode" TEXT, "customerName" TEXT NOT NULL, "customerTrn" TEXT,
    "frequency" TEXT NOT NULL DEFAULT 'MONTHLY',
    "startsOn" DATE NOT NULL, "endsOn" DATE, "nextOn" DATE NOT NULL,
    "paymentTerms" INTEGER NOT NULL DEFAULT 30,
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "lines" JSONB NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastIssuedOn" DATE, "issuedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RecurringInvoice_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RecurringInvoice_frequency_check"
      CHECK ("frequency" IN ('WEEKLY','MONTHLY','QUARTERLY','ANNUAL')),
    CONSTRAINT "RecurringInvoice_status_check" CHECK ("status" IN ('active','paused','ended')),
    CONSTRAINT "RecurringInvoice_terms_check" CHECK ("paymentTerms" >= 0 AND "paymentTerms" <= 365),
    -- A subscription that ends before it begins raises nothing, and the run
    -- that silently does nothing is the one nobody notices for a quarter.
    CONSTRAINT "RecurringInvoice_dates_check" CHECK ("endsOn" IS NULL OR "endsOn" >= "startsOn"),
    CONSTRAINT "RecurringInvoice_next_check" CHECK ("nextOn" >= "startsOn"),
    -- A template with no lines raises an invoice for nothing.
    CONSTRAINT "RecurringInvoice_lines_check"
      CHECK (jsonb_typeof("lines") = 'array' AND jsonb_array_length("lines") > 0)
);
CREATE UNIQUE INDEX "RecurringInvoice_orgId_entityId_code_key"
  ON "RecurringInvoice"("orgId","entityId","code");
CREATE INDEX "RecurringInvoice_orgId_entityId_status_nextOn_idx"
  ON "RecurringInvoice"("orgId","entityId","status","nextOn");

CREATE TABLE "RecurringInvoiceIssue" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "templateId" TEXT NOT NULL,
    "scheduledOn" DATE NOT NULL, "issuedOn" DATE NOT NULL,
    "invoiceId" TEXT NOT NULL, "invoiceNumber" TEXT NOT NULL,
    "totalMinor" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecurringInvoiceIssue_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RecurringInvoiceIssue_templateId_fkey" FOREIGN KEY ("templateId")
      REFERENCES "RecurringInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- One invoice per scheduled date. This is what makes a re-run safe: the second
-- attempt collides rather than billing the customer twice, which is the
-- failure a subscription can least afford.
CREATE UNIQUE INDEX "RecurringInvoiceIssue_templateId_scheduledOn_key"
  ON "RecurringInvoiceIssue"("templateId","scheduledOn");
CREATE INDEX "RecurringInvoiceIssue_orgId_templateId_idx"
  ON "RecurringInvoiceIssue"("orgId","templateId");
