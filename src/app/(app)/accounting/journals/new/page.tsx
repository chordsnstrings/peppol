"use client";

import { EntryGrid } from "@/components/ledger/entry-grid";
import { PageHead } from "@/components/ledger/primitives";

export default function NewJournalPage() {
  return (
    <>
      <PageHead
        title="New journal entry"
        sub="Debits positive, credits negative, and the two have to meet at zero — the database refuses anything else, so an entry that posts here is an entry that balances."
      />
      <EntryGrid />
    </>
  );
}
