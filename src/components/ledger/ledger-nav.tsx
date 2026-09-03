"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Two levels, because one was no longer honest.
 *
 * A single row of twenty tabs is not a navigation, it is a list someone has to
 * read every time. Grouping by what a person is actually doing — recording,
 * selling, buying, handling cash, reporting, closing — means the second row
 * only ever holds a handful of things, which is a number you can take in at a
 * glance rather than scan.
 *
 * The groups follow the business, not the database. Customers, receivables and
 * revenue recognition sit together because they are three views of the same
 * question; splitting them by which table they read would be a filing system
 * for the people who built it rather than for the people who use it.
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
      { href: "/accounting/attention", label: "Needs attention" },
      { href: "/accounting/journals", label: "Journals" },
      { href: "/accounting/accounts", label: "Chart of accounts" },
      { href: "/accounting/chart", label: "Edit the chart" },
      { href: "/accounting/recurring", label: "Recurring" },
      { href: "/accounting/opening", label: "Opening balances" },
      { href: "/accounting/exports", label: "Export and migration" },
      { href: "/accounting/roles", label: "Who may do what" },
    ],
  },
  {
    key: "sales",
    label: "Sales",
    items: [
      { href: "/accounting/customers", label: "Customers" },
      { href: "/accounting/sales-orders", label: "Quotes and orders" },
      { href: "/accounting/deliveries", label: "Delivery notes" },
      { href: "/accounting/pricing", label: "Price lists" },
      { href: "/accounting/subscriptions", label: "Subscriptions" },
      { href: "/accounting/receivables", label: "Receivables" },
      { href: "/accounting/revenue", label: "Revenue recognition" },
    ],
  },
  {
    key: "purchases",
    label: "Purchases",
    items: [
      { href: "/accounting/payables", label: "Payables" },
      { href: "/accounting/procurement", label: "Purchase orders" },
      { href: "/accounting/payment-runs", label: "Payment runs" },
      { href: "/accounting/expenses", label: "Expense claims" },
      { href: "/accounting/approvals", label: "Approvals" },
    ],
  },
  {
    key: "cash",
    label: "Cash and pay",
    items: [
      { href: "/accounting/bank", label: "Bank" },
      { href: "/accounting/bank-import", label: "Import a statement" },
      { href: "/accounting/petty-cash", label: "Petty cash" },
      { href: "/accounting/cheques", label: "Cheques" },
      { href: "/accounting/payroll", label: "Payroll" },
      { href: "/accounting/leave", label: "Leave" },
    ],
  },
  {
    key: "assets",
    label: "Assets",
    items: [
      { href: "/accounting/assets", label: "Fixed assets" },
      { href: "/accounting/inventory", label: "Inventory" },
      { href: "/accounting/revaluation", label: "Currency revaluation" },
      { href: "/accounting/asset-revaluation", label: "Asset revaluation" },
      { href: "/accounting/leases", label: "Leases" },
      { href: "/accounting/provisions", label: "Provisions" },
    ],
  },
  {
    key: "reports",
    label: "Reports",
    items: [
      { href: "/accounting/statements", label: "Statements" },
      { href: "/accounting/comparatives", label: "Comparatives" },
      { href: "/accounting/cash-flow", label: "Cash flow" },
      { href: "/accounting/forecast", label: "Cash forecast" },
      { href: "/accounting/trial-balance", label: "Trial balance" },
      { href: "/accounting/budget", label: "Budget" },
      { href: "/accounting/layouts", label: "Report layouts" },
      { href: "/accounting/dimensions", label: "Cost centres" },
      { href: "/accounting/projects", label: "Projects" },
      { href: "/accounting/timesheets", label: "Timesheets" },
      { href: "/accounting/segments", label: "Segments" },
      { href: "/accounting/insights", label: "Insights" },
      { href: "/accounting/consolidation", label: "Consolidation" },
      { href: "/accounting/intercompany", label: "Intercompany" },
      { href: "/accounting/equity", label: "Equity and notes" },
      { href: "/accounting/audit", label: "Audit trail" },
      { href: "/accounting/analytics", label: "Analytics" },
    ],
  },
  {
    key: "close",
    label: "Tax and close",
    items: [
      { href: "/accounting/vat", label: "VAT return" },
      { href: "/accounting/vat-schemes", label: "VAT schemes" },
      { href: "/accounting/corporate-tax", label: "Corporate tax" },
      { href: "/accounting/deferred-tax", label: "Deferred tax" },
      { href: "/accounting/month-end", label: "Month end" },
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
