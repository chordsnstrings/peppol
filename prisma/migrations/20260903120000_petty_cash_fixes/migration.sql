-- Two corrections to the petty cash tables.

-- 1020 is "Bank — savings account" in the standard chart. A tin of notes is
-- not a savings account: coding it to one puts petty cash into the bank
-- reconciliation, which then asks for a statement that will never exist.
ALTER TABLE "PettyCashFund" ALTER COLUMN "accountCode" SET DEFAULT '1000';

-- The original check only said what a non-spend may not carry. It left a
-- spend free to carry no expense account at all, which is a receipt that has
-- been paid for out of the float and coded to nothing.
ALTER TABLE "PettyCashMovement" DROP CONSTRAINT "PettyCashMovement_spend_check";
ALTER TABLE "PettyCashMovement" ADD CONSTRAINT "PettyCashMovement_spend_check"
  CHECK (
    CASE WHEN "kind" = 'SPEND'
      THEN "accountCode" IS NOT NULL
      ELSE "accountCode" IS NULL AND "vatMinor" = 0
    END
  );
