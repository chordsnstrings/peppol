import type { Metadata } from "next";
import "@/styles/ledger.css";
import { LedgerNav } from "@/components/ledger/ledger-nav";
import { AskProvider } from "@/components/ledger/ask";

export const metadata: Metadata = {
  title: "Accounting",
  robots: { index: false, follow: false },
};

export default function AccountingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="sw -mx-4 -mt-6 min-h-[calc(100dvh-4rem)] px-4 pt-5 md:-mx-6 md:px-6 lg:-mx-8 lg:px-8">
      <LedgerNav />
      {/* One dialog for the whole section, so a question asked from a deep row
          is not mounted inside the row it is asking about. */}
      <AskProvider>
        <div className="pt-5">{children}</div>
      </AskProvider>
    </div>
  );
}
