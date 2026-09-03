import { prisma } from "@/lib/server/prisma";

/**
 * Opening the books for a legal entity: a fiscal year with its periods, a
 * primary book, and a chart of accounts. Nothing can be posted until this has
 * run, which is the point — a ledger without a fiscal calendar cannot be closed.
 */

export interface SeedAccount {
  code: string;
  name: string;
  nameAr: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
  subtype?: string;
  parent?: string;
  isPostable?: boolean;
  isControl?: boolean;
  currency?: string;
}

/**
 * A UAE SMB chart of accounts. Bilingual by construction — Arabic account names
 * are first-class columns rather than a translation table bolted on, because the
 * FTA may require an Arabic rendering of the records on its own timetable.
 *
 * Control accounts (AR, AP, VAT) are owned by their subledgers: the database
 * refuses a manual journal against them.
 */
export const UAE_CHART: SeedAccount[] = [
  // ── Assets ──────────────────────────────────────────────────────────────
  { code: "1", name: "Assets", nameAr: "الأصول", type: "ASSET", isPostable: false },
  { code: "10", name: "Current assets", nameAr: "الأصول المتداولة", type: "ASSET", parent: "1", isPostable: false },
  { code: "1000", name: "Cash on hand", nameAr: "النقد في الصندوق", type: "ASSET", parent: "10", subtype: "CASH" },
  { code: "1010", name: "Bank — current account", nameAr: "البنك — الحساب الجاري", type: "ASSET", parent: "10", subtype: "BANK" },
  { code: "1020", name: "Bank — savings account", nameAr: "البنك — حساب التوفير", type: "ASSET", parent: "10", subtype: "BANK" },
  { code: "1050", name: "Undeposited funds", nameAr: "أموال غير مودعة", type: "ASSET", parent: "10", subtype: "CASH" },
  { code: "1100", name: "Trade receivables", nameAr: "الذمم المدينة التجارية", type: "ASSET", parent: "10", subtype: "AR", isControl: true },
  { code: "1150", name: "Allowance for doubtful debts", nameAr: "مخصص الديون المشكوك فيها", type: "ASSET", parent: "10" },
  { code: "1200", name: "Inventory", nameAr: "المخزون", type: "ASSET", parent: "10", subtype: "INVENTORY", isControl: true },
  { code: "1250", name: "Goods received not invoiced", nameAr: "بضاعة مستلمة غير مفوترة", type: "ASSET", parent: "10", subtype: "GRNI" },
  { code: "1300", name: "Prepaid expenses", nameAr: "مصروفات مدفوعة مقدماً", type: "ASSET", parent: "10" },
  { code: "1350", name: "VAT input (recoverable)", nameAr: "ضريبة القيمة المضافة على المشتريات", type: "ASSET", parent: "10", subtype: "VAT_INPUT", isControl: true },
  { code: "1360", name: "VAT receivable from FTA", nameAr: "ضريبة مستحقة من الهيئة", type: "ASSET", parent: "10", subtype: "VAT_RECEIVABLE" },
  { code: "1400", name: "Employee advances", nameAr: "سلف الموظفين", type: "ASSET", parent: "10" },
  { code: "15", name: "Non-current assets", nameAr: "الأصول غير المتداولة", type: "ASSET", parent: "1", isPostable: false },
  { code: "1500", name: "Property, plant and equipment", nameAr: "الممتلكات والآلات والمعدات", type: "ASSET", parent: "15", subtype: "FIXED_ASSET" },
  { code: "1590", name: "Accumulated depreciation", nameAr: "مجمع الإهلاك", type: "ASSET", parent: "15", subtype: "ACCUM_DEP" },
  { code: "1600", name: "Capital work in progress", nameAr: "أعمال رأسمالية تحت التنفيذ", type: "ASSET", parent: "15", subtype: "CWIP" },
  { code: "1700", name: "Right-of-use assets", nameAr: "أصول حق الاستخدام", type: "ASSET", parent: "15" },

  // ── Liabilities ─────────────────────────────────────────────────────────
  { code: "2", name: "Liabilities", nameAr: "الالتزامات", type: "LIABILITY", isPostable: false },
  { code: "20", name: "Current liabilities", nameAr: "الالتزامات المتداولة", type: "LIABILITY", parent: "2", isPostable: false },
  { code: "2000", name: "Trade payables", nameAr: "الذمم الدائنة التجارية", type: "LIABILITY", parent: "20", subtype: "AP", isControl: true },
  { code: "2050", name: "Accrued expenses", nameAr: "مصروفات مستحقة", type: "LIABILITY", parent: "20" },
  { code: "2100", name: "VAT output (payable)", nameAr: "ضريبة القيمة المضافة على المبيعات", type: "LIABILITY", parent: "20", subtype: "VAT_OUTPUT", isControl: true },
  { code: "2110", name: "VAT payable to FTA", nameAr: "ضريبة مستحقة للهيئة", type: "LIABILITY", parent: "20", subtype: "VAT_PAYABLE" },
  { code: "2200", name: "Salaries payable", nameAr: "رواتب مستحقة", type: "LIABILITY", parent: "20", subtype: "PAYROLL" },
  { code: "2250", name: "End-of-service benefits provision", nameAr: "مخصص مكافأة نهاية الخدمة", type: "LIABILITY", parent: "20", subtype: "EOSB" },
  { code: "2300", name: "Customer deposits and advances", nameAr: "دفعات مقدمة من العملاء", type: "LIABILITY", parent: "20" },
  { code: "2400", name: "Corporate tax payable", nameAr: "ضريبة الشركات المستحقة", type: "LIABILITY", parent: "20", subtype: "CT_PAYABLE" },
  { code: "25", name: "Non-current liabilities", nameAr: "الالتزامات غير المتداولة", type: "LIABILITY", parent: "2", isPostable: false },
  { code: "2500", name: "Long-term loans", nameAr: "قروض طويلة الأجل", type: "LIABILITY", parent: "25" },
  { code: "2600", name: "Lease liabilities", nameAr: "التزامات عقود الإيجار", type: "LIABILITY", parent: "25" },

  // ── Equity ──────────────────────────────────────────────────────────────
  { code: "3", name: "Equity", nameAr: "حقوق الملكية", type: "EQUITY", isPostable: false },
  { code: "3000", name: "Share capital", nameAr: "رأس المال", type: "EQUITY", parent: "3" },
  { code: "3100", name: "Shareholder current account", nameAr: "الحساب الجاري للشركاء", type: "EQUITY", parent: "3" },
  { code: "3200", name: "Statutory reserve", nameAr: "الاحتياطي القانوني", type: "EQUITY", parent: "3" },
  { code: "3900", name: "Retained earnings", nameAr: "الأرباح المرحّلة", type: "EQUITY", parent: "3", subtype: "RETAINED_EARNINGS" },
  { code: "3950", name: "Current year earnings", nameAr: "أرباح السنة الحالية", type: "EQUITY", parent: "3", subtype: "CURRENT_EARNINGS", isPostable: false },

  // ── Income ──────────────────────────────────────────────────────────────
  { code: "4", name: "Income", nameAr: "الإيرادات", type: "INCOME", isPostable: false },
  { code: "4000", name: "Sales — goods", nameAr: "المبيعات — بضائع", type: "INCOME", parent: "4" },
  { code: "4100", name: "Sales — services", nameAr: "المبيعات — خدمات", type: "INCOME", parent: "4" },
  { code: "4200", name: "Sales — exports (zero-rated)", nameAr: "المبيعات — تصدير (صفرية)", type: "INCOME", parent: "4" },
  { code: "4800", name: "Sales returns and allowances", nameAr: "مردودات ومسموحات المبيعات", type: "INCOME", parent: "4" },
  { code: "4900", name: "Other income", nameAr: "إيرادات أخرى", type: "INCOME", parent: "4" },
  { code: "4950", name: "Foreign exchange gain", nameAr: "أرباح فروق العملة", type: "INCOME", parent: "4", subtype: "FX_GAIN" },

  // ── Cost of sales & expenses ────────────────────────────────────────────
  { code: "5", name: "Cost of sales", nameAr: "تكلفة المبيعات", type: "EXPENSE", isPostable: false },
  { code: "5000", name: "Cost of goods sold", nameAr: "تكلفة البضاعة المباعة", type: "EXPENSE", parent: "5", subtype: "COGS" },
  { code: "5100", name: "Direct labour", nameAr: "العمالة المباشرة", type: "EXPENSE", parent: "5" },
  { code: "5200", name: "Freight and landed cost", nameAr: "الشحن والتكاليف حتى الوصول", type: "EXPENSE", parent: "5" },
  { code: "5300", name: "Inventory adjustments", nameAr: "تسويات المخزون", type: "EXPENSE", parent: "5" },
  { code: "6", name: "Operating expenses", nameAr: "المصروفات التشغيلية", type: "EXPENSE", isPostable: false },
  { code: "6000", name: "Salaries and wages", nameAr: "الرواتب والأجور", type: "EXPENSE", parent: "6" },
  { code: "6050", name: "End-of-service benefits expense", nameAr: "مصروف مكافأة نهاية الخدمة", type: "EXPENSE", parent: "6" },
  { code: "6100", name: "Rent", nameAr: "الإيجار", type: "EXPENSE", parent: "6" },
  { code: "6150", name: "Utilities", nameAr: "المرافق", type: "EXPENSE", parent: "6" },
  { code: "6200", name: "Marketing and advertising", nameAr: "التسويق والإعلان", type: "EXPENSE", parent: "6" },
  { code: "6250", name: "Professional fees", nameAr: "الأتعاب المهنية", type: "EXPENSE", parent: "6" },
  { code: "6300", name: "Government fees and licences", nameAr: "الرسوم الحكومية والتراخيص", type: "EXPENSE", parent: "6" },
  { code: "6350", name: "Bank charges", nameAr: "الرسوم البنكية", type: "EXPENSE", parent: "6" },
  { code: "6400", name: "Travel and entertainment", nameAr: "السفر والضيافة", type: "EXPENSE", parent: "6" },
  { code: "6450", name: "Repairs and maintenance", nameAr: "الإصلاح والصيانة", type: "EXPENSE", parent: "6" },
  { code: "6500", name: "Insurance", nameAr: "التأمين", type: "EXPENSE", parent: "6" },
  { code: "6600", name: "Depreciation", nameAr: "الإهلاك", type: "EXPENSE", parent: "6", subtype: "DEPRECIATION" },
  { code: "6700", name: "Bad debt expense", nameAr: "مصروف الديون المعدومة", type: "EXPENSE", parent: "6" },
  { code: "6800", name: "Foreign exchange loss", nameAr: "خسائر فروق العملة", type: "EXPENSE", parent: "6", subtype: "FX_LOSS" },
  { code: "6900", name: "Other operating expenses", nameAr: "مصروفات تشغيلية أخرى", type: "EXPENSE", parent: "6" },
  { code: "7000", name: "Corporate tax expense", nameAr: "مصروف ضريبة الشركات", type: "EXPENSE", subtype: "CT_EXPENSE" },
];

