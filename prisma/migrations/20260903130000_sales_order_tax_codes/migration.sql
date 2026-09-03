-- 'SR' is what a UAE bookkeeper writes for a standard-rated supply, and the
-- module still accepts it. It is not, however, how the rest of the product
-- spells the treatment: everything else uses STANDARD_5. Storing both leaves
-- one treatment sitting in two categories on the VAT return, which is the kind
-- of difference nobody notices until the return does not agree with the ledger.

UPDATE "SalesOrderLine" SET "taxCode" = 'STANDARD_5' WHERE "taxCode" = 'SR';
UPDATE "SalesOrderLine" SET "taxCode" = 'ZERO_OTHER' WHERE "taxCode" = 'ZR';

ALTER TABLE "SalesOrderLine" ALTER COLUMN "taxCode" SET DEFAULT 'STANDARD_5';

-- The set is closed, so the database can hold the line. A code outside it
-- would otherwise reach the VAT return as a category the return has no row for.
ALTER TABLE "SalesOrderLine" ADD CONSTRAINT "SalesOrderLine_taxCode_check"
  CHECK ("taxCode" IN (
    'STANDARD_5','ZERO_EXPORT','ZERO_OTHER','EXEMPT',
    'OUT_OF_SCOPE','REVERSE_CHARGE','DESIGNATED_ZONE','MARGIN_SCHEME'
  ));
