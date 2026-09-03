-- The VAT return has to be computed from the ledger, not from a second pass
-- over the documents. If it is derived separately, the return and the books
-- can disagree, and an auditor's first question is why.
--
-- Carrying the tax treatment onto the line is what makes that possible: the
-- return groups journal lines by taxCode and then reconciles its totals to the
-- VAT control accounts, so the two agree by construction rather than by luck.
ALTER TABLE "JournalLine" ADD COLUMN "taxCode" TEXT;
ALTER TABLE "JournalLine" ADD COLUMN "taxEmirate" TEXT;
CREATE INDEX "JournalLine_orgId_taxCode_idx" ON "JournalLine"("orgId", "taxCode");
