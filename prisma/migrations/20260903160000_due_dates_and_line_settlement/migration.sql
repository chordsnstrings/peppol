-- Two facts the ledger could not hold.

-- 1. When a document falls due.
--
-- Both ageing reports age from the entry date, because that is all they have.
-- Every consumer of them therefore assumes one set of payment terms for
-- everybody: a customer genuinely on sixty days is chased from the
-- thirty-first, and a bill on seven days looks current for a month. The terms
-- are on the document; they simply never reached the ledger.
ALTER TABLE "JournalEntry" ADD COLUMN "dueDate" DATE;

-- A document cannot fall due before it exists.
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_due_after_entry_check"
  CHECK ("dueDate" IS NULL OR "dueDate" >= "entryDate");

-- 2. Which open item a single line settles.
--
-- JournalEntry.settlesId names one document, so one entry can discharge
-- exactly one open item. A batch supplier payment posted as a single entry
-- would leave every bill but the first showing as outstanding — and a bill
-- that still looks outstanding is a bill that gets paid again. Line-level
-- settlement is what lets one entry discharge many; the entry-level column
-- stays as the fallback for everything already posted.
ALTER TABLE "JournalLine" ADD COLUMN "settlesId" TEXT;
CREATE INDEX "JournalLine_orgId_settlesId_idx" ON "JournalLine"("orgId", "settlesId");
