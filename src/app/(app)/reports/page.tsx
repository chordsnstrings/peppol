"use client";

import * as React from "react";
import { BarChart3, Download, FileText, TrendingUp, Landmark } from "lucide-react";
import { formatMoney, minorToMajor } from "@/lib/domain/money";
import { DOC_TYPE_LABEL, getProfile } from "@/lib/domain/tax";
import { formatDate } from "@/lib/utils";
import { downloadText } from "@/lib/domain/ubl";
import { useAppState } from "@/lib/app-state";
import { useInvoices } from "@/hooks/use-entity-data";
import type { Invoice } from "@/lib/domain/types";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat";
import { Segmented } from "@/components/ui/controls";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Pagination, usePagination } from "@/components/ui/pagination";
import { toast } from "sonner";

type Period = "month" | "quarter" | "year" | "all";

function inPeriod(iso: string, period: Period): boolean {
  if (period === "all") return true;
  const d = new Date(iso);
  const now = new Date();
  if (period === "month") return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  if (period === "year") return d.getFullYear() === now.getFullYear();
  const q = Math.floor(now.getMonth() / 3);
  return Math.floor(d.getMonth() / 3) === q && d.getFullYear() === now.getFullYear();
}

export default function ReportsPage() {
  const { currentEntity } = useAppState();
  const { invoices } = useInvoices((i) => i.direction === "OUTBOUND");
  const [period, setPeriod] = React.useState<Period>("month");

  const scoped = invoices.filter((i) => inPeriod(i.issueDate, period));
  const completed = scoped.filter((i) => i.lifecycleStatus === "COMPLETED");

  const totalNet = scoped.reduce((s, i) => s + i.totals.taxExclusiveMinor, 0);
  const totalVat = scoped.reduce((s, i) => s + i.totals.vatMinor, 0);
  const totalGross = scoped.reduce((s, i) => s + i.totals.taxInclusiveMinor, 0);

  // VAT summary by category (real)
  const vatByCategory = React.useMemo(() => {
    const map = new Map<string, { rate: number; taxable: number; vat: number; label: string }>();
    for (const inv of scoped) {
      for (const c of inv.totals.perCategory) {
        const key = c.categoryCode + c.ratePercent;
        const existing = map.get(key);
        const label = getProfile(c.profileCode).label;
        if (existing) {
          existing.taxable += c.taxableMinor;
          existing.vat += c.vatMinor;
        } else {
          map.set(key, { rate: c.ratePercent, taxable: c.taxableMinor, vat: c.vatMinor, label });
        }
      }
    }
    return [...map.values()].sort((a, b) => b.rate - a.rate);
  }, [scoped]);

  const pg = usePagination(scoped, 10);
  React.useEffect(() => pg.setPage(1), [period]); // eslint-disable-line

  const cur = currentEntity?.defaultCurrency ?? "AED";

  const exportRegister = () => {
    const header = ["Number", "Date", "Customer", "TRN", "Doc type", "Net", "VAT", "Gross", "Currency", "Status"];
    const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const lines = [header.map(escape).join(",")];
    for (const i of scoped) {
      lines.push(
        [
          i.number,
          i.issueDate,
          i.buyer.nameEn,
          i.buyer.trn ?? "",
          DOC_TYPE_LABEL[i.docType],
          minorToMajor(i.totals.taxExclusiveMinor).toFixed(2),
          minorToMajor(i.totals.vatMinor).toFixed(2),
          minorToMajor(i.totals.taxInclusiveMinor).toFixed(2),
          i.currency,
          i.lifecycleStatus,
        ]
          .map((v) => escape(String(v)))
          .join(","),
      );
    }
    downloadText(`invoice-register-${period}.csv`, lines.join("\n"), "text/csv");
    toast.success("Register exported", { description: `${scoped.length} rows as CSV.` });
  };

  return (
    <div>
      <PageHeader
        title="Reports"
        description="Registers and VAT summaries for reconciliation — export anytime."
        icon={<BarChart3 />}
        actions={
          <Button variant="outline" icon={<Download />} onClick={exportRegister} disabled={scoped.length === 0}>
            Export CSV
          </Button>
        }
      />

      <div className="mb-5">
        <Segmented
          value={period}
          onChange={setPeriod}
          options={[
            { value: "month", label: "This month" },
            { value: "quarter", label: "This quarter" },
            { value: "year", label: "This year" },
            { value: "all", label: "All time" },
          ]}
        />
      </div>

      {invoices.length === 0 ? (
        <EmptyState
          icon={<BarChart3 />}
          title="No data to report yet"
          description="Once you've created invoices, your registers and VAT summaries appear here."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <StatCard label="Invoices" value={scoped.length} icon={<FileText />} hint={`${completed.length} completed`} />
            <StatCard label="Net total" value={minorToMajor(totalNet)} format={(n) => formatMoney(Math.round(n * 100), cur)} icon={<TrendingUp />} tone="info" />
            <StatCard label="VAT total" value={minorToMajor(totalVat)} format={(n) => formatMoney(Math.round(n * 100), cur)} icon={<Landmark />} tone="gold" />
            <StatCard label="Gross total" value={minorToMajor(totalGross)} format={(n) => formatMoney(Math.round(n * 100), cur)} icon={<BarChart3 />} tone="success" />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            {/* VAT summary */}
            <Card className="lg:col-span-1">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">VAT by category</CardTitle>
                <p className="text-xs text-muted-foreground">For reconciliation — not a VAT return.</p>
              </CardHeader>
              <CardContent className="space-y-2">
                {vatByCategory.length === 0 ? (
                  <p className="py-4 text-center text-sm text-muted-foreground">No VAT in this period.</p>
                ) : (
                  vatByCategory.map((c, i) => (
                    <div key={i} className="flex items-center justify-between rounded-lg bg-muted/40 p-2.5">
                      <div>
                        <p className="text-sm font-medium">{c.label}</p>
                        <p className="text-xs text-muted-foreground tnum">
                          Taxable {formatMoney(c.taxable, cur)}
                        </p>
                      </div>
                      <div className="text-end">
                        <Badge tone="gold" size="sm">
                          {c.rate}%
                        </Badge>
                        <p className="mt-1 text-sm font-semibold tnum">{formatMoney(c.vat, cur)}</p>
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            {/* Register */}
            <Card className="lg:col-span-2">
              <CardHeader className="flex-row items-center justify-between pb-3">
                <CardTitle className="text-base">Invoice register</CardTitle>
                <Button variant="ghost" size="sm" icon={<Download />} onClick={exportRegister}>
                  CSV
                </Button>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="py-2 text-start font-medium">Number</th>
                        <th className="py-2 text-start font-medium">Date</th>
                        <th className="hidden py-2 text-start font-medium sm:table-cell">Customer</th>
                        <th className="py-2 text-end font-medium">Net</th>
                        <th className="py-2 text-end font-medium">VAT</th>
                        <th className="py-2 text-end font-medium">Gross</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {pg.pageItems.map((i: Invoice) => (
                        <tr key={i.id} className="text-sm">
                          <td className="py-2.5 font-medium">{i.number}</td>
                          <td className="py-2.5 text-muted-foreground tnum">{formatDate(i.issueDate)}</td>
                          <td className="hidden max-w-[140px] truncate py-2.5 sm:table-cell">{i.buyer.nameEn}</td>
                          <td className="py-2.5 text-end tnum">{formatMoney(i.totals.taxExclusiveMinor, i.currency, { withSymbol: false })}</td>
                          <td className="py-2.5 text-end text-muted-foreground tnum">{formatMoney(i.totals.vatMinor, i.currency, { withSymbol: false })}</td>
                          <td className="py-2.5 text-end font-semibold tnum">{formatMoney(i.totals.taxInclusiveMinor, i.currency, { withSymbol: false })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-4">
                  <Pagination
                    page={pg.page}
                    pageCount={pg.pageCount}
                    onPage={pg.setPage}
                    rangeStart={pg.rangeStart}
                    rangeEnd={pg.rangeEnd}
                    total={pg.total}
                    itemLabel="invoices"
                  />
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
