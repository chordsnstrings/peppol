-- Time worked, and the work in progress it becomes.
--
-- For a service business time is the raw material, and unbilled time is either
-- an asset or it is not — a question the accounts have to answer rather than
-- leave to a spreadsheet. It is recorded in minutes rather than decimal hours
-- because a quarter of an hour is 15 and 0.25 of an hour is a float that will
-- not add up over a month.

CREATE TABLE "TimeEntry" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "projectCode" TEXT, "employeeCode" TEXT NOT NULL,
    "workedOn" DATE NOT NULL,
    "minutes" INTEGER NOT NULL,
    "rateMinor" BIGINT NOT NULL,
    "costRateMinor" BIGINT,
    "description" TEXT NOT NULL,
    "billable" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "invoiceId" TEXT,
    "writeOffReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TimeEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TimeEntry_status_check" CHECK ("status" IN ('draft','approved','invoiced','written_off')),
    -- An entry of no time is not an entry, and more than a day in a day is a
    -- typo — 1440 minutes is twenty-four hours.
    CONSTRAINT "TimeEntry_minutes_check" CHECK ("minutes" > 0 AND "minutes" <= 1440),
    CONSTRAINT "TimeEntry_rate_check" CHECK ("rateMinor" >= 0),
    CONSTRAINT "TimeEntry_cost_check" CHECK ("costRateMinor" IS NULL OR "costRateMinor" >= 0),
    -- Written off time has to say why. "Not charged" with no reason is a
    -- number nobody can defend to a partner or learn anything from.
    CONSTRAINT "TimeEntry_writeoff_check"
      CHECK ("status" <> 'written_off' OR "writeOffReason" IS NOT NULL),
    -- Invoiced time names the invoice, so a charge can always be traced to the
    -- hours behind it.
    CONSTRAINT "TimeEntry_invoiced_check"
      CHECK ("status" <> 'invoiced' OR "invoiceId" IS NOT NULL),
    -- Non-billable time cannot be invoiced. It is recorded because what it
    -- cost is real, not because anybody is going to pay for it.
    CONSTRAINT "TimeEntry_billable_check"
      CHECK ("billable" OR "status" <> 'invoiced')
);
CREATE INDEX "TimeEntry_orgId_entityId_projectCode_workedOn_idx"
  ON "TimeEntry"("orgId","entityId","projectCode","workedOn");
CREATE INDEX "TimeEntry_orgId_entityId_employeeCode_workedOn_idx"
  ON "TimeEntry"("orgId","entityId","employeeCode","workedOn");

CREATE TABLE "WipPosting" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "balanceMinor" BIGINT NOT NULL,
    "chargeMinor" BIGINT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "entryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WipPosting_pkey" PRIMARY KEY ("id"),
    -- Work in progress is an asset or it is nothing; a negative balance would
    -- be a liability for work not yet done, which is a different thing.
    CONSTRAINT "WipPosting_balance_check" CHECK ("balanceMinor" >= 0),
    CONSTRAINT "WipPosting_minutes_check" CHECK ("minutes" >= 0),
    CONSTRAINT "WipPosting_period_check" CHECK ("period" ~ '^[0-9]{4}-[0-9]{2}$')
);
CREATE UNIQUE INDEX "WipPosting_orgId_entityId_period_key" ON "WipPosting"("orgId","entityId","period");
CREATE INDEX "WipPosting_orgId_entityId_idx" ON "WipPosting"("orgId","entityId");

-- The work-in-progress account, for books opened before now.
INSERT INTO "Account" ("id","orgId","entityId","code","name","nameAr","type","subtype","parentId","isPostable","isControl","createdAt")
SELECT md5(random()::text || clock_timestamp()::text), b."orgId", b."entityId", '1330', 'Work in progress', 'أعمال تحت التنفيذ', 'ASSET', 'WIP',
       (SELECT p.id FROM "Account" p WHERE p."orgId" = b."orgId" AND p."entityId" = b."entityId" AND p."code" = '10'),
       true, false, NOW()
FROM (SELECT DISTINCT "orgId", "entityId" FROM "Account") b
WHERE NOT EXISTS (
  SELECT 1 FROM "Account" a WHERE a."orgId" = b."orgId" AND a."entityId" = b."entityId" AND a."code" = '1330'
);
