-- Loans and borrowings, measured at amortised cost under IFRS 9.
--
-- The arithmetic is the lease liability's, pointed at a bank facility: an
-- effective-interest schedule that unwinds to exactly nil. Two things make a
-- borrowing different, and the columns here follow from both.
--
-- A lease's discount rate is a judgement (IFRS 16.26, the incremental borrowing
-- rate) and is held to the basis point. A loan's rate is a term of the
-- contract, and a schedule has to reproduce the lender's own to the fil, so the
-- application carries the PERIODIC rate at a finer scale than a basis point.
-- What is stored here is still whole basis points, because that is the unit a
-- facility quotes and the unit anyone queries in.
--
-- And a flat rate is charged on the sum originally advanced however much has
-- been repaid, so its effective rate is close to twice the quoted one. Both are
-- stored: `statedRateBps` is what the offer letter says, `effectiveRateBps` is
-- what IFRS 9.5.4.1 measures at. Storing only the first would make the accounts
-- wrong; storing only the second would make them unreconcilable to the bank.

CREATE TABLE "Borrowing" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "lender" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "principalMinor" BIGINT NOT NULL,
    "drawdownOn" DATE NOT NULL,
    "statedRateBps" INTEGER NOT NULL,
    "interestBasis" TEXT NOT NULL DEFAULT 'REDUCING',
    "frequency" TEXT NOT NULL DEFAULT 'MONTHLY',
    "termMonths" INTEGER NOT NULL,
    "instalmentMinor" BIGINT NOT NULL DEFAULT 0,
    "effectiveRateBps" INTEGER NOT NULL DEFAULT 0,
    "outstandingMinor" BIGINT NOT NULL DEFAULT 0,
    "currentPortionMinor" BIGINT NOT NULL DEFAULT 0,
    "paidTo" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Borrowing_pkey" PRIMARY KEY ("id"),
    -- A loan for nothing is not a loan.
    CONSTRAINT "Borrowing_principal_check" CHECK ("principalMinor" > 0),
    CONSTRAINT "Borrowing_term_check" CHECK ("termMonths" > 0),
    -- A rate is a whole number of basis points between nil and 100%. Held as an
    -- integer so it can never arrive as a float that disagrees with itself.
    CONSTRAINT "Borrowing_stated_rate_check" CHECK ("statedRateBps" >= 0 AND "statedRateBps" <= 10000),
    CONSTRAINT "Borrowing_effective_rate_check" CHECK ("effectiveRateBps" >= 0 AND "effectiveRateBps" <= 10000),
    CONSTRAINT "Borrowing_basis_check" CHECK ("interestBasis" IN ('REDUCING','FLAT')),
    CONSTRAINT "Borrowing_frequency_check" CHECK ("frequency" IN ('MONTHLY','QUARTERLY','SEMIANNUAL','ANNUAL')),
    CONSTRAINT "Borrowing_status_check" CHECK ("status" IN ('draft','active','settled')),
    -- A borrowing is a liability or it is nothing. A negative balance would be
    -- a receivable from the lender, which is a different thing entirely, and it
    -- is how an over-applied repayment would otherwise hide.
    CONSTRAINT "Borrowing_outstanding_check" CHECK ("outstandingMinor" >= 0),
    -- The current portion is part of what is outstanding, never more than it.
    -- IAS 1.69 splits the liability; it cannot invent any.
    CONSTRAINT "Borrowing_current_portion_check"
      CHECK ("currentPortionMinor" >= 0 AND "currentPortionMinor" <= "outstandingMinor"),
    CONSTRAINT "Borrowing_paid_to_check" CHECK ("paidTo" >= 0)
);
CREATE UNIQUE INDEX "Borrowing_orgId_entityId_code_key" ON "Borrowing"("orgId","entityId","code");
CREATE INDEX "Borrowing_orgId_entityId_status_idx" ON "Borrowing"("orgId","entityId","status");

CREATE TABLE "BorrowingCovenant" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "borrowingId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'MIN',
    "thresholdBps" INTEGER,
    "thresholdMinor" BIGINT,
    "wording" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BorrowingCovenant_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BorrowingCovenant_borrowingId_fkey" FOREIGN KEY ("borrowingId")
      REFERENCES "Borrowing"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BorrowingCovenant_metric_check"
      CHECK ("metric" IN ('CURRENT_RATIO','DEBT_TO_EQUITY','INTEREST_COVER','MIN_NET_WORTH','OTHER')),
    CONSTRAINT "BorrowingCovenant_direction_check" CHECK ("direction" IN ('MIN','MAX')),
    -- A covenant with no threshold and no wording is a row that means nothing to
    -- whoever reads it next. A ratio needs its basis points, an amount needs its
    -- minor units, and one that cannot be tested here has to say what it wants.
    CONSTRAINT "BorrowingCovenant_threshold_check" CHECK (
      ("metric" IN ('CURRENT_RATIO','DEBT_TO_EQUITY','INTEREST_COVER') AND "thresholdBps" IS NOT NULL)
      OR ("metric" = 'MIN_NET_WORTH' AND "thresholdMinor" IS NOT NULL)
      OR ("metric" = 'OTHER' AND "wording" IS NOT NULL)
    ),
    CONSTRAINT "BorrowingCovenant_bps_check" CHECK ("thresholdBps" IS NULL OR "thresholdBps" >= 0)
);
CREATE UNIQUE INDEX "BorrowingCovenant_orgId_borrowingId_code_key"
  ON "BorrowingCovenant"("orgId","borrowingId","code");
CREATE INDEX "BorrowingCovenant_orgId_borrowingId_idx" ON "BorrowingCovenant"("orgId","borrowingId");

-- The current portion of borrowings, for books already open.
--
-- IAS 1.69 requires the part of a liability falling due within twelve months of
-- the reporting date to be presented as current. In this product it is the
-- chart's own numbering that tells the statements which liabilities are
-- current: the summarised balance sheet reads 2000–2499 as current and
-- 2500–2999 as non-current. So the current portion needs an account inside the
-- first band, or the split is one no statement can present — which is why it is
-- 2450 and not, say, 2520 beside the long-term loan account it comes out of.
--
-- The seeded chart in setup.ts does not carry it yet and needs the same row.
INSERT INTO "Account" ("id","orgId","entityId","code","name","nameAr","type","subtype","parentId","isPostable","isControl","createdAt")
SELECT md5(random()::text || clock_timestamp()::text), b."orgId", b."entityId",
       '2450', 'Borrowings — current portion', 'الجزء المتداول من القروض', 'LIABILITY', NULL,
       (SELECT p.id FROM "Account" p WHERE p."orgId" = b."orgId" AND p."entityId" = b."entityId" AND p."code" = '20'),
       true, false, NOW()
FROM (SELECT DISTINCT "orgId", "entityId" FROM "Account") b
WHERE NOT EXISTS (
  SELECT 1 FROM "Account" a WHERE a."orgId" = b."orgId" AND a."entityId" = b."entityId" AND a."code" = '2450'
);
