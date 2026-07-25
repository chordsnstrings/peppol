-- AlterTable
ALTER TABLE "OrgBilling" ADD COLUMN     "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "currentPeriodEnd" TIMESTAMP(3),
ADD COLUMN     "dunningStage" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "graceEndsAt" TIMESTAMP(3),
ADD COLUMN     "lastPaymentAt" TIMESTAMP(3),
ADD COLUMN     "providerCustomerId" TEXT,
ADD COLUMN     "providerSubscriptionId" TEXT,
ADD COLUMN     "subStatus" TEXT NOT NULL DEFAULT 'trialing',
ADD COLUMN     "subTier" TEXT,
ADD COLUMN     "trialEndsAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'invoice',
ADD COLUMN     "tier" TEXT,
ALTER COLUMN "invoiceId" DROP NOT NULL;
