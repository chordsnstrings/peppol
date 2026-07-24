-- Swap Record's primary key from (id) to (store, id) so the same id may exist in
-- two stores without colliding. A record is identified by its store *and* id.
ALTER TABLE "Record" DROP CONSTRAINT "Record_pkey";
ALTER TABLE "Record" ADD CONSTRAINT "Record_pkey" PRIMARY KEY ("store", "id");
