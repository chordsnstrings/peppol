-- CreateTable
CREATE TABLE "Book" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL DEFAULT 'PRIMARY',
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'PRIMARY',
    "functionalCurrency" TEXT NOT NULL DEFAULT 'AED',
    "presentationCurrency" TEXT NOT NULL DEFAULT 'AED',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Book_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "type" TEXT NOT NULL,
    "subtype" TEXT,
    "parentId" TEXT,
    "isPostable" BOOLEAN NOT NULL DEFAULT true,
    "isControl" BOOLEAN NOT NULL DEFAULT false,
    "currency" TEXT,
    "requiresDimension" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiscalYear" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',

    CONSTRAINT "FiscalYear_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingPeriod" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fiscalYearId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "isAdjustment" BOOLEAN NOT NULL DEFAULT false,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "AccountingPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dimension" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "Dimension_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DimensionValue" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "dimensionId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "DimensionValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "series" TEXT NOT NULL DEFAULT 'GJ',
    "number" TEXT NOT NULL,
    "entryDate" DATE NOT NULL,
    "postedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'draft',
    "memo" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sourceType" TEXT,
    "sourceId" TEXT,
    "externalKey" TEXT,
    "reversalOfId" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'HUMAN',
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalLine" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "accountId" TEXT NOT NULL,
    "txnCurrency" TEXT NOT NULL,
    "txnAmountMinor" BIGINT NOT NULL,
    "fxRate" DECIMAL(20,10) NOT NULL DEFAULT 1,
    "functionalCurrency" TEXT NOT NULL,
    "functionalAmountMinor" BIGINT NOT NULL,
    "memo" TEXT,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalLineDimension" (
    "id" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "dimensionId" TEXT NOT NULL,
    "valueId" TEXT NOT NULL,

    CONSTRAINT "JournalLineDimension_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountBalance" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "openingMinor" BIGINT NOT NULL DEFAULT 0,
    "debitMinor" BIGINT NOT NULL DEFAULT 0,
    "creditMinor" BIGINT NOT NULL DEFAULT 0,
    "closingMinor" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentSequence" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT '',
    "nextNo" INTEGER NOT NULL DEFAULT 1,
    "padding" INTEGER NOT NULL DEFAULT 5,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentSequence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Book_orgId_entityId_idx" ON "Book"("orgId", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "Book_orgId_entityId_code_key" ON "Book"("orgId", "entityId", "code");

-- CreateIndex
CREATE INDEX "Account_orgId_entityId_type_idx" ON "Account"("orgId", "entityId", "type");

-- CreateIndex
CREATE INDEX "Account_parentId_idx" ON "Account"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_orgId_entityId_code_key" ON "Account"("orgId", "entityId", "code");