/** Open a fiscal year and generate its twelve periods plus an adjustment period. */
export async function openFiscalYear(opts: {
  orgId: string; entityId: string; label: string; startsOn: Date | string; withAdjustmentPeriod?: boolean;
}) {
  const start = typeof opts.startsOn === "string" ? new Date(opts.startsOn) : opts.startsOn;
  const end = new Date(Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), start.getUTCDate()));
  end.setUTCDate(end.getUTCDate() - 1);

  const fy = await prisma.fiscalYear.create({
    data: { orgId: opts.orgId, entityId: opts.entityId, label: opts.label, startsOn: start, endsOn: end },
  });

  const periods = [];
  for (let i = 0; i < 12; i++) {
    const ps = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    const pe = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i + 1, 0));
    periods.push({
      orgId: opts.orgId, entityId: opts.entityId, fiscalYearId: fy.id, seq: i + 1,
      label: `${ps.getUTCFullYear()}-${String(ps.getUTCMonth() + 1).padStart(2, "0")}`,
      startsOn: ps, endsOn: pe,
    });
  }
  if (opts.withAdjustmentPeriod !== false) {
    periods.push({
      orgId: opts.orgId, entityId: opts.entityId, fiscalYearId: fy.id, seq: 13,
      label: `${opts.label}-ADJ`, startsOn: end, endsOn: end, isAdjustment: true,
    } as (typeof periods)[number] & { isAdjustment: boolean });
  }
  await prisma.accountingPeriod.createMany({ data: periods });
  return fy;
}

