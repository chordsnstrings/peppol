-- The bank's record of what happened, kept deliberately separate from ours.
--
-- Reconciliation only means something because these are two independent
-- accounts of the same events. Importing bank lines straight into the ledger
-- would remove the difference the control exists to find, so they live here
-- until a human (or a rule they configured) agrees a given pair is the same
-- event.
--
-- The unique index on (orgId, accountId, fingerprint) is what makes re-importing
-- an overlapping statement file safe: banks rarely supply a usable unique id,
-- so the fingerprint is a hash of the fields the bank does give.
CREATE TABLE "BankStatementLine" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "postedOn" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "balanceMinor" BIGINT,
    "fingerprint" TEXT NOT NULL,
    "importBatch" TEXT NOT NULL,
    "matchedLineId" TEXT,
    "matchedAt" TIMESTAMP(3),
    "matchedBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unmatched',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankStatementLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BankStatementLine_status_check"
      CHECK ("status" IN ('unmatched','matched','ignored')),
    -- A matched line must name what it was matched to, and an unmatched one
    -- must not pretend it was. Half-recorded matches are how a reconciliation
    -- quietly stops meaning anything.
    CONSTRAINT "BankStatementLine_match_consistent_check"
      CHECK (("status" = 'matched') = ("matchedLineId" IS NOT NULL)),
    -- A zero-amount bank line carries no information and cannot be reconciled.
    CONSTRAINT "BankStatementLine_amount_check" CHECK ("amountMinor" <> 0)
);

ALTER TABLE "BankStatementLine" ADD CONSTRAINT "BankStatementLine_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "BankStatementLine_orgId_accountId_fingerprint_key"
  ON "BankStatementLine"("orgId", "accountId", "fingerprint");
CREATE INDEX "BankStatementLine_orgId_entityId_accountId_status_idx"
  ON "BankStatementLine"("orgId", "entityId", "accountId", "status");
CREATE INDEX "BankStatementLine_orgId_importBatch_idx"
  ON "BankStatementLine"("orgId", "importBatch");
CREATE INDEX "BankStatementLine_matchedLineId_idx"
  ON "BankStatementLine"("matchedLineId");

-- One journal line can only be the counterpart of one bank line. Without this,
-- two bank lines could both claim the same posting and the reconciliation would
-- appear to tie while double-counting.
CREATE UNIQUE INDEX "BankStatementLine_matchedLineId_key"
  ON "BankStatementLine"("matchedLineId") WHERE "matchedLineId" IS NOT NULL;
