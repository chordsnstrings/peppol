-- Correct the balance invariant for cross-currency entries.
--
-- The original rule required every entry to balance within each transaction
-- currency. That is wrong: a genuine FX transaction — receiving USD into an AED
-- ledger, say — is a single economic event whose two sides are in different
-- currencies and which balances only after conversion.
--
-- The real double-entry invariant is the FUNCTIONAL-currency balance, and that
-- is what makes a trial balance tie. Per-currency balance is still enforced for
-- single-currency entries, where it costs nothing and produces a much better
-- error message for the common mistake.
CREATE OR REPLACE FUNCTION gl_check_entry_balance(p_entry_id TEXT) RETURNS VOID AS $$
DECLARE r RECORD; n INT; n_cur INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "JournalEntry" WHERE id = p_entry_id AND status IN ('posted','reversed')) THEN
    RETURN;
  END IF;

  SELECT COUNT(DISTINCT "txnCurrency") INTO n_cur FROM "JournalLine" WHERE "entryId" = p_entry_id;

  IF n_cur = 1 THEN
    FOR r IN SELECT "txnCurrency" AS cur, SUM("txnAmountMinor") AS s
               FROM "JournalLine" WHERE "entryId" = p_entry_id GROUP BY "txnCurrency"
    LOOP
      IF r.s <> 0 THEN
        RAISE EXCEPTION 'ledger: entry % does not balance in % (net %)', p_entry_id, r.cur, r.s
          USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END IF;

  -- Always: the ledger balances in the functional currency.
  IF (SELECT COALESCE(SUM("functionalAmountMinor"),0) FROM "JournalLine" WHERE "entryId" = p_entry_id) <> 0 THEN
    RAISE EXCEPTION 'ledger: entry % does not balance in functional currency', p_entry_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COUNT(*) INTO n FROM "JournalLine" WHERE "entryId" = p_entry_id;
  IF n < 2 THEN
    RAISE EXCEPTION 'ledger: entry % must have at least two lines', p_entry_id
      USING ERRCODE = 'check_violation';
  END IF;
END; $$ LANGUAGE plpgsql;