/** Create the primary book and seed the chart. Idempotent per entity. */
export async function openBooks(opts: {
  orgId: string; entityId: string; functionalCurrency?: string; chart?: SeedAccount[];
}) {
  const currency = opts.functionalCurrency ?? "AED";
  const chart = opts.chart ?? UAE_CHART;

  const book = await prisma.book.upsert({
    where: { orgId_entityId_code: { orgId: opts.orgId, entityId: opts.entityId, code: "PRIMARY" } },
    create: {
      orgId: opts.orgId, entityId: opts.entityId, code: "PRIMARY", name: "Primary ledger",
      functionalCurrency: currency, presentationCurrency: currency, isDefault: true,
    },
    update: {},
  });

  // Parents before children so the hierarchy resolves.
  const ordered = [...chart].sort((a, b) => a.code.length - b.code.length || a.code.localeCompare(b.code));
  const ids = new Map<string, string>();
  for (const a of ordered) {
    const row = await prisma.account.upsert({
      where: { orgId_entityId_code: { orgId: opts.orgId, entityId: opts.entityId, code: a.code } },
      create: {
        orgId: opts.orgId, entityId: opts.entityId, code: a.code, name: a.name, nameAr: a.nameAr,
        type: a.type, subtype: a.subtype ?? null,
        parentId: a.parent ? ids.get(a.parent) ?? null : null,
        isPostable: a.isPostable ?? true, isControl: a.isControl ?? false, currency: a.currency ?? null,
      },
      update: {},
    });
    ids.set(a.code, row.id);
  }
  return { book, accounts: ids.size };
}
