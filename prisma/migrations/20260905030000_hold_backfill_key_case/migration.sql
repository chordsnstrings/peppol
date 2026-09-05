-- The backfill folded the party key to lower case. credit-control.ts does not.
--
-- `partyKeyOf` in that module returns `party.code.trim()` — trimmed, not
-- lowercased — so a backfilled row keyed on lower(code) is a row the credit
-- check never finds, and the backfill silently did nothing for any customer
-- whose code has a capital in it, which is every customer.
--
-- Worth noting for whoever meets this next: related-parties.ts and pricing.ts
-- DO fold to lower case, and credit-control.ts does not. Three modules, two
-- conventions. Unifying them is a change to what is already stored and belongs
-- in its own piece of work; this migration only makes the backfill agree with
-- the module that reads it.

UPDATE "CreditHold" h
   SET "partyKey" = btrim(c."code")
  FROM "Counterparty" c
 WHERE h."orgId" = c."orgId"
   AND h."entityId" = c."entityId"
   AND h."partyKey" = lower(btrim(c."code"))
   AND h."partyKey" <> btrim(c."code");
