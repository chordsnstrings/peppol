-- Three holes in the ledger_core guards, found by reviewing the guards against
-- what they are supposed to guarantee rather than against what they check.
--
-- 1. Immutability was a denylist. It named seven columns, so `memo`, `source`,
--    `actorId`, `externalKey` and every column added in future were quietly
--    editable on a posted entry — the exact rewrite-history hole the guard
--    exists to close. It is now an allowlist: everything is frozen except the
--    few fields a legitimate reversal has to touch.
--
-- 2. `posted → draft` was not blocked. The guard refused `reversed → *` but
--    let a posted entry go back to draft, from where it could be edited or
--    deleted outright — a two-step route around the immutability rule.
--
-- 3. `gl_next_number` raced. Two concurrent first-postings for a scope both
--    take the NOT FOUND branch and both INSERT, so one loses on the unique
--    index. Gapless numbering that fails under concurrency is not gapless.

-- ── 1 + 2. Entry guard: allowlist immutability and a status transition matrix ──
CREATE OR REPLACE FUNCTION gl_entry_guard() RETURNS TRIGGER AS $$
DECLARE
  v_status TEXT;
  -- The only field that legitimately changes on a posted entry is `status`,
  -- and only posted → reversed. Everything else is frozen, including every
  -- column added to JournalEntry in future — a new column is immutable by
  -- default, which is the safe direction to be wrong in.
  k_mutable CONSTANT TEXT[] := ARRAY['status'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('posted','reversed') THEN
      RAISE EXCEPTION 'ledger: posted entry % cannot be deleted — correct by reversal', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status IN ('posted','reversed') THEN
    -- Compare the two rows as JSON with the mutable keys removed. Anything
    -- left over is a change to a frozen field, whatever it is called.
    IF (to_jsonb(NEW) - k_mutable) IS DISTINCT FROM (to_jsonb(OLD) - k_mutable) THEN
      RAISE EXCEPTION 'ledger: posted entry % is immutable — correct by reversal', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;

    -- The status machine, stated in full rather than by exception.
    --   posted  → reversed        (the only correction)
    --   reversed→ reversed        (no-op)
    -- Everything else, including posted → draft, is refused.
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NOT (OLD.status = 'posted' AND NEW.status = 'reversed') THEN
        RAISE EXCEPTION 'ledger: entry % cannot move from % to % — a posted entry is corrected by reversal, never unposted',
          OLD.id, OLD.status, NEW.status USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW.status = 'posted' THEN
    SELECT status INTO v_status FROM "AccountingPeriod" WHERE id = NEW."periodId";
    IF v_status IS NULL THEN
      RAISE EXCEPTION 'ledger: entry % has no accounting period', NEW.id USING ERRCODE = 'check_violation';
    END IF;
    IF v_status <> 'open' THEN
      RAISE EXCEPTION 'ledger: accounting period is % — posting refused', v_status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."postedAt" IS NULL THEN NEW."postedAt" := now(); END IF;
  END IF;

  RETURN NEW;
END; $$ LANGUAGE plpgsql;

-- ── 3. Gapless numbering that survives concurrency ──
CREATE OR REPLACE FUNCTION gl_next_number(p_org TEXT, p_entity TEXT, p_scope TEXT)
RETURNS TEXT AS $$
DECLARE r RECORD;
BEGIN
  -- One statement, no NOT FOUND branch to race on. The row is created if it is
  -- missing and incremented if it is not; the loser of a concurrent insert
  -- takes the DO UPDATE path and still gets a distinct number. The row lock
  -- held to commit is what makes the sequence gapless — a plain Postgres
  -- SEQUENCE would not be, since it does not roll back.
  INSERT INTO "DocumentSequence" (id, "orgId", "entityId", scope, prefix, "nextNo", padding, "updatedAt")
  VALUES (gen_random_uuid()::text, p_org, p_entity, p_scope, '', 2, 5, now())
  ON CONFLICT ("orgId", "entityId", scope) DO UPDATE
    SET "nextNo" = "DocumentSequence"."nextNo" + 1, "updatedAt" = now()
  RETURNING prefix, ("nextNo" - 1) AS n, padding INTO r;

  RETURN r.prefix || lpad(r.n::text, r.padding, '0');
END; $$ LANGUAGE plpgsql;
