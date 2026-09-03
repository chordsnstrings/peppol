-- A receipt has to record which invoice it settles. Without it, open-item
-- ageing has no way to net a payment against the document it paid, and a
-- settled invoice sits in the ageing report forever.
--
-- This is deliberately not `sourceId`: `sourceId` says what document *caused*
-- the entry (the receipt), and `settlesId` says what document it *discharges*
-- (the invoice). Overloading one field to mean both is how an AR subledger
-- stops being able to answer either question.
ALTER TABLE "JournalEntry" ADD COLUMN "settlesId" TEXT;
CREATE INDEX "JournalEntry_orgId_settlesId_idx" ON "JournalEntry"("orgId", "settlesId");
