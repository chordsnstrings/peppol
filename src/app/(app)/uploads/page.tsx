"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  UploadCloud,
  FileSpreadsheet,
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  Wand2,
  PartyPopper,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/domain/money";
import { validateInvoice } from "@/lib/domain/validation";
import { useAppState } from "@/lib/app-state";
import { persistInvoice } from "@/lib/db/repo";
import {
  parseFile,
  guessMapping,
  buildInvoiceFromRow,
  TARGET_FIELDS,
  type Mapping,
  type ParsedSheet,
  type BuiltRow,
  type TargetKey,
} from "@/lib/ingest";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Pagination, usePagination } from "@/components/ui/pagination";
import { InvoiceStatus } from "@/components/invoice/status";
import { toast } from "sonner";

type Stage = "idle" | "parsing" | "mapping" | "review" | "committing" | "done";

const REQUIRED: TargetKey[] = ["customer_name"];

export default function UploadsPage() {
  const router = useRouter();
  const { currentEntity } = useAppState();
  const [stage, setStage] = React.useState<Stage>("idle");
  const [dragging, setDragging] = React.useState(false);
  const [sheet, setSheet] = React.useState<ParsedSheet | null>(null);
  const [mapping, setMapping] = React.useState<Mapping>({});
  const [built, setBuilt] = React.useState<BuiltRow[]>([]);
  const [progress, setProgress] = React.useState(0);
  const [createdIds, setCreatedIds] = React.useState<string[]>([]);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const onFile = async (file: File) => {
    setStage("parsing");
    try {
      const parsed = await parseFile(file);
      if (parsed.rows.length === 0) {
        toast.error("No rows found", { description: "That file looks empty." });
        setStage("idle");
        return;
      }
      setSheet(parsed);
      setMapping(guessMapping(parsed.headers));
      setStage("mapping");
    } catch {
      toast.error("Couldn't read that file", { description: "Try a .csv, .tsv or .xlsx export." });
      setStage("idle");
    }
  };

  const buildRows = () => {
    if (!sheet || !currentEntity) return;
    const rows = sheet.rows
      .filter((r) => r.some((c) => c.trim()))
      .map((r, i) => buildInvoiceFromRow(currentEntity, mapping, r, i + 1));
    setBuilt(rows);
    setStage("review");
  };

  const commit = async () => {
    setStage("committing");
    const ids: string[] = [];
    for (let i = 0; i < built.length; i++) {
      await persistInvoice(built[i].invoice);
      ids.push(built[i].invoice.id);
      setProgress(Math.round(((i + 1) / built.length) * 100));
    }
    setCreatedIds(ids);
    setStage("done");
    toast.success(`${ids.length} invoices created`, { description: "Saved as drafts." });
  };

  const reset = () => {
    setStage("idle");
    setSheet(null);
    setMapping({});
    setBuilt([]);
    setProgress(0);
    setCreatedIds([]);
  };

  return (
    <div>
      <PageHeader
        title="Import from spreadsheet"
        description="Upload an Excel or CSV export — map the columns once and we turn every row into a validated draft."
        icon={<FileSpreadsheet />}
        actions={
          stage !== "idle" ? (
            <Button variant="outline" onClick={reset}>
              Start over
            </Button>
          ) : undefined
        }
      />

      {/* Stepper */}
      <Stepper stage={stage} />

      <AnimatePresence mode="wait">
        {/* IDLE — dropzone */}
        {(stage === "idle" || stage === "parsing") && (
          <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const f = e.dataTransfer.files?.[0];
                if (f) onFile(f);
              }}
              onClick={() => inputRef.current?.click()}
              className={cn(
                "relative flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-16 text-center transition-all",
                dragging
                  ? "border-gold bg-gold/[0.06] scale-[1.01]"
                  : "border-border hover:border-muted-foreground/40 hover:bg-accent/30",
              )}
            >
              <input
                ref={inputRef}
                type="file"
                accept=".csv,.tsv,.xlsx,.xls"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
              />
              <motion.div
                animate={stage === "parsing" ? { y: [0, -8, 0] } : {}}
                transition={{ repeat: Infinity, duration: 1 }}
                className="flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br from-gold/20 to-gold/5 text-[hsl(var(--gold))]"
              >
                <UploadCloud className="size-8" />
              </motion.div>
              <h3 className="mt-5 font-display text-lg font-semibold">
                {stage === "parsing" ? "Reading your file…" : "Drop your spreadsheet here"}
              </h3>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                {stage === "parsing"
                  ? "Detecting headers and columns"
                  : "Excel (.xlsx) or CSV, up to 50,000 rows. Your file never leaves this device."}
              </p>
              {stage !== "parsing" && (
                <Button className="mt-5" icon={<UploadCloud />}>
                  Choose file
                </Button>
              )}
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {[
                { icon: <Wand2 />, t: "AI-assisted mapping", d: "We recognise Tally, Zoho & QBO exports." },
                { icon: <Sparkles />, t: "Validated on import", d: "Every row runs the compliance engine." },
                { icon: <CheckCircle2 />, t: "Save the mapping", d: "Next upload of the same shape is instant." },
              ].map((f) => (
                <Card key={f.t} className="flex items-start gap-3 p-4">
                  <div className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">
                    {f.icon}
                  </div>
                  <div>
                    <p className="text-sm font-medium">{f.t}</p>
                    <p className="text-xs text-muted-foreground">{f.d}</p>
                  </div>
                </Card>
              ))}
            </div>
          </motion.div>
        )}

        {/* MAPPING */}
        {stage === "mapping" && sheet && (
          <motion.div key="mapping" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <MappingStage
              sheet={sheet}
              mapping={mapping}
              setMapping={setMapping}
              onBack={reset}
              onNext={buildRows}
            />
          </motion.div>
        )}

        {/* REVIEW */}
        {stage === "review" && (
          <motion.div key="review" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <ReviewStage built={built} onBack={() => setStage("mapping")} onCommit={commit} currency={currentEntity?.defaultCurrency ?? "AED"} />
          </motion.div>
        )}

        {/* COMMITTING */}
        {stage === "committing" && (
          <motion.div key="committing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="py-16">
            <Card className="mx-auto max-w-md p-8 text-center">
              <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-gold/10 text-[hsl(var(--gold))]">
                <FileSpreadsheet className="size-7" />
              </div>
              <h3 className="mt-4 font-display text-lg font-semibold">Creating invoices…</h3>
              <p className="text-sm text-muted-foreground">{progress}% complete</p>
              <div className="mt-4">
                <Progress value={progress} />
              </div>
            </Card>
          </motion.div>
        )}

        {/* DONE */}
        {stage === "done" && (
          <motion.div key="done" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}>
            <Card className="mx-auto max-w-lg p-8 text-center">
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", stiffness: 260, damping: 16 }}
                className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-success text-white"
              >
                <PartyPopper className="size-8" />
              </motion.div>
              <h3 className="mt-5 font-display text-xl font-bold">
                {createdIds.length} invoices created
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Saved as drafts, each validated and ready for your review.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                <Button icon={<ArrowRight />} onClick={() => router.push("/invoices")}>
                  Review invoices
                </Button>
                <Button variant="outline" onClick={reset}>
                  Import another file
                </Button>
              </div>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Stepper({ stage }: { stage: Stage }) {
  const steps = ["Upload", "Map columns", "Review", "Done"];
  const activeIndex =
    stage === "idle" || stage === "parsing"
      ? 0
      : stage === "mapping"
        ? 1
        : stage === "review" || stage === "committing"
          ? 2
          : 3;
  return (
    <div className="mb-6 flex items-center gap-2">
      {steps.map((s, i) => (
        <React.Fragment key={s}>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "flex size-7 items-center justify-center rounded-full text-xs font-semibold transition-colors",
                i < activeIndex
                  ? "bg-success text-white"
                  : i === activeIndex
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground",
              )}
            >
              {i < activeIndex ? <CheckCircle2 className="size-4" /> : i + 1}
            </span>
            <span
              className={cn(
                "hidden text-sm font-medium sm:block",
                i === activeIndex ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {s}
            </span>
          </div>
          {i < steps.length - 1 && <div className="h-px flex-1 bg-border" />}
        </React.Fragment>
      ))}
    </div>
  );
}

function MappingStage({
  sheet,
  mapping,
  setMapping,
  onBack,
  onNext,
}: {
  sheet: ParsedSheet;
  mapping: Mapping;
  setMapping: (m: Mapping) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const mappedCount = Object.values(mapping).filter((v) => v != null).length;
  const missingRequired = REQUIRED.filter((k) => mapping[k] == null);
  const preview = sheet.rows.slice(0, 5);

  const setTarget = (key: TargetKey, colIdx: number | null) => {
    const next: Mapping = { ...mapping };
    // clear any other target using this column
    if (colIdx != null) {
      for (const k of Object.keys(next) as TargetKey[]) {
        if (next[k] === colIdx) delete next[k];
      }
      next[key] = colIdx;
    } else {
      delete next[key];
    }
    setMapping(next);
  };

  return (
    <div>
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 items-center justify-center rounded-lg bg-gold/10 text-[hsl(var(--gold))]">
              <Wand2 className="size-5" />
            </div>
            <div>
              <p className="text-sm font-medium">
                {sheet.fileName}
                {sheet.sheetName ? ` · ${sheet.sheetName}` : ""}
              </p>
              <p className="text-xs text-muted-foreground">
                {sheet.rows.length} rows · {sheet.headers.length} columns · {mappedCount} mapped
              </p>
            </div>
          </div>
          <div className="flex-1" />
          <Badge tone="gold" size="sm">
            <Sparkles className="size-3" /> Auto-mapped
          </Badge>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Mapping controls */}
        <Card>
          <CardContent className="space-y-2.5 p-4 sm:p-5">
            <p className="text-sm font-semibold">Match your columns</p>
            {TARGET_FIELDS.map((t) => (
              <div key={t.key} className="flex items-center gap-3">
                <label className="flex-1 text-sm">
                  {t.label}
                  {REQUIRED.includes(t.key) && <span className="text-destructive"> *</span>}
                </label>
                <Select
                  value={mapping[t.key] ?? ""}
                  onChange={(e) => setTarget(t.key, e.target.value === "" ? null : Number(e.target.value))}
                  className="h-9 w-44"
                >
                  <option value="">— Not mapped —</option>
                  {sheet.headers.map((h, idx) => (
                    <option key={idx} value={idx}>
                      {h || `Column ${idx + 1}`}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Live preview */}
        <Card>
          <CardContent className="p-4 sm:p-5">
            <p className="mb-3 text-sm font-semibold">How we read the first rows</p>
            <div className="space-y-2">
              {preview.map((row, i) => {
                const name = mapping.customer_name != null ? row[mapping.customer_name] : "";
                const desc = mapping.description != null ? row[mapping.description] : "";
                const price = mapping.unit_price != null ? row[mapping.unit_price] : mapping.line_total != null ? row[mapping.line_total] : "";
                return (
                  <div key={i} className="rounded-lg border border-border bg-muted/40 p-2.5 text-xs">
                    <p className="font-medium">{name || <span className="text-destructive">No customer</span>}</p>
                    <p className="text-muted-foreground">
                      {desc || "—"} · {price || "0"}
                    </p>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      {missingRequired.length > 0 && (
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/[0.06] p-3 text-sm text-[hsl(var(--warning))]">
          <AlertTriangle className="size-4" />
          Map the customer name column to continue.
        </div>
      )}

      <div className="mt-5 flex items-center justify-between">
        <Button variant="ghost" icon={<ArrowLeft className="rtl:rotate-180" />} onClick={onBack}>
          Back
        </Button>
        <Button onClick={onNext} disabled={missingRequired.length > 0}>
          Review {sheet.rows.length} rows
          <ArrowRight className="rtl:rotate-180" />
        </Button>
      </div>
    </div>
  );
}

function ReviewStage({
  built,
  onBack,
  onCommit,
  currency,
}: {
  built: BuiltRow[];
  onBack: () => void;
  onCommit: () => void;
  currency: string;
}) {
  const rows = React.useMemo(
    () =>
      built.map((b) => {
        const v = validateInvoice(b.invoice);
        return { ...b, validation: v };
      }),
    [built],
  );
  const [filter, setFilter] = React.useState<"all" | "ok" | "warn" | "err">("all");
  const okCount = rows.filter((r) => r.validation.errors === 0 && r.validation.warnings === 0).length;
  const warnCount = rows.filter((r) => r.validation.warnings > 0 && r.validation.errors === 0).length;
  const errCount = rows.filter((r) => r.validation.errors > 0).length;

  const filtered = rows.filter((r) =>
    filter === "all"
      ? true
      : filter === "ok"
        ? r.validation.errors === 0 && r.validation.warnings === 0
        : filter === "warn"
          ? r.validation.warnings > 0 && r.validation.errors === 0
          : r.validation.errors > 0,
  );
  const pg = usePagination(filtered, 10);
  React.useEffect(() => pg.setPage(1), [filter]); // eslint-disable-line

  const total = built.reduce((s, b) => s + b.invoice.totals.taxInclusiveMinor, 0);

  return (
    <div>
      <div className="mb-4 grid grid-cols-3 gap-3">
        <FilterTile active={filter === "ok"} onClick={() => setFilter(filter === "ok" ? "all" : "ok")} tone="success" count={okCount} label="Ready" icon={<CheckCircle2 />} />
        <FilterTile active={filter === "warn"} onClick={() => setFilter(filter === "warn" ? "all" : "warn")} tone="warning" count={warnCount} label="Warnings" icon={<AlertTriangle />} />
        <FilterTile active={filter === "err"} onClick={() => setFilter(filter === "err" ? "all" : "err")} tone="error" count={errCount} label="Errors" icon={<X />} />
      </div>

      <Card className="overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <th className="w-10 py-3 ps-4 text-start font-medium">#</th>
              <th className="py-3 text-start font-medium">Customer</th>
              <th className="hidden py-3 text-start font-medium sm:table-cell">Description</th>
              <th className="py-3 text-end font-medium">Amount</th>
              <th className="py-3 pe-4 text-end font-medium">Check</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {pg.pageItems.map((r) => (
              <tr key={r.rowNo} className="text-sm">
                <td className="py-2.5 ps-4 text-muted-foreground tnum">{r.rowNo}</td>
                <td className="py-2.5">
                  <p className="max-w-[160px] truncate font-medium">{r.invoice.buyer.nameEn}</p>
                </td>
                <td className="hidden max-w-[220px] truncate py-2.5 text-muted-foreground sm:table-cell">
                  {r.invoice.lines[0]?.description}
                </td>
                <td className="py-2.5 text-end font-medium tnum">
                  {formatMoney(r.invoice.totals.taxInclusiveMinor, r.invoice.currency)}
                </td>
                <td className="py-2.5 pe-4 text-end">
                  {r.validation.errors > 0 ? (
                    <Badge tone="error" size="sm">
                      {r.validation.errors} error{r.validation.errors > 1 ? "s" : ""}
                    </Badge>
                  ) : r.validation.warnings > 0 ? (
                    <Badge tone="warning" size="sm">
                      {r.validation.warnings} warning{r.validation.warnings > 1 ? "s" : ""}
                    </Badge>
                  ) : (
                    <Badge tone="success" size="sm" dot>
                      Ready
                    </Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="mt-4">
        <Pagination
          page={pg.page}
          pageCount={pg.pageCount}
          onPage={pg.setPage}
          rangeStart={pg.rangeStart}
          rangeEnd={pg.rangeEnd}
          total={pg.total}
          itemLabel="rows"
        />
      </div>

      <div className="mt-5 flex flex-col items-center justify-between gap-3 sm:flex-row">
        <Button variant="ghost" icon={<ArrowLeft className="rtl:rotate-180" />} onClick={onBack}>
          Back to mapping
        </Button>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            Total <span className="font-semibold text-foreground tnum">{formatMoney(total, currency)}</span>
          </span>
          <Button icon={<CheckCircle2 />} onClick={onCommit}>
            Create {built.length} drafts
          </Button>
        </div>
      </div>
    </div>
  );
}

function FilterTile({
  active,
  onClick,
  tone,
  count,
  label,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  tone: "success" | "warning" | "error";
  count: number;
  label: string;
  icon: React.ReactNode;
}) {
  const cls = {
    success: "text-success bg-success/10 border-success/20",
    warning: "text-[hsl(var(--warning))] bg-warning/10 border-warning/25",
    error: "text-destructive bg-destructive/10 border-destructive/20",
  }[tone];
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2.5 rounded-xl border p-3 text-start transition-all sm:gap-3 sm:p-4",
        active ? "ring-2 ring-offset-2 ring-offset-background" : "hover:bg-accent/50",
        active ? cls : "border-border bg-card",
      )}
    >
      <span className={cn("flex size-9 items-center justify-center rounded-lg [&_svg]:size-4", cls)}>
        {icon}
      </span>
      <div>
        <p className="font-display text-xl font-bold tnum">{count}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </button>
  );
}
