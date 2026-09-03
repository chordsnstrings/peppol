-- Related parties, IAS 24.
--
-- The equity notes already say, correctly, that a ledger cannot know which
-- parties are related: relatedness is a fact about people and control, and no
-- chart of accounts holds it. What was missing was anywhere to put the answer.
--
-- So this is a declaration, never a detection. A detector would be wrong in
-- the direction that matters — it would produce a confident, incomplete list,
-- and a reader would take its silence about everybody else as a statement that
-- there is nobody else. Every row here names who said so and when.

CREATE TABLE "RelatedParty" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "partyKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "declaredBy" TEXT NOT NULL,
    "declaredOn" DATE NOT NULL,
    "startedOn" DATE NOT NULL,
    "endedOn" DATE,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RelatedParty_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RelatedParty_relationship_check" CHECK ("relationship" IN (
      'PARENT','SUBSIDIARY','ASSOCIATE','JOINT_VENTURE','KEY_MANAGEMENT',
      'CLOSE_FAMILY','COMMON_CONTROL','POST_EMPLOYMENT_PLAN','OTHER')),
    -- A relationship that ended before it started is a typo that would drop
    -- the party out of every period's note without anybody noticing.
    CONSTRAINT "RelatedParty_window_check" CHECK ("endedOn" IS NULL OR "endedOn" >= "startedOn"),
    -- A declaration nobody owns is not a declaration. IAS 24 disclosure is an
    -- assertion by the preparer, and an assertion needs somebody making it.
    CONSTRAINT "RelatedParty_declared_check" CHECK (length(btrim("declaredBy")) > 0)
);
CREATE UNIQUE INDEX "RelatedParty_orgId_entityId_partyKey_startedOn_key"
  ON "RelatedParty"("orgId","entityId","partyKey","startedOn");
CREATE INDEX "RelatedParty_orgId_entityId_relationship_idx"
  ON "RelatedParty"("orgId","entityId","relationship");

CREATE TABLE "KeyManagementComp" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "headcount" INTEGER NOT NULL,
    "declaredBy" TEXT NOT NULL,
    "declaredOn" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KeyManagementComp_pkey" PRIMARY KEY ("id"),
    -- IAS 24.17 names exactly these five. A sixth would not be disclosable
    -- under the standard's own headings.
    CONSTRAINT "KeyManagementComp_category_check" CHECK ("category" IN (
      'SHORT_TERM','POST_EMPLOYMENT','OTHER_LONG_TERM','TERMINATION','SHARE_BASED')),
    CONSTRAINT "KeyManagementComp_amount_check" CHECK ("amountMinor" >= 0),
    -- Nought people cannot be paid anything, and a figure covering nobody is
    -- a figure a reader cannot interpret.
    CONSTRAINT "KeyManagementComp_headcount_check"
      CHECK ("headcount" > 0 OR "amountMinor" = 0),
    CONSTRAINT "KeyManagementComp_declared_check" CHECK (length(btrim("declaredBy")) > 0)
);
CREATE UNIQUE INDEX "KeyManagementComp_orgId_entityId_period_category_key"
  ON "KeyManagementComp"("orgId","entityId","period","category");

CREATE TABLE "RelatedPartyAttestation" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "parentName" TEXT,
    "ultimateControllingParty" TEXT,
    "noControllingParty" BOOLEAN NOT NULL DEFAULT false,
    "attestedBy" TEXT NOT NULL,
    "attestedOn" DATE NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RelatedPartyAttestation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RelatedPartyAttestation_attested_check" CHECK (length(btrim("attestedBy")) > 0),
    -- Either there is no controlling party, or one is named. Both blank means
    -- the question was never put, and IAS 24.13 requires it to be answered
    -- whether or not there were any transactions.
    CONSTRAINT "RelatedPartyAttestation_control_check"
      CHECK ("noControllingParty" OR "parentName" IS NOT NULL OR "ultimateControllingParty" IS NOT NULL),
    -- And not both. "There is no controlling party" and "the controlling party
    -- is X" cannot both be true.
    CONSTRAINT "RelatedPartyAttestation_control_exclusive_check"
      CHECK (NOT "noControllingParty" OR ("parentName" IS NULL AND "ultimateControllingParty" IS NULL))
);
CREATE UNIQUE INDEX "RelatedPartyAttestation_orgId_entityId_period_key"
  ON "RelatedPartyAttestation"("orgId","entityId","period");
