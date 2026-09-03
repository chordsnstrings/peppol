-- Document numbering, administered.
--
-- `gl_next_number` already guarantees the thing that matters: a number is
-- allocated inside the posting transaction and the sequence row's lock is held
-- to commit, so a posting that rolls back returns its number instead of burning
-- it. Nothing here weakens that. What it adds is the two pieces of
-- configuration a business actually needs and could not previously express:
--
--   1. a prefix that carries the year, and
--   2. a counter that goes back to 1 when a new financial year opens.
--
-- Those two are one feature, not two. A counter that restarts inside a format
-- that does not name the year hands out last year's references again, and two
-- documents that share a reference is exactly what UAE Federal Decree-Law
-- 8/2017 Article 65 and the Executive Regulation on tax invoices forbid: a tax
-- invoice must carry a sequential number that uniquely identifies it. So the
-- database refuses the combination outright rather than trusting the screen to.

-- ── 1. What a series may be configured to do ──────────────────────────────
ALTER TABLE "DocumentSequence"
  ADD COLUMN "restartYearly" BOOLEAN NOT NULL DEFAULT false,
  -- The financial year the counter is currently inside, held as that year's
  -- start date. It is compared at allocation time, which is what makes the
  -- restart a property of the row rather than of whoever asked for a number.
  ADD COLUMN "cycleStart" DATE;

-- The rule above, kept by the database. `{YYYY}` and `{YY}` are expanded when a
-- number is issued; a restarting series must contain one of them.
ALTER TABLE "DocumentSequence"
  ADD CONSTRAINT "DocumentSequence_restart_needs_year_check"
  CHECK (NOT "restartYearly" OR prefix LIKE '%{YYYY}%' OR prefix LIKE '%{YY}%');

-- ── 2. Why the format changed, and from which number ──────────────────────
-- An auditor tracing a reference has to be able to see why the format changed
-- part way through a year. A prefix change is allowed; a prefix change nobody
-- recorded is not, because the trail then simply stops.
CREATE TABLE "DocumentSequenceChange" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- The next number the series will issue, as at the moment of the change.
    -- Everything from here on carries the new format; everything before it
    -- carries the old one.
    "effectiveFromNo" INTEGER NOT NULL,
    "fromPrefix" TEXT NOT NULL,
    "toPrefix" TEXT NOT NULL,
    "fromPadding" INTEGER NOT NULL,
    "toPadding" INTEGER NOT NULL,
    "fromRestartYearly" BOOLEAN NOT NULL DEFAULT false,
    "toRestartYearly" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "actorId" TEXT,

    CONSTRAINT "DocumentSequenceChange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DocumentSequenceChange_orgId_entityId_scope_idx"
  ON "DocumentSequenceChange"("orgId", "entityId", "scope", "changedAt");

-- ── 3. Which year a number belongs to ─────────────────────────────────────
-- One definition, used by the allocator and by the administration screen, so
-- the two can never disagree about when a year turns over. The financial year
-- is the entity's own; a business with no fiscal calendar yet falls back to the
-- calendar year rather than refusing to number anything.
CREATE OR REPLACE FUNCTION gl_sequence_cycle(p_org TEXT, p_entity TEXT)
RETURNS DATE AS $$
DECLARE v_start DATE;
BEGIN
  SELECT "startsOn"::date INTO v_start
    FROM "FiscalYear"
   WHERE "orgId" = p_org AND "entityId" = p_entity
     AND "startsOn" <= current_date AND "endsOn" >= current_date
   ORDER BY "startsOn" DESC
   LIMIT 1;
  RETURN COALESCE(v_start, date_trunc('year', current_date)::date);
END; $$ LANGUAGE plpgsql STABLE;

-- ── 4. The allocator, unchanged where nothing is configured ───────────────
-- Still one statement against the counter row, so it still cannot race and
-- still cannot leave a hole. The restart is expressed inside the UPDATE's own
-- SET, reading the row's own columns — evaluating it beforehand in the caller
-- would let two concurrent first-postings of a new year both decide to reset
-- and both take number 1.
CREATE OR REPLACE FUNCTION gl_next_number(p_org TEXT, p_entity TEXT, p_scope TEXT)
RETURNS TEXT AS $$
DECLARE
  r RECORD;
  v_cycle DATE;
BEGIN
  v_cycle := gl_sequence_cycle(p_org, p_entity);

  INSERT INTO "DocumentSequence" (id, "orgId", "entityId", scope, prefix, "nextNo", padding, "updatedAt", "restartYearly", "cycleStart")
  VALUES (gen_random_uuid()::text, p_org, p_entity, p_scope, '', 2, 5, now(), false, v_cycle)
  ON CONFLICT ("orgId", "entityId", scope) DO UPDATE
    SET "nextNo" = CASE
          WHEN "DocumentSequence"."restartYearly"
           AND "DocumentSequence"."cycleStart" IS DISTINCT FROM v_cycle
          THEN 2
          ELSE "DocumentSequence"."nextNo" + 1
        END,
        "cycleStart" = v_cycle,
        "updatedAt" = now()
  RETURNING prefix, ("nextNo" - 1) AS n, padding INTO r;

  -- The year is written into the number, not kept beside it: a reference that
  -- has to be read with a date to be unique is not a unique reference.
  RETURN replace(replace(r.prefix, '{YYYY}', to_char(v_cycle, 'YYYY')), '{YY}', to_char(v_cycle, 'YY'))
         || lpad(r.n::text, r.padding, '0');
END; $$ LANGUAGE plpgsql;
