-- Payroll, budgets and period-end exchange rates.
--
-- Each of these is a record of something the ledger cannot hold: an employment
-- contract, a plan, a rate on a date. The ledger holds only what they caused.

CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "emiratesId" TEXT,
    "molPersonId" TEXT,
    "routingCode" TEXT,
    "iban" TEXT,
    "joinedOn" DATE NOT NULL,
    "leftOn" DATE,
    "contractType" TEXT NOT NULL DEFAULT 'UNLIMITED',
    "basicMinor" BIGINT NOT NULL,
    "housingMinor" BIGINT NOT NULL DEFAULT 0,
    "transportMinor" BIGINT NOT NULL DEFAULT 0,
    "otherMinor" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Employee_contract_check" CHECK ("contractType" IN ('UNLIMITED','LIMITED')),
    CONSTRAINT "Employee_status_check" CHECK ("status" IN ('active','left')),
    -- Pay components cannot be negative; a deduction is a deduction, not a
    -- negative salary.
    CONSTRAINT "Employee_pay_check"
      CHECK ("basicMinor" >= 0 AND "housingMinor" >= 0 AND "transportMinor" >= 0 AND "otherMinor" >= 0),
    -- Someone cannot leave before they joined.
    CONSTRAINT "Employee_dates_check" CHECK ("leftOn" IS NULL OR "leftOn" >= "joinedOn"),
    -- A person who has left has a leaving date, and one who has not, has not.
    CONSTRAINT "Employee_status_dates_check" CHECK (("status" = 'active') = ("leftOn" IS NULL))
);

CREATE TABLE "Payslip" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "basicMinor" BIGINT NOT NULL,
    "allowancesMinor" BIGINT NOT NULL DEFAULT 0,
    "overtimeMinor" BIGINT NOT NULL DEFAULT 0,
    "deductionsMinor" BIGINT NOT NULL DEFAULT 0,
    "netMinor" BIGINT NOT NULL,
    "gratuityMinor" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "entryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payslip_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Payslip_status_check" CHECK ("status" IN ('draft','posted','paid')),
    CONSTRAINT "Payslip_period_check" CHECK ("period" ~ '^[0-9]{4}-[0-9]{2}$'),
    -- Net pay below zero would mean the employee owes the employer for working.
    CONSTRAINT "Payslip_net_check" CHECK ("netMinor" >= 0),
    CONSTRAINT "Payslip_components_check"
      CHECK ("basicMinor" >= 0 AND "allowancesMinor" >= 0 AND "overtimeMinor" >= 0 AND "deductionsMinor" >= 0),
    -- A posted payslip names the entry it produced.
    CONSTRAINT "Payslip_entry_check" CHECK (("status" = 'draft') OR ("entryId" IS NOT NULL))
);

ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "BudgetLine" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "scenario" TEXT NOT NULL DEFAULT 'BUDGET',
    "fiscalYear" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BudgetLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BudgetLine_period_check" CHECK ("period" ~ '^[0-9]{4}-[0-9]{2}$')
);

CREATE TABLE "FxRate" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "rate" DECIMAL(20,10) NOT NULL,
    "rateDate" DATE NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'CBUAE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FxRate_pkey" PRIMARY KEY ("id"),
    -- A zero or negative exchange rate would invert or erase every balance it
    -- touched.
    CONSTRAINT "FxRate_positive_check" CHECK ("rate" > 0)
);

CREATE UNIQUE INDEX "Employee_orgId_entityId_code_key" ON "Employee"("orgId", "entityId", "code");
CREATE INDEX "Employee_orgId_entityId_status_idx" ON "Employee"("orgId", "entityId", "status");
CREATE UNIQUE INDEX "Payslip_orgId_employeeId_period_key" ON "Payslip"("orgId", "employeeId", "period");
CREATE INDEX "Payslip_orgId_entityId_period_idx" ON "Payslip"("orgId", "entityId", "period");
CREATE UNIQUE INDEX "BudgetLine_orgId_entityId_scenario_period_accountCode_key"
  ON "BudgetLine"("orgId", "entityId", "scenario", "period", "accountCode");
CREATE INDEX "BudgetLine_orgId_entityId_scenario_fiscalYear_idx"
  ON "BudgetLine"("orgId", "entityId", "scenario", "fiscalYear");
CREATE UNIQUE INDEX "FxRate_orgId_entityId_currency_rateDate_key"
  ON "FxRate"("orgId", "entityId", "currency", "rateDate");
CREATE INDEX "FxRate_orgId_entityId_currency_idx" ON "FxRate"("orgId", "entityId", "currency");
