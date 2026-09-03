-- The control-account rule could be walked around in three steps.
--
-- gl_line_guard reads the entry's `source` at the moment a LINE is written,
-- and refuses a control-account line on a manual entry. Nothing re-checked
-- when the entry's `source` changed afterwards, and the allowlist immutability
-- in gl_entry_guard only applies once an entry is posted. So:
--
--   1. insert a draft entry with source = 'invoice'
--   2. add lines on 1100 — allowed, the source is not 'manual'
--   3. update the entry to source = 'manual', then to status = 'posted'
--
-- and a manual journal sits on the receivables control account, which is the
-- one thing that rule exists to prevent. post() never creates drafts, so the
-- product itself cannot do this; the point is that the database's guarantee
-- was weaker than it read, and a guarantee is only worth what it holds against
-- everything, not against the code that happens to be written today.
--
-- The check is re-run whenever the source changes and again at the moment of
-- posting, which is the last point at which anything can be caught.

CREATE OR REPLACE FUNCTION gl_entry_guard() RETURNS TRIGGER AS $$
DECLARE
  v_status TEXT;
  v_control TEXT;
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
    IF (to_jsonb(NEW) - k_mutable) IS DISTINCT FROM (to_jsonb(OLD) - k_mutable) THEN
      RAISE EXCEPTION 'ledger: posted entry % is immutable — correct by reversal', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NOT (OLD.status = 'posted' AND NEW.status = 'reversed') THEN
        RAISE EXCEPTION 'ledger: entry % cannot move from % to % — a posted entry is corrected by reversal, never unposted',
          OLD.id, OLD.status, NEW.status USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  -- Whenever an entry becomes manual, or is posted at all, its lines are
  -- re-checked against the control-account rule. The line guard cannot do this
  -- itself: it fires on the line, and the source it read was true then.
  IF NEW.source = 'manual'
     AND (TG_OP = 'INSERT'
          OR NEW.source IS DISTINCT FROM OLD.source
          OR (NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted')) THEN
    SELECT a.code INTO v_control
    FROM "JournalLine" l
    JOIN "Account" a ON a.id = l."accountId"
    WHERE l."entryId" = NEW.id AND a."isControl"
    LIMIT 1;
    IF v_control IS NOT NULL THEN
      RAISE EXCEPTION 'ledger: account % is a control account — post through its subledger', v_control
        USING ERRCODE = 'check_violation';
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
