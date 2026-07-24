-- CreateTable
CREATE TABLE "OrgBilling" (
    "orgId" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'FREE_MANDATE',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgBilling_pkey" PRIMARY KEY ("orgId")
);

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'EXCHANGE',
    "year" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UsageEvent_orgId_entityId_year_idx" ON "UsageEvent"("orgId", "entityId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "UsageEvent_invoiceId_kind_key" ON "UsageEvent"("invoiceId", "kind");
