-- CreateTable
CREATE TABLE "Transmission" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "gatewayRef" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "driver" TEXT NOT NULL,
    "exchangeStatus" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "reportingStatus" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "ublXml" TEXT NOT NULL,
    "tddXml" TEXT NOT NULL,
    "error" TEXT,
    "lastEventAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Transmission_gatewayRef_key" ON "Transmission"("gatewayRef");

-- CreateIndex
CREATE UNIQUE INDEX "Transmission_idempotencyKey_key" ON "Transmission"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Transmission_orgId_idx" ON "Transmission"("orgId");

-- CreateIndex
CREATE INDEX "Transmission_invoiceId_idx" ON "Transmission"("invoiceId");
