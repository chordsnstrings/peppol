-- A payment run has to know who proposed it.
--
-- Separation of duties on a payment run is the rule that the person who
-- prepared it cannot be the person who releases the money. Without a column
-- for the preparer that check can only be made against a name the approver
-- supplies at approval time — which means the control is enforced only when
-- the person it constrains chooses to tell the truth. That is not a control.

ALTER TABLE "PaymentRun" ADD COLUMN "preparedBy" TEXT;

-- Once both names are on the row the database can hold the rule itself.
-- Existing rows have no preparer recorded, so the check passes for them: it
-- constrains what can be written from here on rather than inventing history.
ALTER TABLE "PaymentRun" ADD CONSTRAINT "PaymentRun_separation_check"
  CHECK (
    "preparedBy" IS NULL OR "approvedBy" IS NULL
    OR lower(btrim("preparedBy")) <> lower(btrim("approvedBy"))
  );
