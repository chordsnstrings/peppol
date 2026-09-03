-- Credit control: limits with a date, holds with a history, and a dunning
-- ladder that remembers what it already sent.
--
-- Everything here is *about* the receivables; none of it is receivables. Not
-- one row in these tables changes a balance, and that is deliberate — a credit
-- limit that could move the ledger would stop being a control and start being
-- an entry. Exposure is always recomputed from the control account and from
-- what has been committed on open orders, never accumulated here, because a
-- stored running total is wrong the first time somebody posts a journal by
-- hand and nobody finds out until the customer disputes a statement.

-- A limit as assessed on a date. The limit in force on any day is the latest
-- row on or before it; the absence of every row means the account has never
-- been assessed, which is a different state from an assessment of nought.
CREATE TABLE "CreditLimit" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "partyKey" TEXT NOT NULL,
    "limitMinor" BIGINT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "basis" TEXT NOT NULL,
    "setBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreditLimit_pkey" PRIMARY KEY ("id"),
    -- A negative limit would mean the customer has to hold a credit balance
    -- before they may buy, which is a deposit arrangement and not a limit.
    -- Nought is allowed and means exactly what it says: cash up front.
    CONSTRAINT "CreditLimit_amount_check" CHECK ("limitMinor" >= 0),
    -- A limit whose reason is blank cannot be reviewed, only inherited. The
    -- person asked to raise it a year from now has nothing to weigh.
    CONSTRAINT "CreditLimit_basis_check" CHECK (length(btrim("basis")) > 0)
);
-- Two limits effective the same day would make "the limit in force" a question
-- with two answers, and the credit check would silently pick whichever row the
-- planner read first.
CREATE UNIQUE INDEX "CreditLimit_orgId_entityId_partyKey_effectiveFrom_key"
  ON "CreditLimit"("orgId","entityId","partyKey","effectiveFrom");
CREATE INDEX "CreditLimit_orgId_entityId_partyKey_effectiveFrom_idx"
  ON "CreditLimit"("orgId","entityId","partyKey","effectiveFrom");

-- One hold, placed and later released. The release is columns on the same row,
-- never a delete: the history of who blocked this account and who let it go is
-- the whole value of the record.
CREATE TABLE "CreditHold" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "partyKey" TEXT NOT NULL,
    "placedOn" DATE NOT NULL,
    "placedBy" TEXT,
    "reason" TEXT NOT NULL,
    "releasedOn" DATE,
    "releasedBy" TEXT,
    "releaseReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreditHold_pkey" PRIMARY KEY ("id"),
    -- A hold with no reason blocks a sale nobody can explain and cannot be
    -- reviewed by whoever is asked to lift it next week.
    CONSTRAINT "CreditHold_reason_check" CHECK (length(btrim("reason")) > 0),
    -- A release is a decision in its own right, so it carries its own date and
    -- its own reason or it is not recorded at all.
    CONSTRAINT "CreditHold_release_check" CHECK (
      ("releasedOn" IS NULL AND "releaseReason" IS NULL)
      OR ("releasedOn" IS NOT NULL AND length(btrim(coalesce("releaseReason",''))) > 0)
    ),
    CONSTRAINT "CreditHold_order_check" CHECK ("releasedOn" IS NULL OR "releasedOn" >= "placedOn")
);
-- At most one hold in force per customer. Two live holds would mean releasing
-- one leaves the account still blocked for a reason the releaser never saw.
CREATE UNIQUE INDEX "CreditHold_one_in_force"
  ON "CreditHold"("orgId","entityId","partyKey") WHERE "releasedOn" IS NULL;
CREATE INDEX "CreditHold_orgId_entityId_partyKey_placedOn_idx"
  ON "CreditHold"("orgId","entityId","partyKey","placedOn");

-- What was sent, to whom, and when. Without it the ladder has no memory and
-- every run produces the same first reminder again.
CREATE TABLE "DunningNotice" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "partyKey" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "sentOn" DATE NOT NULL,
    "sentTo" TEXT NOT NULL,
    "overdueMinor" BIGINT NOT NULL,
    "oldestDays" INTEGER NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "letter" TEXT NOT NULL,
    "recordedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DunningNotice_pkey" PRIMARY KEY ("id"),
    -- The four rungs. A free-text stage would let "Reminder", "reminder" and
    -- "1st" all sit in the column, and the ladder could never tell whether it
    -- had climbed.
    CONSTRAINT "DunningNotice_stage_check"
      CHECK ("stage" IN ('reminder','first','second','final')),
    CONSTRAINT "DunningNotice_amount_check" CHECK ("overdueMinor" >= 0),
    CONSTRAINT "DunningNotice_days_check" CHECK ("oldestDays" >= 0),
    CONSTRAINT "DunningNotice_items_check" CHECK ("itemCount" >= 0),
    -- A letter recorded with no address is a claim that somebody was chased,
    -- with nothing behind it.
    CONSTRAINT "DunningNotice_sentTo_check" CHECK (length(btrim("sentTo")) > 0),
    CONSTRAINT "DunningNotice_letter_check" CHECK (length(btrim("letter")) > 0)
);
CREATE INDEX "DunningNotice_orgId_entityId_partyKey_sentOn_idx"
  ON "DunningNotice"("orgId","entityId","partyKey","sentOn");
