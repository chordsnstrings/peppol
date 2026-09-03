"use client";

import { AgeingReport } from "@/components/ledger/ageing-report";

export default function PayablesPage() {
  return (
    <AgeingReport
      title="Payables"
      sub="What we still owe suppliers, netted bill by bill from the ledger. Posting a bill is idempotent on its id, which is what stops the same supplier invoice being paid twice."
      endpoint="ap"
      controlCode="2000"
      controlName="Trade payables"
      totalLabel="Total we owe"
      documentHref={(id) => `/invoices/${encodeURIComponent(id)}`}
      emptyMessage="Nothing is outstanding. Every bill received has been paid."
    />
  );
}
