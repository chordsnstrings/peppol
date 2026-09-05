-- Who closed the month, and who locked it.
--
-- `closedAt` recorded when, and nothing recorded who. Locking a period is the
-- one irreversible act in this product — a locked period never reopens,
-- whoever asks — and it was the only significant decision the ledger took no
-- name for. Every posted journal entry carries an actor; the act that freezes
-- a whole month of them carried none.
--
-- Reopening is recorded in the same pair rather than in a second one: the
-- fields say who last moved this period's status and when, and reopening sets
-- them to the person who reopened it. The history of every move is not here —
-- that would be a table — but the question somebody actually asks at an audit
-- is "who shut this", and that is answerable now.
--
-- NULL means a period whose status was last changed before this column
-- existed, or one that was never closed. Both are honest absences, and the
-- screen says "not recorded" rather than inventing a name.
ALTER TABLE "AccountingPeriod"
  ADD COLUMN "closedBy" TEXT;
