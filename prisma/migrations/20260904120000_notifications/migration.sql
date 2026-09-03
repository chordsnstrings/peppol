-- The notification centre.
--
-- Eight modules already work out what the books are waiting for, and every one
-- of them is right about its own corner. Nothing until now put the answers in
-- one queue, and a bookkeeper who has to open eight screens to find out whether
-- anything is on fire opens none of them.
--
-- The findings themselves are NOT stored, and this migration adds no table for
-- them. `attention.ts` explains why beside its own code and the reasoning holds
-- here: a table of nags written when something goes wrong and cleared when
-- somebody remembers is a table that lies within a week. Every row on that
-- screen is recomputed from the ledger on every read, so it disappears the
-- moment the thing that caused it is fixed.
--
-- What IS stored is what people have SAID about those findings, which is a fact
-- about people rather than about the books and cannot be derived from anything.

-- ── 1. The current position on one notification ───────────────────────────
--
-- Keyed on the finding's stable identity: which module said it, which of its
-- checks, and which particular thing it is about (a month, a quarter, a SKU).
-- Never on its wording. Every sentence on that screen is generated from the
-- figures behind it, so an acknowledgement keyed on the message would evaporate
-- the first time a number moved — which is not a memory, it is a rehearsal.
--
-- The severity, count and amount are the finding AS IT STOOD when somebody
-- dealt with it. They are not decoration: the application compares them on
-- every read and the acknowledgement lapses when the finding has got worse.
-- Acknowledging three unreconciled bank lines is a statement about three lines,
-- and forty-seven is not the thing that was acknowledged.
CREATE TABLE "NotificationAck" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    -- Written down beside the id rather than joined at read time: an
    -- acknowledgement is a statement somebody made on a day, and it should
    -- still read as English after that account is closed.
    "actorName" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "severity" TEXT NOT NULL,
    "itemCount" INTEGER,
    "amountMinor" BIGINT,
    "dueOn" DATE,
    "snoozeUntil" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationAck_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "NotificationAck_action_check"
      CHECK ("action" IN ('acknowledged','snoozed')),

    -- A snooze is a day something comes back on; an acknowledgement is not.
    -- Holding the two apart here means neither can be half-recorded: a snooze
    -- with no return date would be an acknowledgement wearing the wrong word,
    -- and it would never come back.
    CONSTRAINT "NotificationAck_snooze_date_check"
      CHECK (("action" = 'snoozed') = ("snoozeUntil" IS NOT NULL)),

    -- THE RULE THIS TABLE EXISTS TO KEEP.
    --
    -- A snooze must run out BEFORE the deadline the finding carries, strictly.
    -- Where that deadline is statutory — the FTA gives 28 days after a tax
    -- period to file and pay — a snooze reaching the deadline is not a deferral
    -- at all, it is a way to miss it, and a return filed late is a penalty that
    -- no screen can undo afterwards. Back one day and not to the day itself,
    -- because a row that reappears on the morning something is due has been put
    -- off past the point of being any use.
    --
    -- It is here and not only in the application because a rule the application
    -- alone enforces is a rule an import, a script or a future module walks
    -- straight through — and this is the one rule on this screen whose failure
    -- costs money.
    CONSTRAINT "NotificationAck_snooze_before_due_check"
      CHECK ("snoozeUntil" IS NULL OR "dueOn" IS NULL OR "snoozeUntil" < "dueOn"),

    -- A count of minus one things, or a severity nothing renders, is a row that
    -- will be read as something it is not.
    CONSTRAINT "NotificationAck_count_check"
      CHECK ("itemCount" IS NULL OR "itemCount" >= 0),
    CONSTRAINT "NotificationAck_severity_check"
      CHECK ("severity" IN ('blocker','warning','advisory','information'))
);

-- One position per finding per entity. The upsert leans on this rather than on
-- a read-then-write, so two people acknowledging the same row at the same
-- moment leave one row and not two.
CREATE UNIQUE INDEX "NotificationAck_orgId_entityId_key_key"
  ON "NotificationAck"("orgId", "entityId", "key");
CREATE INDEX "NotificationAck_orgId_entityId_action_idx"
  ON "NotificationAck"("orgId", "entityId", "action");

-- ── 2. The log ────────────────────────────────────────────────────────────
--
-- The table above holds only the current position and is overwritten in place,
-- so acknowledging over a snooze loses the snooze. This one is appended and
-- never updated. Without it, "why did this row stop showing, and who decided
-- that" has no answer — and that is the question somebody asks precisely when a
-- notification turns out to have mattered.
--
-- There is no unique constraint here on purpose: the same person acknowledging
-- the same finding twice is two statements on two days, and collapsing them
-- would lose the second.
CREATE TABLE "NotificationEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "severity" TEXT,
    "itemCount" INTEGER,
    "amountMinor" BIGINT,
    "snoozeUntil" DATE,

    CONSTRAINT "NotificationEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "NotificationEvent_action_check"
      CHECK ("action" IN ('acknowledged','snoozed','cleared'))
);

CREATE INDEX "NotificationEvent_orgId_entityId_key_at_idx"
  ON "NotificationEvent"("orgId", "entityId", "key", "at");
