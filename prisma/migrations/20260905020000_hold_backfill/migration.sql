-- One hold, not two.
--
-- Counterparty.onHold and CreditHold were separate stores. The Customers screen
-- wrote the flag; credit-control.ts derives holds exclusively from CreditHold
-- rows and never reads the flag. So a hold placed from the Customers screen
-- produced "allow" from creditCheck, counted as nought in the on-hold summary,
-- and showed an empty history — while the Customers chip and
-- checkCreditBeforeSale both honoured it. The screen said the opposite at the
-- moment of the act: "A hold stops the next order."
--
-- The module now writes both. This brings the records already flagged into
-- line, so a hold placed before today starts being enforced rather than
-- silently continuing not to be.
--
-- placedOn is the counterparty's own updatedAt: the flag carries no date of its
-- own, and that is the closest thing to when it was set. It is stated in the
-- reason rather than presented as a fact the record actually held.

INSERT INTO "CreditHold" ("id","orgId","entityId","partyKey","placedOn","placedBy","reason","createdAt")
SELECT md5(random()::text || clock_timestamp()::text || c."id"),
       c."orgId", c."entityId", lower(btrim(c."code")),
       c."updatedAt"::date,
       NULL,
       COALESCE(NULLIF(btrim(c."holdReason"), ''), 'Held on the customer record before holds were unified; no reason was recorded')
         || ' (backfilled: the date shown is when the customer record last changed, not necessarily when the hold was placed)',
       NOW()
FROM "Counterparty" c
WHERE c."onHold"
  AND NOT EXISTS (
    SELECT 1 FROM "CreditHold" h
     WHERE h."orgId" = c."orgId" AND h."entityId" = c."entityId"
       AND h."partyKey" = lower(btrim(c."code")) AND h."releasedOn" IS NULL
  );

-- And the other direction: a CreditHold row open against a counterparty whose
-- flag was cleared on the Customers screen. The release wrote the flag only, so
-- the row stayed open and the credit controller went on refusing a sale the
-- Customers screen said was allowed.
UPDATE "CreditHold" h
   SET "releasedOn" = NOW()::date,
       "releaseReason" = 'Backfilled: the hold was released on the customer record before the two stores were unified'
  FROM "Counterparty" c
 WHERE h."orgId" = c."orgId" AND h."entityId" = c."entityId"
   AND h."partyKey" = lower(btrim(c."code"))
   AND h."releasedOn" IS NULL
   AND NOT c."onHold";