-- CreateIndex
CREATE INDEX "FiscalYear_orgId_entityId_idx" ON "FiscalYear"("orgId", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalYear_orgId_entityId_label_key" ON "FiscalYear"("orgId", "entityId", "label");

-- CreateIndex
CREATE INDEX "AccountingPeriod_orgId_entityId_startsOn_endsOn_idx" ON "AccountingPeriod"("orgId", "entityId", "startsOn", "endsOn");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingPeriod_orgId_entityId_label_key" ON "AccountingPeriod"("orgId", "entityId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "Dimension_orgId_code_key" ON "Dimension"("orgId", "code");

-- CreateIndex
CREATE INDEX "DimensionValue_orgId_idx" ON "DimensionValue"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "DimensionValue_dimensionId_code_key" ON "DimensionValue"("dimensionId", "code");

-- CreateIndex
CREATE INDEX "JournalEntry_orgId_entityId_periodId_idx" ON "JournalEntry"("orgId", "entityId", "periodId");

-- CreateIndex
CREATE INDEX "JournalEntry_orgId_sourceType_sourceId_idx" ON "JournalEntry"("orgId", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "JournalEntry_orgId_entityId_entryDate_idx" ON "JournalEntry"("orgId", "entityId", "entryDate");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_orgId_entityId_bookId_series_number_key" ON "JournalEntry"("orgId", "entityId", "bookId", "series", "number");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_orgId_externalKey_key" ON "JournalEntry"("orgId", "externalKey");

-- CreateIndex
CREATE INDEX "JournalLine_orgId_accountId_idx" ON "JournalLine"("orgId", "accountId");

-- CreateIndex
CREATE INDEX "JournalLine_entryId_idx" ON "JournalLine"("entryId");

-- CreateIndex
CREATE UNIQUE INDEX "JournalLine_entryId_lineNo_key" ON "JournalLine"("entryId", "lineNo");

-- CreateIndex
CREATE INDEX "JournalLineDimension_valueId_idx" ON "JournalLineDimension"("valueId");

-- CreateIndex
CREATE UNIQUE INDEX "JournalLineDimension_lineId_dimensionId_key" ON "JournalLineDimension"("lineId", "dimensionId");

-- CreateIndex
CREATE INDEX "AccountBalance_orgId_entityId_periodId_idx" ON "AccountBalance"("orgId", "entityId", "periodId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountBalance_bookId_accountId_periodId_currency_key" ON "AccountBalance"("bookId", "accountId", "periodId", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentSequence_orgId_entityId_scope_key" ON "DocumentSequence"("orgId", "entityId", "scope");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Account"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AccountingPeriod" ADD CONSTRAINT "AccountingPeriod_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "FiscalYear"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DimensionValue" ADD CONSTRAINT "DimensionValue_dimensionId_fkey" FOREIGN KEY ("dimensionId") REFERENCES "Dimension"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "AccountingPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "JournalEntry"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLineDimension" ADD CONSTRAINT "JournalLineDimension_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "JournalLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLineDimension" ADD CONSTRAINT "JournalLineDimension_valueId_fkey" FOREIGN KEY ("valueId") REFERENCES "DimensionValue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountBalance" ADD CONSTRAINT "AccountBalance_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountBalance" ADD CONSTRAINT "AccountBalance_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountBalance" ADD CONSTRAINT "AccountBalance_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "AccountingPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- LEDGER INVARIANTS
-- Enforced by the database, not the application. An unbalanced journal, a post
-- into a closed period, or an edit to a posted entry must be IMPOSSIBLE — not
-- merely discouraged by a code path someone can forget to call.
-- ═══════════════════════════════════════════════════════════════════════════

-- String enums as real check constraints.
ALTER TABLE "Account" ADD CONSTRAINT "account_type_chk"
  CHECK (type IN ('ASSET','LIABILITY','EQUITY','INCOME','EXPENSE'));
ALTER TABLE "JournalEntry" ADD CONSTRAINT "entry_status_chk"
  CHECK (status IN ('draft','posted','reversed'));
ALTER TABLE "AccountingPeriod" ADD CONSTRAINT "period_status_chk"
  CHECK (status IN ('open','soft_closed','hard_closed','locked'));

-- ── 1. A posted entry balances to zero, per currency ──────────────────────
-- Deferred to COMMIT so lines can be inserted one at a time in a transaction.
CREATE OR REPLACE FUNCTION gl_check_entry_balance(p_entry_id TEXT) RETURNS VOID AS $$
DECLARE r RECORD; n INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "JournalEntry" WHERE id = p_entry_id AND status IN ('posted','reversed')) THEN
    RETURN;  -- drafts may be unbalanced while they are being written
  END IF;

  FOR r IN SELECT "txnCurrency" AS cur, SUM("txnAmountMinor") AS s
             FROM "JournalLine" WHERE "entryId" = p_entry_id GROUP BY "txnCurrency"
  LOOP
    IF r.s <> 0 THEN
      RAISE EXCEPTION 'ledger: entry % does not balance in % (net %)', p_entry_id, r.cur, r.s
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

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

CREATE OR REPLACE FUNCTION gl_line_balance_trg() RETURNS TRIGGER AS $$
BEGIN
  PERFORM gl_check_entry_balance(COALESCE(NEW."entryId", OLD."entryId"));
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "gl_line_balance"
  AFTER INSERT OR UPDATE OR DELETE ON "JournalLine"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION gl_line_balance_trg();

CREATE OR REPLACE FUNCTION gl_entry_balance_trg() RETURNS TRIGGER AS $$
BEGIN
  PERFORM gl_check_entry_balance(NEW."id");
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "gl_entry_balance"
  AFTER INSERT OR UPDATE ON "JournalEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION gl_entry_balance_trg();

-- ── 2. Closed periods refuse postings; posted entries are immutable ───────
CREATE OR REPLACE FUNCTION gl_entry_guard() RETURNS TRIGGER AS $$
DECLARE v_status TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('posted','reversed') THEN
      RAISE EXCEPTION 'ledger: posted entry % cannot be deleted — correct by reversal', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status IN ('posted','reversed') THEN
    IF NEW."bookId"    IS DISTINCT FROM OLD."bookId"
    OR NEW."periodId"  IS DISTINCT FROM OLD."periodId"
    OR NEW."entryDate" IS DISTINCT FROM OLD."entryDate"
    OR NEW."number"    IS DISTINCT FROM OLD."number"
    OR NEW."series"    IS DISTINCT FROM OLD."series"
    OR NEW."orgId"     IS DISTINCT FROM OLD."orgId"
    OR NEW."entityId"  IS DISTINCT FROM OLD."entityId" THEN
      RAISE EXCEPTION 'ledger: posted entry % is immutable — correct by reversal', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'reversed' AND NEW.status <> 'reversed' THEN
      RAISE EXCEPTION 'ledger: entry % is already reversed', OLD.id USING ERRCODE = 'check_violation';
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

CREATE TRIGGER "gl_entry_guard_trg" BEFORE INSERT OR UPDATE OR DELETE ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION gl_entry_guard();

-- ── 3. Line-level rules: postable, active, right entity, control-account ──
CREATE OR REPLACE FUNCTION gl_line_guard() RETURNS TRIGGER AS $$
DECLARE v_entry RECORD; v_acct RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT * INTO v_entry FROM "JournalEntry" WHERE id = OLD."entryId";
    IF FOUND AND v_entry.status IN ('posted','reversed') THEN
      RAISE EXCEPTION 'ledger: lines of a posted entry cannot be deleted' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  SELECT * INTO v_entry FROM "JournalEntry" WHERE id = NEW."entryId";
  IF TG_OP = 'UPDATE' AND v_entry.status IN ('posted','reversed') THEN
    RAISE EXCEPTION 'ledger: lines of a posted entry cannot be modified' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_acct FROM "Account" WHERE id = NEW."accountId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger: unknown account' USING ERRCODE = 'check_violation';
  END IF;
  IF v_acct."entityId" <> v_entry."entityId" THEN
    RAISE EXCEPTION 'ledger: account % belongs to another legal entity', v_acct.code USING ERRCODE = 'check_violation';
  END IF;
  IF NOT v_acct."isPostable" THEN
    RAISE EXCEPTION 'ledger: account % is a header account and cannot be posted to', v_acct.code USING ERRCODE = 'check_violation';
  END IF;
  IF v_acct.status <> 'active' THEN
    RAISE EXCEPTION 'ledger: account % is archived', v_acct.code USING ERRCODE = 'check_violation';
  END IF;
  IF v_acct."isControl" AND v_entry.source = 'manual' THEN
    RAISE EXCEPTION 'ledger: account % is a control account — post through its subledger', v_acct.code USING ERRCODE = 'check_violation';
  END IF;
  IF v_acct.currency IS NOT NULL AND v_acct.currency <> NEW."txnCurrency" THEN
    RAISE EXCEPTION 'ledger: account % only accepts %', v_acct.code, v_acct.currency USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."txnAmountMinor" = 0 THEN
    RAISE EXCEPTION 'ledger: a zero-amount line carries no information' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "gl_line_guard_trg" BEFORE INSERT OR UPDATE OR DELETE ON "JournalLine"
  FOR EACH ROW EXECUTE FUNCTION gl_line_guard();

-- ── 4. Gapless numbering, allocated atomically inside the posting txn ─────
CREATE OR REPLACE FUNCTION gl_next_number(p_org TEXT, p_entity TEXT, p_scope TEXT)
RETURNS TEXT AS $$
DECLARE r RECORD;
BEGIN
  UPDATE "DocumentSequence"
     SET "nextNo" = "nextNo" + 1, "updatedAt" = now()
   WHERE "orgId" = p_org AND "entityId" = p_entity AND scope = p_scope
  RETURNING prefix, ("nextNo" - 1) AS n, padding INTO r;

  IF NOT FOUND THEN
    INSERT INTO "DocumentSequence" (id, "orgId", "entityId", scope, prefix, "nextNo", padding, "updatedAt")
    VALUES (gen_random_uuid()::text, p_org, p_entity, p_scope, '', 2, 5, now())
    RETURNING prefix, 1 AS n, padding INTO r;
  END IF;

  RETURN r.prefix || lpad(r.n::text, r.padding, '0');
END; $$ LANGUAGE plpgsql;
