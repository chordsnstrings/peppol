-- Three things the survey found missing, and the chart accounts that go with them.
--
-- A bad debt could not be written off at all: 1100 is a control account and
-- refuses a manual journal, which is correct, and no subledger path existed to
-- clear an irrecoverable balance. So an uncollectable invoice aged forever, the
-- ageing overstated, and the dunning ladder kept chasing it.
--
-- A counterparty could be declared related but never declared NOT related, so
-- the IAS 24 completeness chip was permanently "no" for any entity with an
-- ordinary supplier ledger, and the panel listing the unassessed had no control
-- on any row.
--
-- And nothing held the tax period the FTA assigned, so every "is this filed"
-- answer was inferred from the period lock. A registrant's stagger is assigned
-- by the FTA and is not derivable from the books.

CREATE TABLE "ReceivableWriteOff" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "documentRef" TEXT NOT NULL,
    "partyKey" TEXT NOT NULL,
    "partyName" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "vatMinor" BIGINT NOT NULL DEFAULT 0,
    "writtenOffOn" DATE NOT NULL,
    "invoicedOn" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "notifiedOn" DATE,
    "vatAdjusted" BOOLEAN NOT NULL DEFAULT false,
    "entryId" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReceivableWriteOff_pkey" PRIMARY KEY ("id"),
    -- Writing off nothing is not a write-off, and a negative one is a receipt.
    CONSTRAINT "ReceivableWriteOff_amount_check" CHECK ("amountMinor" > 0),
    CONSTRAINT "ReceivableWriteOff_vat_check" CHECK ("vatMinor" >= 0 AND "vatMinor" <= "amountMinor"),
    -- A write-off with no reason is a number nobody can defend to an auditor,
    -- and Article 64(1) turns the reason into a condition rather than a note.
    CONSTRAINT "ReceivableWriteOff_reason_check" CHECK (length(btrim("reason")) >= 4),
    CONSTRAINT "ReceivableWriteOff_order_check" CHECK ("writtenOffOn" >= "invoicedOn"),
    -- Article 64(1)(c): the output tax may be adjusted only once the customer
    -- has been notified of the amount written off. The database holds the
    -- condition so an import cannot walk through it.
    CONSTRAINT "ReceivableWriteOff_vat_notified_check"
      CHECK (NOT "vatAdjusted" OR "notifiedOn" IS NOT NULL),
    -- Article 64(1)(a): six months must have elapsed. 180 days is the reading
    -- taken here and it is deliberately the shorter one, so the constraint
    -- never refuses a debt the law would allow.
    CONSTRAINT "ReceivableWriteOff_vat_six_months_check"
      CHECK (NOT "vatAdjusted" OR "writtenOffOn" >= "invoicedOn" + 180)
);
CREATE UNIQUE INDEX "ReceivableWriteOff_orgId_entityId_documentId_key"
  ON "ReceivableWriteOff"("orgId","entityId","documentId");
CREATE INDEX "ReceivableWriteOff_orgId_entityId_writtenOffOn_idx"
  ON "ReceivableWriteOff"("orgId","entityId","writtenOffOn");

CREATE TABLE "PartyAssessment" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "partyKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "assessedBy" TEXT NOT NULL,
    "assessedOn" DATE NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PartyAssessment_pkey" PRIMARY KEY ("id"),
    -- An assessment nobody owns is not an assessment, exactly as a declaration
    -- nobody owns is not a declaration.
    CONSTRAINT "PartyAssessment_by_check" CHECK (length(btrim("assessedBy")) > 0)
);
CREATE UNIQUE INDEX "PartyAssessment_orgId_entityId_partyKey_key"
  ON "PartyAssessment"("orgId","entityId","partyKey");
CREATE INDEX "PartyAssessment_orgId_entityId_idx" ON "PartyAssessment"("orgId","entityId");

