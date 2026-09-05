-- A project's budget was a single column, so revising it overwrote the figure
-- actual was being measured against and left nothing behind: the overspend
-- vanished the moment somebody raised the number, and who raised it was not
-- recorded either.
--
-- The reason is NOT NULL and checked non-blank on purpose. A revision nobody
-- has to justify is the thing this table exists to prevent.
CREATE TABLE "ProjectBudgetRevision" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "priorMinor" BIGINT NOT NULL,
    "budgetMinor" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "revisedBy" TEXT,
    "revisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectBudgetRevision_pkey" PRIMARY KEY ("id")
);

-- A revision that changes nothing is not a revision, and recording one would
-- put a row in the history saying the budget stayed the same.
ALTER TABLE "ProjectBudgetRevision"
  ADD CONSTRAINT "ProjectBudgetRevision_moved_check"
  CHECK ("priorMinor" <> "budgetMinor");

ALTER TABLE "ProjectBudgetRevision"
  ADD CONSTRAINT "ProjectBudgetRevision_reason_check"
  CHECK (length(btrim("reason")) > 0);

CREATE INDEX "ProjectBudgetRevision_orgId_projectId_revisedAt_idx"
  ON "ProjectBudgetRevision"("orgId", "projectId", "revisedAt");
