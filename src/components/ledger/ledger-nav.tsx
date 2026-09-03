"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Two levels, because one was no longer honest.
 *
 * A single row of twenty tabs is not a navigation, it is a list someone has to
 * read every time. Grouping by what a person is actually doing — recording,
 * chasing money, reporting, closing — means the second row only ever holds
 * four or five things, which is a number you can take in at a glance rather
 * than scan.
 *
 * The group is shown by its own tab; its members appear underneath only while
 * that group is current. Nothing is hidden behind a hover or a menu: the
 * structure is drawn, which is the whole point of funkis.
 */
interface NavItem {
  href: string;
  label: string;
  exact?: boolean;
}
interface NavGroup {
  key: string;
  label: string;
  items: NavItem[];
}

export const LEDGER_NAV: NavGroup[] = [
  {
    key: "record",
    label: "Record",
    items: [
      { href: "/accounting", label: "Overview", exact: true },
      { href: "/accounting/journals", label: "Journals" },
      { href: "/accounting/accounts", label: "Chart of accounts" },
      { href: "/accounting/chart", label: "Edit the chart" },
      { href: "/accounting/recurring", label: "Recurring" },
      { href: "/accounting/opening", label: "Opening balances" },
    ],
  },
  {
    key: "money",
    label: "Money",
    items: [
      { href: "/accounting/receivables", label: "Receivables" },
      { href: "/accounting/payables", label: "Payables" },
      { href: "/accounting/bank", label: "Bank" },
      { href: "/accounting/expenses", label: "Expense claims" },
      { href: "/accounting/payroll", label: "Payroll" },
      { href: "/accounting/approvals", label: "Approvals" },
    ],
  },
  {
    key: "assets",
    label: "Assets",
    items: [
      { href: "/accounting/assets", label: "Fixed assets" },
      { href: "/accounting/inventory", label: "Inventory" },
      { href: "/accounting/revaluation", label: "Revaluation" },
    ],
  },
  {
    key: "reports",
    label: "Reports",
    items: [
      { href: "/accounting/statements", label: "Statements" },
      { href: "/accounting/cash-flow", label: "Cash flow" },
      { href: "/accounting/trial-balance", label: "Trial balance" },
      { href: "/accounting/budget", label: "Budget" },
      { href: "/accounting/dimensions", label: "Cost centres" },
      { href: "/accounting/consolidation", label: "Consolidation" },
      { href: "/accounting/audit", label: "Audit trail" },
    ],
  },
  {
    key: "close",
    label: "Tax and close",
    items: [
      { href: "/accounting/vat", label: "VAT return" },
      { href: "/accounting/corporate-tax", label: "Corporate tax" },
      { href: "/accounting/periods", label: "Periods" },
      { href: "/accounting/year-end", label: "Year end" },
    ],
  },
];

const isCurrent = (pathname: string, item: NavItem) =>
  item.exact ? pathname === item.href : pathname.startsWith(item.href);

export function LedgerNav() {
  const pathname = usePathname();

  // The current group is the one holding the longest matching path, so
  // /accounting/accounts/1100 keeps "Chart of accounts" current rather than
  // falling back to the overview.
  const current = React.useMemo(() => {
    let best: { group: NavGroup; length: number } | null = null;
    for (const group of LEDGER_NAV) {
      for (const item of group.items) {
        if (!isCurrent(pathname, item)) continue;
        if (!best || item.href.length > best.length) best = { group, length: item.href.length };
      }
    }
    return best?.group ?? LEDGER_NAV[0];
  }, [pathname]);

  return (
    <nav aria-label="Accounting">
      <div className="sw-tabs sw-scroll">
        {LEDGER_NAV.map((g) => (
          <Link
            key={g.key}
            // A group tab leads to its first screen, so clicking a group always
            // goes somewhere rather than only changing what is listed below.
            href={g.items[0].href}
            className="sw-tab"
            aria-current={g.key === current.key ? "page" : undefined}
          >
            {g.label}
          </Link>
        ))}
      </div>
      <div className="sw-scroll flex gap-1 pt-1.5" style={{ borderBottom: "1px solid var(--sw-line)" }}>
        {current.items.map((item) => {
          const active = isCurrent(pathname, item);
          return (
            <Link
              key={item.href}
              href={item.href}
              className="sw-subtab"
              aria-current={active ? "page" : undefined}
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
