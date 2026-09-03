"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/accounting", label: "Overview", exact: true },
  { href: "/accounting/journals", label: "Journals" },
  { href: "/accounting/accounts", label: "Chart of accounts" },
  { href: "/accounting/receivables", label: "Receivables" },
  { href: "/accounting/payables", label: "Payables" },
  { href: "/accounting/bank", label: "Bank" },
  { href: "/accounting/assets", label: "Assets" },
  { href: "/accounting/vat", label: "VAT return" },
  { href: "/accounting/statements", label: "Statements" },
  { href: "/accounting/trial-balance", label: "Trial balance" },
  { href: "/accounting/periods", label: "Periods" },
  { href: "/accounting/year-end", label: "Year end" },
];

export function LedgerNav() {
  const pathname = usePathname();
  return (
    <nav className="sw-tabs sw-scroll" aria-label="Accounting">
      {TABS.map((t) => {
        const active = t.exact ? pathname === t.href : pathname.startsWith(t.href);
        return (
          <Link key={t.href} href={t.href} className="sw-tab" aria-current={active ? "page" : undefined}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
