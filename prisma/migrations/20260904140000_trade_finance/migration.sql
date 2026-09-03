-- Trade finance: letters of credit, bank guarantees and trust receipts.
--
-- Two ideas, and getting either wrong misstates the accounts in a way nobody
-- notices until the bank calls.
--
-- A guarantee that has not been called is a contingent liability, not a
-- liability. IAS 37.27 forbids recognising it — the obligation depends on a
-- future event outside the entity's control — and IAS 37.86 requires it to be
-- disclosed. A business that books its guarantees as liabilities understates
-- its net assets by the whole facility; one that says nothing about them
-- leaves the reader with no idea what the business has promised.
--
-- The cash margin the bank holds IS an asset, and it is emphatically not cash
-- and cash equivalents. It cannot be spent, so IAS 7.48 asks for it to be
-- disclosed as restricted. Leaving it in the bank account is the same mistake
-- as reporting a post-dated cheque as cash, and it is made for the same
-- reason: the money looks like it is there.

CREATE TABLE "TradeFacility" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "bank" TEXT NOT NULL,
    "beneficiary" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "amountMinor" BIGINT NOT NULL,
    "marginMinor" BIGINT NOT NULL DEFAULT 0,
    "commissionMinor" BIGINT NOT NULL DEFAULT 0,
    "issuedOn" DATE NOT NULL,
    "expiresOn" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "drawnMinor" BIGINT NOT NULL DEFAULT 0,
    "closedOn" DATE,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TradeFacility_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TradeFacility_kind_check"
      CHECK ("kind" IN ('LC_IMPORT','LC_EXPORT','BANK_GUARANTEE','TRUST_RECEIPT')),
    CONSTRAINT "TradeFacility_status_check"
      CHECK ("status" IN ('issued','drawn','expired','cancelled')),
    CONSTRAINT "TradeFacility_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "TradeFacility_amount_check" CHECK ("amountMinor" > 0),
    CONSTRAINT "TradeFacility_margin_check"
      CHECK ("marginMinor" >= 0 AND "marginMinor" <= "amountMinor"),
    CONSTRAINT "TradeFacility_commission_check" CHECK ("commissionMinor" >= 0),
    -- More cannot be called than was promised. A bank that pays out beyond the
    -- face of the credit has made a loan, and a loan is a different document.
    CONSTRAINT "TradeFacility_drawn_check"
      CHECK ("drawnMinor" >= 0 AND "drawnMinor" <= "amountMinor"),
    -- A facility that expires before it is issued protects nobody, and would
    -- sit in the register looking live.
    CONSTRAINT "TradeFacility_window_check" CHECK ("expiresOn" >= "issuedOn"),
    CONSTRAINT "TradeFacility_closed_check"
      CHECK (("status" IN ('expired','cancelled')) = ("closedOn" IS NOT NULL))
);
CREATE UNIQUE INDEX "TradeFacility_orgId_entityId_reference_key"
  ON "TradeFacility"("orgId","entityId","reference");
CREATE INDEX "TradeFacility_orgId_entityId_status_expiresOn_idx"
  ON "TradeFacility"("orgId","entityId","status","expiresOn");

CREATE TABLE "TradeFacilityEvent" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "happenedOn" DATE NOT NULL,
    "amountMinor" BIGINT NOT NULL DEFAULT 0,
    "entryId" TEXT,
    "memo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TradeFacilityEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TradeFacilityEvent_facility_fkey" FOREIGN KEY ("facilityId")
      REFERENCES "TradeFacility"("id") ON DELETE CASCADE,
    CONSTRAINT "TradeFacilityEvent_kind_check"
      CHECK ("kind" IN ('issue','amend','draw','settle','release','expire','cancel')),
    CONSTRAINT "TradeFacilityEvent_amount_check" CHECK ("amountMinor" >= 0)
);
CREATE INDEX "TradeFacilityEvent_orgId_facilityId_happenedOn_idx"
  ON "TradeFacilityEvent"("orgId","facilityId","happenedOn");

-- The two accounts this needs, for books already open.
--
-- 1255 sits outside every cash list in the product for the same reason 1060
-- does: money the bank is holding against a promise cannot be spent, and
-- reporting it as cash tells the reader the business has liquidity it does
-- not have.
INSERT INTO "Account" ("id","orgId","entityId","code","name","nameAr","type","subtype","parentId","isPostable","isControl","createdAt")
SELECT md5(random()::text || clock_timestamp()::text || c."code"), b."orgId", b."entityId",
       c."code", c."name", c."nameAr", c."type", NULL,
       (SELECT p.id FROM "Account" p WHERE p."orgId" = b."orgId" AND p."entityId" = b."entityId" AND p."code" = c."parent"),
       true, false, NOW()
FROM (SELECT DISTINCT "orgId", "entityId" FROM "Account") b
CROSS JOIN (VALUES
  ('1255', 'Margin deposits (restricted)',  'ودائع الهامش المقيدة', 'ASSET',     '10'),
  ('2470', 'Trust receipts and trade finance', 'إيصالات أمانة وتمويل تجاري', 'LIABILITY', '20')
) AS c("code","name","nameAr","type","parent")
WHERE NOT EXISTS (
  SELECT 1 FROM "Account" a WHERE a."orgId" = b."orgId" AND a."entityId" = b."entityId" AND a."code" = c."code"
);
