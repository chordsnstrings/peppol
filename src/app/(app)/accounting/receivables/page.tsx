"use client";

import { AgeingReport } from "@/components/ledger/ageing-report";

export default function ReceivablesPage() {
  return (
    <AgeingReport
      title="Receivables"
      sub="What customers still owe, netted document by document straight from the ledger. A receipt is matched to the invoice it settles, so a paid invoice leaves this report rather than lingering in it."
      endpoint="ar"
      controlCode="1100"
      controlName="Trade receivables"
      totalLabel="Total owed to us"
      documentHref={(id) => `/invoices/${encodeURIComponent(id)}`}
      emptyMessage="Nothing is outstanding. Every invoice raised has been settled."
    />
  );
}
