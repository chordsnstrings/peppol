-- Price lists.
--
-- A price typed onto a document by hand is a number with no provenance. Nobody
-- can say afterwards whether it was the agreed price, a quantity break, or
-- somebody being generous on a Friday, and a discount that was never recorded
-- as a discount cannot be reported on. A list makes the price a fact about the
-- arrangement, and makes a departure from it visible as a departure.
--
-- The whole design rests on one question having exactly one answer: what does
-- this item cost this party, in this quantity, on this date? Everything below
-- exists to keep that answer from being ambiguous, because an ambiguous price
-- is worse than no price — it invoices differently depending on which row the
-- planner happened to read first.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE "PriceList" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "kind" TEXT NOT NULL DEFAULT 'SELL',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PriceList_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PriceList_kind_check" CHECK ("kind" IN ('SELL','BUY')),
    CONSTRAINT "PriceList_code_check" CHECK ("code" ~ '^[A-Z0-9_]{1,32}$'),
    CONSTRAINT "PriceList_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
    -- A list that ends before it starts prices nothing, and would sit in the
    -- table looking like a live arrangement.
    CONSTRAINT "PriceList_window_check" CHECK ("validTo" IS NULL OR "validTo" >= "validFrom")
);
CREATE UNIQUE INDEX "PriceList_orgId_entityId_code_key" ON "PriceList"("orgId","entityId","code");
CREATE INDEX "PriceList_orgId_entityId_kind_isDefault_idx" ON "PriceList"("orgId","entityId","kind","isDefault");

-- One default per kind at any one time. Two overlapping defaults would make
-- "the list used when a party has no list of its own" a question with two
-- answers, and the resolver would have to pick one arbitrarily. Ranges are
-- half-open: a list ending on the 31st and one starting on the 1st do not
-- overlap, which is how anybody would describe them in words.
ALTER TABLE "PriceList" ADD CONSTRAINT "PriceList_one_default_in_force"
  EXCLUDE USING gist (
    "orgId" WITH =, "entityId" WITH =, "kind" WITH =,
    daterange("validFrom", CASE WHEN "validTo" IS NULL THEN NULL ELSE "validTo" + 1 END, '[)') WITH &&
  ) WHERE ("isDefault");

CREATE TABLE "PriceListEntry" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL,
    "priceListId" TEXT NOT NULL,
    "itemCode" TEXT NOT NULL,
    "minQuantityMilli" BIGINT NOT NULL DEFAULT 0,
    "unitPriceMinor" BIGINT NOT NULL,
    "discountBps" INTEGER NOT NULL DEFAULT 0,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PriceListEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PriceListEntry_list_fkey" FOREIGN KEY ("priceListId")
      REFERENCES "PriceList"("id") ON DELETE CASCADE,
    -- A negative price is a credit, and a credit is a different document.
    CONSTRAINT "PriceListEntry_price_check" CHECK ("unitPriceMinor" >= 0),
    CONSTRAINT "PriceListEntry_quantity_check" CHECK ("minQuantityMilli" >= 0),
    -- A hundred per cent off is free, which is allowed and says so; more than
    -- a hundred per cent off is the customer being paid to take it.
    CONSTRAINT "PriceListEntry_discount_check" CHECK ("discountBps" BETWEEN 0 AND 10000),
    CONSTRAINT "PriceListEntry_window_check" CHECK ("validTo" IS NULL OR "validTo" >= "validFrom")
);
CREATE INDEX "PriceListEntry_orgId_priceListId_itemCode_minQuantityMilli_idx"
  ON "PriceListEntry"("orgId","priceListId","itemCode","minQuantityMilli");

-- The invariant the resolver depends on: within one list, one item and one
-- quantity break may not be priced twice over the same days. Without this a
-- price rise entered without closing the old row leaves both live, and the
-- answer to "what does this cost" depends on row order.
ALTER TABLE "PriceListEntry" ADD CONSTRAINT "PriceListEntry_no_overlap"
  EXCLUDE USING gist (
    "priceListId" WITH =, "itemCode" WITH =, "minQuantityMilli" WITH =,
    daterange("validFrom", CASE WHEN "validTo" IS NULL THEN NULL ELSE "validTo" + 1 END, '[)') WITH &&
  );

CREATE TABLE "PriceListAssignment" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "partyKey" TEXT NOT NULL,
    "priceListId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PriceListAssignment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PriceListAssignment_list_fkey" FOREIGN KEY ("priceListId")
      REFERENCES "PriceList"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "PriceListAssignment_orgId_entityId_partyKey_priceListId_key"
  ON "PriceListAssignment"("orgId","entityId","partyKey","priceListId");
CREATE INDEX "PriceListAssignment_orgId_entityId_partyKey_idx"
  ON "PriceListAssignment"("orgId","entityId","partyKey");