CREATE TABLE "TaxRegistration" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "regime" TEXT NOT NULL,
    "trn" TEXT,
    "frequency" TEXT NOT NULL DEFAULT 'QUARTERLY',
    "firstPeriodEndMonth" INTEGER NOT NULL DEFAULT 3,
    "registeredOn" DATE,
    "deregisteredOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TaxRegistration_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TaxRegistration_regime_check" CHECK ("regime" IN ('VAT','CORPORATE_TAX','EXCISE')),
    CONSTRAINT "TaxRegistration_frequency_check" CHECK ("frequency" IN ('MONTHLY','QUARTERLY','ANNUAL')),
    CONSTRAINT "TaxRegistration_stagger_check" CHECK ("firstPeriodEndMonth" BETWEEN 1 AND 12),
    CONSTRAINT "TaxRegistration_window_check"
      CHECK ("deregisteredOn" IS NULL OR "registeredOn" IS NULL OR "deregisteredOn" >= "registeredOn")
);
CREATE UNIQUE INDEX "TaxRegistration_orgId_entityId_regime_key"
  ON "TaxRegistration"("orgId","entityId","regime");

CREATE TABLE "TaxFiling" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "periodFrom" DATE NOT NULL,
    "periodTo" DATE NOT NULL,
    "dueOn" DATE NOT NULL,
    "filedOn" DATE,
    "reference" TEXT,
    "netVatMinor" BIGINT,
    "filedBy" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaxFiling_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TaxFiling_registration_fkey" FOREIGN KEY ("registrationId")
      REFERENCES "TaxRegistration"("id") ON DELETE CASCADE,
    CONSTRAINT "TaxFiling_window_check" CHECK ("periodTo" >= "periodFrom"),
    -- A return cannot be due before the period it covers has ended.
    CONSTRAINT "TaxFiling_due_check" CHECK ("dueOn" >= "periodTo"),
    -- Filed means somebody filed it, and a filing with no filer is the
    -- inference this table exists to replace.
    CONSTRAINT "TaxFiling_filed_check"
      CHECK (("filedOn" IS NULL) = ("filedBy" IS NULL))
);
CREATE UNIQUE INDEX "TaxFiling_registrationId_periodLabel_key"
  ON "TaxFiling"("registrationId","periodLabel");
CREATE INDEX "TaxFiling_orgId_periodTo_idx" ON "TaxFiling"("orgId","periodTo");

-- Chart accounts for the above, and for IAS 38.
--
-- 1560/1570 exist because a capitalised software licence currently lands on
-- the fixed asset register, amortises through the depreciation account and is
-- disclosed under a note headed "Property, plant and equipment". The
-- arithmetic is right — straight-line over a finite life is amortisation —
-- but the caption and the IAS 38.118 reconciliation are not.
INSERT INTO "Account" ("id","orgId","entityId","code","name","nameAr","type","subtype","parentId","isPostable","isControl","createdAt")
SELECT md5(random()::text || clock_timestamp()::text || c."code"), b."orgId", b."entityId",
       c."code", c."name", c."nameAr", c."type", NULLIF(c."subtype",''),
       (SELECT p.id FROM "Account" p WHERE p."orgId" = b."orgId" AND p."entityId" = b."entityId" AND p."code" = c."parent"),
       true, false, NOW()
FROM (SELECT DISTINCT "orgId", "entityId" FROM "Account") b
CROSS JOIN (VALUES
  ('1560', 'Intangible assets',            'الأصول غير الملموسة',      'ASSET',   '15', 'INTANGIBLE'),
  ('1570', 'Accumulated amortisation',     'مجمع الإطفاء',             'ASSET',   '15', 'ACCUM_AMORT'),
  ('6610', 'Amortisation of intangibles',  'إطفاء الأصول غير الملموسة','EXPENSE', '6',  ''),
  ('6260', 'Bad debts written off',        'ديون معدومة',              'EXPENSE', '6',  'BAD_DEBT')
) AS c("code","name","nameAr","type","parent","subtype")
WHERE NOT EXISTS (
  SELECT 1 FROM "Account" a WHERE a."orgId" = b."orgId" AND a."entityId" = b."entityId" AND a."code" = c."code"
);
