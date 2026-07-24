"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { Select } from "./select";

export function usePagination<T>(items: T[], initialPageSize = 10) {
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(initialPageSize);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const clampedPage = Math.min(page, pageCount);
  const start = (clampedPage - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize);

  React.useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  return {
    page: clampedPage,
    setPage,
    pageSize,
    setPageSize,
    pageCount,
    pageItems,
    total: items.length,
    rangeStart: items.length === 0 ? 0 : start + 1,
    rangeEnd: Math.min(start + pageSize, items.length),
  };
}

function pageList(page: number, pageCount: number): (number | "…")[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const out: (number | "…")[] = [1];
  const from = Math.max(2, page - 1);
  const to = Math.min(pageCount - 1, page + 1);
  if (from > 2) out.push("…");
  for (let i = from; i <= to; i++) out.push(i);
  if (to < pageCount - 1) out.push("…");
  out.push(pageCount);
  return out;
}

export function Pagination({
  page,
  pageCount,
  onPage,
  pageSize,
  onPageSize,
  rangeStart,
  rangeEnd,
  total,
  pageSizes = [10, 25, 50],
  className,
  itemLabel = "items",
}: {
  page: number;
  pageCount: number;
  onPage: (p: number) => void;
  pageSize?: number;
  onPageSize?: (s: number) => void;
  rangeStart: number;
  rangeEnd: number;
  total: number;
  pageSizes?: number[];
  className?: string;
  itemLabel?: string;
}) {
  const pages = pageList(page, pageCount);
  return (
    <div
      className={cn(
        "flex flex-col-reverse items-center justify-between gap-3 sm:flex-row",
        className,
      )}
    >
      <p className="text-xs text-muted-foreground tnum">
        {total === 0 ? (
          <>No {itemLabel}</>
        ) : (
          <>
            Showing <span className="font-medium text-foreground">{rangeStart}</span>–
            <span className="font-medium text-foreground">{rangeEnd}</span> of{" "}
            <span className="font-medium text-foreground">{total}</span> {itemLabel}
          </>
        )}
      </p>

      <div className="flex items-center gap-2">
        {onPageSize && pageSize != null && (
          <Select
            aria-label="Rows per page"
            value={pageSize}
            onChange={(e) => onPageSize(Number(e.target.value))}
            className="h-8 w-[72px] text-xs"
          >
            {pageSizes.map((s) => (
              <option key={s} value={s}>
                {s} / pg
              </option>
            ))}
          </Select>
        )}
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => onPage(page - 1)}
            disabled={page <= 1}
            aria-label="Previous page"
          >
            <ChevronLeft className="rtl:rotate-180" />
          </Button>
          <div className="hidden items-center gap-1 sm:flex">
            {pages.map((p, i) =>
              p === "…" ? (
                <span key={`e${i}`} className="px-1 text-xs text-muted-foreground">
                  …
                </span>
              ) : (
                <button
                  key={p}
                  onClick={() => onPage(p)}
                  aria-current={p === page}
                  className={cn(
                    "inline-flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-xs font-medium transition-colors focus-ring tnum",
                    p === page
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {p}
                </button>
              ),
            )}
          </div>
          <span className="text-xs text-muted-foreground sm:hidden tnum">
            {page} / {pageCount}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => onPage(page + 1)}
            disabled={page >= pageCount}
            aria-label="Next page"
          >
            <ChevronRight className="rtl:rotate-180" />
          </Button>
        </div>
      </div>
    </div>
  );
}
