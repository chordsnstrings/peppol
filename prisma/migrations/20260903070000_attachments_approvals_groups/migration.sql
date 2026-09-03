-- Attachments, approval rules and consolidation groups.

CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityId" TEXT,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "uploadedBy" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Attachment_subject_check"
      CHECK ("subjectType" IN ('JOURNAL_ENTRY','INVOICE','BILL','EXPENSE_CLAIM','ASSET','BANK_LINE')),
    -- An empty file is not evidence of anything.
    CONSTRAINT "Attachment_size_check" CHECK ("sizeBytes" > 0),
    -- A SHA-256 is 64 hex characters. Anything else is not a hash, and an
    -- attachment whose hash cannot be checked cannot be proved unaltered.
    CONSTRAINT "Attachment_sha_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "ApprovalRule" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "thresholdMinor" BIGINT NOT NULL DEFAULT 0,
    "approversRequired" INTEGER NOT NULL DEFAULT 1,
    "approverRole" TEXT,
    "approverUserId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalRule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ApprovalRule_subject_check"
      CHECK ("subjectType" IN ('JOURNAL','BILL','EXPENSE_CLAIM','PAYMENT','PAYROLL')),
    CONSTRAINT "ApprovalRule_threshold_check" CHECK ("thresholdMinor" >= 0),
    -- A rule requiring nobody is not a control. A rule requiring more than five
    -- is almost certainly a mistake that would deadlock the business.
    CONSTRAINT "ApprovalRule_approvers_check"
      CHECK ("approversRequired" >= 1 AND "approversRequired" <= 5)
);

CREATE TABLE "ApprovalDecision" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "decidedBy" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "amountMinor" BIGINT,
    "reason" TEXT,

    CONSTRAINT "ApprovalDecision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ApprovalDecision_decision_check" CHECK ("decision" IN ('APPROVED','REJECTED')),
    -- A rejection has to say why. An unexplained rejection is a dead end for
    -- whoever has to fix the thing.
    CONSTRAINT "ApprovalDecision_reason_check"
      CHECK ("decision" = 'APPROVED' OR "reason" IS NOT NULL)
);

CREATE TABLE "ConsolidationGroup" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsolidationGroup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ConsolidationMember" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "ownershipBps" INTEGER NOT NULL DEFAULT 10000,
    "isParent" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ConsolidationMember_pkey" PRIMARY KEY ("id"),
    -- Ownership below nothing or above the whole is not ownership.
    CONSTRAINT "ConsolidationMember_ownership_check"
      CHECK ("ownershipBps" > 0 AND "ownershipBps" <= 10000)
);

ALTER TABLE "ConsolidationMember" ADD CONSTRAINT "ConsolidationMember_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "ConsolidationGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Attachment_orgId_subjectType_subjectId_idx" ON "Attachment"("orgId", "subjectType", "subjectId");
CREATE INDEX "Attachment_orgId_sha256_idx" ON "Attachment"("orgId", "sha256");
CREATE INDEX "ApprovalRule_orgId_entityId_subjectType_active_idx" ON "ApprovalRule"("orgId", "entityId", "subjectType", "active");
-- One person, one decision per subject. Without this the same approver could
-- satisfy a two-approver rule twice over, which is the whole point of the rule.
CREATE UNIQUE INDEX "ApprovalDecision_orgId_subjectType_subjectId_decidedBy_key"
  ON "ApprovalDecision"("orgId", "subjectType", "subjectId", "decidedBy");
CREATE INDEX "ApprovalDecision_orgId_entityId_subjectType_subjectId_idx"
  ON "ApprovalDecision"("orgId", "entityId", "subjectType", "subjectId");
CREATE UNIQUE INDEX "ConsolidationGroup_orgId_code_key" ON "ConsolidationGroup"("orgId", "code");
CREATE UNIQUE INDEX "ConsolidationMember_groupId_entityId_key" ON "ConsolidationMember"("groupId", "entityId");
CREATE INDEX "ConsolidationMember_orgId_groupId_idx" ON "ConsolidationMember"("orgId", "groupId");
