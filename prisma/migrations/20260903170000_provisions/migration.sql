-- Provisions and contingencies (IAS 37).

CREATE TABLE "Provision" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL, "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'OTHER',
    "kind" TEXT NOT NULL DEFAULT 'PROVISION',
    "recognisedOn" DATE NOT NULL,
    "estimateMinor" BIGINT NOT NULL,
    "discountRateBps" INTEGER NOT NULL DEFAULT 0,
    "expectedOn" DATE,
    "carryingMinor" BIGINT NOT NULL DEFAULT 0,
    "accountCode" TEXT NOT NULL DEFAULT '2150',
    "expenseAccount" TEXT NOT NULL DEFAULT '6900',
    "status" TEXT NOT NULL DEFAULT 'open',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Provision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Provision_category_check" CHECK ("category" IN
      ('LEGAL','WARRANTY','RESTRUCTURING','ONEROUS','DECOMMISSIONING','OTHER')),
    CONSTRAINT "Provision_kind_check" CHECK ("kind" IN
      ('PROVISION','CONTINGENT_LIABILITY','CONTINGENT_ASSET')),
    CONSTRAINT "Provision_status_check" CHECK ("status" IN ('open','settled','released')),
    CONSTRAINT "Provision_estimate_check" CHECK ("estimateMinor" >= 0),
    CONSTRAINT "Provision_rate_check" CHECK ("discountRateBps" >= 0 AND "discountRateBps" <= 10000),
    -- IAS 37.27 and 37.31: a contingency is disclosed, never recognised. If it
    -- carried a balance it would be a provision, and the distinction the whole
    -- standard turns on would be gone.
    CONSTRAINT "Provision_contingency_check"
      CHECK ("kind" = 'PROVISION' OR "carryingMinor" = 0),
    -- Discounting needs a date to discount to.
    CONSTRAINT "Provision_discount_check"
      CHECK ("discountRateBps" = 0 OR "expectedOn" IS NOT NULL)
);
CREATE UNIQUE INDEX "Provision_orgId_entityId_code_key" ON "Provision"("orgId","entityId","code");
CREATE INDEX "Provision_orgId_entityId_status_idx" ON "Provision"("orgId","entityId","status");

CREATE TABLE "ProvisionMovement" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "provisionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL, "kind" TEXT NOT NULL,
    "movedOn" DATE NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "note" TEXT, "entryId" TEXT,
    CONSTRAINT "ProvisionMovement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProvisionMovement_provisionId_fkey" FOREIGN KEY ("provisionId")
      REFERENCES "Provision"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProvisionMovement_kind_check" CHECK ("kind" IN
      ('RECOGNISE','REMEASURE','UNWIND','UTILISE','RELEASE')),
    -- A movement of nothing is not a movement, and a row of them makes the
    -- IAS 37.84 reconciliation unreadable.
    CONSTRAINT "ProvisionMovement_amount_check" CHECK ("amountMinor" <> 0)
);
CREATE UNIQUE INDEX "ProvisionMovement_provisionId_seq_key" ON "ProvisionMovement"("provisionId","seq");
CREATE INDEX "ProvisionMovement_orgId_provisionId_idx" ON "ProvisionMovement"("orgId","provisionId");

-- The provisions account, for books opened before this.
INSERT INTO "Account" ("id","orgId","entityId","code","name","nameAr","type","subtype","parentId","isPostable","isControl","createdAt")
SELECT md5(random()::text || clock_timestamp()::text), b."orgId", b."entityId", '2150', 'Provisions', 'المخصصات', 'LIABILITY', 'PROVISION',
       (SELECT p.id FROM "Account" p WHERE p."orgId" = b."orgId" AND p."entityId" = b."entityId" AND p."code" = '20'),
       true, false, NOW()
FROM (SELECT DISTINCT "orgId", "entityId" FROM "Account") b
WHERE NOT EXISTS (
  SELECT 1 FROM "Account" a WHERE a."orgId" = b."orgId" AND a."entityId" = b."entityId" AND a."code" = '2150'
);
