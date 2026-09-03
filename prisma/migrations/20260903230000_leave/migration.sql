-- Annual leave, and the liability for what has been earned and not taken.
--
-- Entitlement is deliberately not stored. It is a function of service and the
-- contract — Federal Decree-Law 33/2021 Article 29 gives 30 calendar days after
-- a year, and two working days a month between six months and a year — and a
-- stored entitlement is a figure that stops agreeing with the joining date the
-- moment either of them changes. What is stored is what actually happened:
-- leave taken, and leave paid out.

ALTER TABLE "Employee" ADD COLUMN "leaveDaysPerYear" INTEGER NOT NULL DEFAULT 30;

-- A contract may give more than the law, never less.
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_leave_check"
  CHECK ("leaveDaysPerYear" >= 30 AND "leaveDaysPerYear" <= 365);

CREATE TABLE "LeaveRecord" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'ANNUAL',
    "startsOn" DATE NOT NULL, "endsOn" DATE NOT NULL,
    "daysTenth" INTEGER NOT NULL,
    "paid" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeaveRecord_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LeaveRecord_employeeId_fkey" FOREIGN KEY ("employeeId")
      REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LeaveRecord_kind_check" CHECK ("kind" IN
      ('ANNUAL','SICK','UNPAID','MATERNITY','PARENTAL','HAJJ','COMPASSIONATE','ENCASHED')),
    -- Leave that ends before it starts is a typo, and it would subtract days.
    CONSTRAINT "LeaveRecord_dates_check" CHECK ("endsOn" >= "startsOn"),
    -- Days in tenths: half a day is 5. A record of no days is not a record.
    CONSTRAINT "LeaveRecord_days_check" CHECK ("daysTenth" > 0),
    -- Unpaid leave is unpaid by definition; recording it as paid would put it
    -- into the payroll as salary that was never due.
    CONSTRAINT "LeaveRecord_unpaid_check" CHECK ("kind" <> 'UNPAID' OR "paid" = false)
);
CREATE INDEX "LeaveRecord_orgId_entityId_employeeId_startsOn_idx"
  ON "LeaveRecord"("orgId","entityId","employeeId","startsOn");

CREATE TABLE "LeaveProvision" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "balanceMinor" BIGINT NOT NULL,
    "chargeMinor" BIGINT NOT NULL,
    "daysTenth" INTEGER NOT NULL,
    "entryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeaveProvision_pkey" PRIMARY KEY ("id"),
    -- A liability for leave nobody has earned is not a liability.
    CONSTRAINT "LeaveProvision_balance_check" CHECK ("balanceMinor" >= 0),
    CONSTRAINT "LeaveProvision_days_check" CHECK ("daysTenth" >= 0),
    CONSTRAINT "LeaveProvision_period_check" CHECK ("period" ~ '^[0-9]{4}-[0-9]{2}$')
);
CREATE UNIQUE INDEX "LeaveProvision_orgId_entityId_period_key"
  ON "LeaveProvision"("orgId","entityId","period");
CREATE INDEX "LeaveProvision_orgId_entityId_idx" ON "LeaveProvision"("orgId","entityId");

-- The provision account, for books opened before now.
INSERT INTO "Account" ("id","orgId","entityId","code","name","nameAr","type","subtype","parentId","isPostable","isControl","createdAt")
SELECT md5(random()::text || clock_timestamp()::text), b."orgId", b."entityId", '2260', 'Untaken leave provision', 'مخصص الإجازات غير المستخدمة', 'LIABILITY', 'LEAVE_PROVISION',
       (SELECT p.id FROM "Account" p WHERE p."orgId" = b."orgId" AND p."entityId" = b."entityId" AND p."code" = '20'),
       true, false, NOW()
FROM (SELECT DISTINCT "orgId", "entityId" FROM "Account") b
WHERE NOT EXISTS (
  SELECT 1 FROM "Account" a WHERE a."orgId" = b."orgId" AND a."entityId" = b."entityId" AND a."code" = '2260'
);
