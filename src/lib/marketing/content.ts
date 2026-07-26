/**
 * Canonical, bilingual marketing content — the single source of truth that feeds
 * the UI, the JSON-LD (FAQPage/ItemList), and the generated llms.txt/llms-full.txt.
 * Keeping one source means the LLM files can never drift from the site.
 *
 * Truthfulness: every feature here maps to a real, shipping capability. Claims
 * about live FTA transmission and card collection assume production gateway +
 * payment credentials at launch. Unimplemented items (outbound webhooks, enforced
 * RBAC, email delivery, inbound inbox) are deliberately NOT listed.
 */

import type { Dict, Locale } from "./i18n";

export interface Faq {
  q: Dict;
  a: Dict;
}

export function faqText(f: Faq, locale: Locale) {
  return { q: f.q[locale], a: f.a[locale] };
}

/** Homepage / pricing FAQ — the conversion + reassurance set. */
export const HOME_FAQ: Faq[] = [
  {
    q: { en: "What is UAE e-invoicing and who does it apply to?", ar: "ما هي الفوترة الإلكترونية في الإمارات ومن يشملها؟" },
    a: {
      en: "The UAE Federal Tax Authority (FTA) is introducing mandatory electronic invoicing under Ministerial Decision No. 64 of 2025. Businesses exchange structured invoices through service providers over the Peppol network, and the tax data is reported to the FTA. It applies to VAT-registered businesses in phases, beginning with larger taxpayers. ARKS handles validation, transmission and reporting so you are ready regardless of your phase.",
      ar: "تطبّق الهيئة الاتحادية للضرائب في الإمارات الفوترة الإلكترونية الإلزامية بموجب القرار الوزاري رقم 64 لسنة 2025. تتبادل المنشآت فواتير مُهيكلة عبر شبكة Peppol من خلال مزوّدي خدمة، وتُبلَّغ بيانات الضريبة إلى الهيئة. يسري ذلك على المنشآت المسجّلة في ضريبة القيمة المضافة على مراحل، بدءاً من كبار المكلّفين. تتولّى ARKS التحقق والإرسال والإبلاغ لتكون جاهزاً في أي مرحلة.",
    },
  },
  {
    q: { en: "How much does ARKS cost?", ar: "كم تبلغ تكلفة ARKS؟" },
    a: {
      en: "ARKS is a flat subscription: AED 299 per month, AED 1,500 for six months (AED 250/month), or AED 2,400 per year (AED 200/month). Every plan includes unlimited invoicing and every feature — there are no per-invoice fees. Prices are VAT-inclusive and you receive a tax invoice for your subscription.",
      ar: "ARKS اشتراك ثابت: 299 درهماً شهرياً، أو 1,500 درهم لستة أشهر (250 درهماً/الشهر)، أو 2,400 درهم سنوياً (200 درهم/الشهر). تشمل كل الخطط فوترة غير محدودة وجميع المزايا — دون رسوم لكل فاتورة. الأسعار شاملة ضريبة القيمة المضافة وتحصل على فاتورة ضريبية عن اشتراكك.",
    },
  },
  {
    q: { en: "Is there a free trial? Do I need a credit card?", ar: "هل توجد فترة تجريبية مجانية؟ وهل أحتاج بطاقة ائتمان؟" },
    a: {
      en: "Yes — every new workspace starts with a 14-day free trial with full transmission to the FTA, no card required. You only subscribe when you are ready. If a subscription lapses, there is a 7-day grace period with reminders before transmission is paused, and your data always remains exportable.",
      ar: "نعم — تبدأ كل مساحة عمل جديدة بفترة تجريبية مجانية مدتها 14 يوماً مع إرسال كامل إلى الهيئة، دون الحاجة لبطاقة. تشترك فقط عندما تكون جاهزاً. وعند انقضاء الاشتراك تتوفّر مهلة 7 أيام مع تذكيرات قبل إيقاف الإرسال، وتبقى بياناتك قابلة للتصدير دائماً.",
    },
  },
  {
    q: { en: "What is PINT AE and does ARKS support it?", ar: "ما هي صيغة PINT AE وهل تدعمها ARKS؟" },
    a: {
      en: "PINT AE is the UAE-specific Peppol International (PINT) invoice specification — the structured UBL format the FTA requires. ARKS validates every invoice against the PINT AE rules before sending, so malformed invoices are caught before they reach the network.",
      ar: "PINT AE هي مواصفة فاتورة Peppol الدولية الخاصة بالإمارات — صيغة UBL المُهيكلة التي تشترطها الهيئة. تتحقق ARKS من كل فاتورة وفق قواعد PINT AE قبل الإرسال، لتُكتشف الفواتير غير الصحيحة قبل وصولها إلى الشبكة.",
    },
  },
  {
    q: { en: "How does the invoice actually reach the FTA?", ar: "كيف تصل الفاتورة فعلياً إلى الهيئة؟" },
    a: {
      en: "ARKS validates your invoice to PINT AE, transmits it to your customer over the Peppol network through an access point, and reports the tax data to the FTA. You get an evidence bundle — the UBL document, the Tax Data Document, and a full timeline — proving delivery and reporting for every invoice.",
      ar: "تتحقق ARKS من فاتورتك وفق PINT AE، وترسلها إلى عميلك عبر شبكة Peppol من خلال نقطة وصول، وتبلّغ بيانات الضريبة إلى الهيئة. وتحصل على حزمة أدلة — مستند UBL ومستند بيانات الضريبة وسجل زمني كامل — تُثبت التسليم والإبلاغ لكل فاتورة.",
    },
  },
  {
    q: { en: "Can I connect my accounting or e-commerce system?", ar: "هل يمكنني ربط نظام المحاسبة أو المتجر الإلكتروني لديّ؟" },
    a: {
      en: "Yes. ARKS imports from Excel and connects with common accounting and e-commerce systems — Zoho Books, QuickBooks, Xero, Odoo, Shopify and WooCommerce — and offers a REST API plus an MCP server so AI agents and custom software can create and send invoices directly.",
      ar: "نعم. تستورد ARKS من Excel وتتكامل مع أنظمة المحاسبة والتجارة الإلكترونية الشائعة — Zoho Books وQuickBooks وXero وOdoo وShopify وWooCommerce — كما توفّر واجهة REST وخادم MCP ليتمكّن وكلاء الذكاء الاصطناعي والبرمجيات المخصّصة من إنشاء الفواتير وإرسالها مباشرة.",
    },
  },
  {
    q: { en: "What happens to my invoices if I stop paying?", ar: "ماذا يحدث لفواتيري إذا توقفت عن الدفع؟" },
    a: {
      en: "Transmission to the FTA pauses after the grace period, but your account, history and evidence bundles stay accessible and exportable. Resubscribing restores transmission immediately. We never hold your compliance data hostage.",
      ar: "يتوقف الإرسال إلى الهيئة بعد انتهاء المهلة، لكن يبقى حسابك وسجلّك وحِزم الأدلة متاحة وقابلة للتصدير. ويعيد الاشتراك مجدداً تفعيل الإرسال فوراً. نحن لا نحتجز بيانات امتثالك أبداً.",
    },
  },
  {
    q: { en: "Is my data secure and private?", ar: "هل بياناتي آمنة وخاصة؟" },
    a: {
      en: "Each business's data is isolated at the database level, secrets are encrypted, and every send is server-authoritative. The marketing site runs with no advertising trackers. Access is protected with strong authentication and full audit logging.",
      ar: "بيانات كل منشأة معزولة على مستوى قاعدة البيانات، والأسرار مشفّرة، وكل عملية إرسال تُدار من الخادم. ولا يستخدم الموقع أي أدوات تتبّع إعلانية. والوصول محميّ بمصادقة قوية وسجلّ تدقيق كامل.",
    },
  },
];

/** The mandate primer (content hub / LLM-SEO). */
export const MANDATE_FAQ: Faq[] = [
  {
    q: { en: "When does UAE e-invoicing become mandatory?", ar: "متى تصبح الفوترة الإلكترونية إلزامية في الإمارات؟" },
    a: {
      en: "The FTA is rolling out mandatory e-invoicing in phases under Ministerial Decision No. 64 of 2025, starting with larger taxpayers and expanding to all VAT-registered businesses. Exact go-live dates are set by the FTA per phase; ARKS keeps you ready ahead of your applicable date.",
      ar: "تطرح الهيئة الفوترة الإلكترونية الإلزامية على مراحل بموجب القرار الوزاري رقم 64 لسنة 2025، بدءاً من كبار المكلّفين ثم توسّعها لتشمل جميع المنشآت المسجّلة في ضريبة القيمة المضافة. وتُحدَّد مواعيد التفعيل لكل مرحلة من قِبل الهيئة؛ وتُبقيك ARKS جاهزاً قبل موعدك.",
    },
  },
  {
    q: { en: "What is the Peppol network and the 5-corner model?", ar: "ما هي شبكة Peppol ونموذج الأركان الخمسة؟" },
    a: {
      en: "Peppol is an international framework for exchanging electronic documents. The UAE uses a 5-corner model: the supplier and buyer each connect through an accredited service provider (access point), and tax data is reported to the FTA as the fifth corner. ARKS is your access point and reporting bridge.",
      ar: "Peppol إطار دولي لتبادل المستندات الإلكترونية. وتعتمد الإمارات نموذج الأركان الخمسة: يتصل كلٌّ من المورّد والمشتري عبر مزوّد خدمة معتمد (نقطة وصول)، وتُبلَّغ بيانات الضريبة إلى الهيئة بوصفها الركن الخامس. وARKS هي نقطة وصولك وجسر الإبلاغ.",
    },
  },
  {
    q: { en: "What is a Tax Data Document (TDD)?", ar: "ما هو مستند بيانات الضريبة (TDD)؟" },
    a: {
      en: "The Tax Data Document is the structured record reported to the FTA for each transaction. ARKS generates and reports it automatically and stores acceptance in your evidence bundle.",
      ar: "مستند بيانات الضريبة هو السجل المُهيكل الذي يُبلَّغ إلى الهيئة عن كل معاملة. تُنشئه ARKS وتُبلّغه تلقائياً وتحفظ قبوله ضمن حزمة الأدلة الخاصة بك.",
    },
  },
  {
    q: { en: "Do I still issue a PDF invoice?", ar: "هل ما زلت أُصدر فاتورة PDF؟" },
    a: {
      en: "The legal invoice becomes the structured PINT AE document exchanged over Peppol. A human-readable version can still be shared for convenience, but compliance is satisfied by the structured document and its reporting — both of which ARKS handles.",
      ar: "تصبح الفاتورة القانونية هي مستند PINT AE المُهيكل المُتبادل عبر Peppol. ويمكن مشاركة نسخة مقروءة للراحة، لكن الامتثال يتحقق بالمستند المُهيكل وإبلاغه — وكلاهما تتولّاه ARKS.",
    },
  },
];

/** Short trust/authority facts used across the site. */
export const REGIME_FACTS: { k: Dict; v: Dict }[] = [
  { k: { en: "Regulation", ar: "التشريع" }, v: { en: "Ministerial Decision No. 64 of 2025", ar: "القرار الوزاري رقم 64 لسنة 2025" } },
  { k: { en: "Format", ar: "الصيغة" }, v: { en: "PINT AE (Peppol UBL)", ar: "PINT AE (Peppol UBL)" } },
  { k: { en: "Network", ar: "الشبكة" }, v: { en: "Peppol · 5-corner model", ar: "Peppol · نموذج الأركان الخمسة" } },
  { k: { en: "Reporting", ar: "الإبلاغ" }, v: { en: "FTA Tax Data Document", ar: "مستند بيانات الضريبة للهيئة" } },
];

/* ----------------------------- Feature catalog ----------------------------- */

export interface Feature {
  icon: string; // lucide icon key, mapped in the page
  title: Dict;
  desc: Dict;
}
export interface FeatureGroup {
  id: string;
  eyebrow: Dict;
  title: Dict;
  features: Feature[];
}

export const FEATURE_GROUPS: FeatureGroup[] = [
  {
    id: "create",
    eyebrow: { en: "Create & validate", ar: "الإنشاء والتحقق" },
    title: { en: "Every invoice, correct before it leaves you.", ar: "كل فاتورة صحيحة قبل أن تغادرك." },
    features: [
      { icon: "FileText", title: { en: "Fact-based invoice editor", ar: "محرّر فواتير قائم على الحقائق" }, desc: { en: "Line items, live totals, per-line tax profile, auto-derived document type, and a compliance clock — with validation as you type.", ar: "بنود وإجماليات فورية وملف ضريبي لكل بند ونوع مستند مُشتق تلقائياً ومؤقّت امتثال — مع تحقق أثناء الكتابة." } },
      { icon: "FileCheck2", title: { en: "PINT AE validation", ar: "التحقق وفق PINT AE" }, desc: { en: "Every invoice is validated against the UAE PINT AE rules before send — field-level errors with plain-language fixes.", ar: "يُتحقق من كل فاتورة وفق قواعد PINT AE الإماراتية قبل الإرسال — أخطاء على مستوى الحقل مع إصلاحات بلغة واضحة." } },
      { icon: "Calculator", title: { en: "UAE VAT & tax logic", ar: "منطق ضريبة القيمة المضافة الإماراتية" }, desc: { en: "Standard 5%, zero-rated, exempt, out-of-scope, reverse-charge, designated-zone and margin schemes — VAT rounded per category.", ar: "5% قياسي، صفري، معفى، خارج النطاق، احتساب عكسي، مناطق محددة وأنظمة الهامش — مع تقريب الضريبة لكل فئة." } },
      { icon: "Files", title: { en: "Credit & debit notes, proforma", ar: "إشعارات دائنة ومدينة وفاتورة مبدئية" }, desc: { en: "Raise credit notes with reason codes, issue proforma drafts, and convert proforma to a tax invoice in one click.", ar: "أصدر إشعارات دائنة برموز الأسباب، وأنشئ مسودات فاتورة مبدئية، وحوّلها إلى فاتورة ضريبية بنقرة واحدة." } },
      { icon: "Hash", title: { en: "Per-entity numbering", ar: "ترقيم لكل منشأة" }, desc: { en: "Prefix + sequence per entity, so every TRN keeps its own compliant invoice series.", ar: "بادئة وتسلسل لكل منشأة، ليحتفظ كل رقم تسجيل ضريبي بسلسلة فواتير مطابقة خاصة به." } },
    ],
  },
  {
    id: "transmit",
    eyebrow: { en: "Transmit & report", ar: "الإرسال والإبلاغ" },
    title: { en: "To your customer and the FTA — proven.", ar: "إلى عميلك وإلى الهيئة — بإثبات." },
    features: [
      { icon: "Radio", title: { en: "Peppol transmission", ar: "الإرسال عبر Peppol" }, desc: { en: "Send structured invoices to your customers over the Peppol network as your access point.", ar: "أرسل فواتير مُهيكلة إلى عملائك عبر شبكة Peppol بوصفنا نقطة وصولك." } },
      { icon: "ShieldCheck", title: { en: "FTA reporting (TDD)", ar: "الإبلاغ للهيئة (TDD)" }, desc: { en: "The Tax Data Document is generated and reported to the FTA automatically, with a SHA-256 integrity hash of the exact UBL.", ar: "يُنشأ مستند بيانات الضريبة ويُبلَّغ إلى الهيئة تلقائياً، مع بصمة SHA-256 لسلامة مستند UBL ذاته." } },
      { icon: "FileArchive", title: { en: "Compliance evidence bundle", ar: "حزمة أدلة الامتثال" }, desc: { en: "A downloadable audit pack per invoice: the UBL, the TDD, a full timeline and a SHA-256 manifest — retention-ready.", ar: "حزمة تدقيق قابلة للتنزيل لكل فاتورة: مستند UBL وTDD وسجل زمني كامل وبيان SHA-256 — جاهزة للحفظ." } },
      { icon: "Network", title: { en: "Two-leg delivery status", ar: "حالة تسليم بمسارين" }, desc: { en: "Track exchange delivery and FTA reporting separately, with a live timeline and gateway webhooks.", ar: "تابع تسليم التبادل وإبلاغ الهيئة بشكل منفصل، مع سجل زمني فوري وويب هوك للبوابة." } },
      { icon: "SearchCheck", title: { en: "Peppol reachability check", ar: "فحص الوصول عبر Peppol" }, desc: { en: "Check whether a customer is registered on the Peppol network before you invoice them — per-customer or in bulk.", ar: "تحقق مما إذا كان العميل مسجّلاً على شبكة Peppol قبل إصدار الفاتورة — لكل عميل أو دفعة واحدة." } },
    ],
  },
  {
    id: "getpaid",
    eyebrow: { en: "Get paid", ar: "التحصيل" },
    title: { en: "Turn compliant invoices into cash.", ar: "حوّل الفواتير المطابقة إلى سيولة." },
    features: [
      { icon: "Wallet", title: { en: "Accounts receivable", ar: "الذمم المدينة" }, desc: { en: "Aging buckets, DSO, outstanding and overdue — see exactly what to chase.", ar: "شرائح تقادم وDSO والمستحق والمتأخر — لترى بدقة ما يجب متابعته." } },
      { icon: "CreditCard", title: { en: "Payment links", ar: "روابط الدفع" }, desc: { en: "Attach a hosted pay link to any invoice and reconcile the payment automatically.", ar: "أرفق رابط دفع مستضاف بأي فاتورة وسوّ الدفعة تلقائياً." } },
      { icon: "Repeat", title: { en: "Recurring invoices", ar: "الفواتير المتكررة" }, desc: { en: "Templates on weekly, monthly, quarterly or yearly cadence, with optional auto-send.", ar: "قوالب بجدولة أسبوعية أو شهرية أو ربع سنوية أو سنوية، مع إرسال تلقائي اختياري." } },
      { icon: "BellRing", title: { en: "Overdue chasing", ar: "متابعة المتأخرات" }, desc: { en: "Surface overdue invoices, send a pay link, and mark payments received — keep DSO down.", ar: "أبرِز الفواتير المتأخرة، وأرسل رابط دفع، وسجّل الدفعات المستلمة — لخفض DSO." } },
    ],
  },
  {
    id: "connect",
    eyebrow: { en: "Import & connect", ar: "الاستيراد والربط" },
    title: { en: "Bring your data in from anywhere.", ar: "استقدم بياناتك من أي مصدر." },
    features: [
      { icon: "Table2", title: { en: "Excel & Tally import", ar: "استيراد Excel وTally" }, desc: { en: "Drag in .xlsx/.csv — columns are auto-mapped (it recognises Tally, Zoho and QuickBooks headers, including Arabic) and each row is validated.", ar: "اسحب ملف xlsx/csv — تُربط الأعمدة تلقائياً (يتعرّف على ترويسات Tally وZoho وQuickBooks، بما فيها العربية) ويُتحقق من كل صف." } },
      { icon: "Boxes", title: { en: "Accounting & e-commerce", ar: "المحاسبة والتجارة الإلكترونية" }, desc: { en: "Connect Zoho Books, QuickBooks, Xero, Odoo, Shopify and WooCommerce — orders and invoices sync in, TRN-mapped and idempotent.", ar: "اربط Zoho Books وQuickBooks وXero وOdoo وShopify وWooCommerce — تتزامن الطلبات والفواتير، بربط رقم التسجيل الضريبي وبلا تكرار." } },
      { icon: "MessageCircle", title: { en: "WhatsApp delivery", ar: "التسليم عبر واتساب" }, desc: { en: "Send an invoice and a pay link to your customer over WhatsApp from your own number.", ar: "أرسل فاتورة ورابط دفع إلى عميلك عبر واتساب من رقمك الخاص." } },
    ],
  },
  {
    id: "developers",
    eyebrow: { en: "Developers & AI", ar: "المطوّرون والذكاء الاصطناعي" },
    title: { en: "Invoicing your software and AI can drive.", ar: "فوترة يقودها برنامجك والذكاء الاصطناعي." },
    features: [
      { icon: "Terminal", title: { en: "REST API", ar: "واجهة REST" }, desc: { en: "Create, validate, send and fetch invoices programmatically with bearer API keys — the same engine as the UI.", ar: "أنشئ الفواتير وتحقق منها وأرسلها واجلبها برمجياً بمفاتيح API — بالمحرّك نفسه الذي يشغّل الواجهة." } },
      { icon: "Bot", title: { en: "MCP server for AI agents", ar: "خادم MCP لوكلاء الذكاء الاصطناعي" }, desc: { en: "A native Model Context Protocol server lets an AI agent list, validate, create and send invoices directly.", ar: "خادم Model Context Protocol أصيل يتيح لوكيل الذكاء الاصطناعي سرد الفواتير والتحقق منها وإنشاءها وإرسالها مباشرة." } },
      { icon: "KeyRound", title: { en: "OAuth 2.1 & API keys", ar: "OAuth 2.1 ومفاتيح API" }, desc: { en: "Scoped, hashed API keys and a full OAuth 2.1 server (PKCE, dynamic client registration) for secure agent sign-in.", ar: "مفاتيح API مُنطّقة ومجزّأة وخادم OAuth 2.1 كامل (PKCE وتسجيل عملاء ديناميكي) لتسجيل دخول آمن للوكلاء." } },
      { icon: "Gauge", title: { en: "Usage metering API", ar: "واجهة قياس الاستخدام" }, desc: { en: "Query billable exchanges against your allowance programmatically.", ar: "استعلم عن التبادلات القابلة للفوترة مقابل حصتك برمجياً." } },
    ],
  },
  {
    id: "control",
    eyebrow: { en: "Security & control", ar: "الأمان والتحكم" },
    title: { en: "Multi-entity, isolated, audit-ready.", ar: "متعدد المنشآت، معزول، جاهز للتدقيق." },
    features: [
      { icon: "Building2", title: { en: "Multi-entity / multi-TRN", ar: "منشآت متعددة / أرقام تسجيل متعددة" }, desc: { en: "Run several entities and TRNs from one workspace, each with its own Peppol ID, numbering and currency.", ar: "أدر عدة منشآت وأرقام تسجيل ضريبي من مساحة عمل واحدة، لكل منها معرّف Peppol وترقيم وعملة خاصة." } },
      { icon: "Lock", title: { en: "Tenant isolation & encryption", ar: "عزل المستأجرين والتشفير" }, desc: { en: "Every business's data is isolated at the database level; integration secrets are encrypted at rest.", ar: "بيانات كل منشأة معزولة على مستوى قاعدة البيانات؛ وأسرار التكامل مشفّرة أثناء التخزين." } },
      { icon: "Download", title: { en: "Data export & portability", ar: "تصدير البيانات وقابلية النقل" }, desc: { en: "Export all your records plus the UBL and TDD documents at any time. No lock-in.", ar: "صدّر جميع سجلاتك مع مستندات UBL وTDD في أي وقت. دون احتجاز." } },
      { icon: "ClipboardCheck", title: { en: "Fix-it queue", ar: "قائمة الإصلاح" }, desc: { en: "A ranked, live list of compliance blockers — validation errors, deadline breaches, undeliverable customers — so nothing slips.", ar: "قائمة حيّة مرتّبة بمعوّقات الامتثال — أخطاء التحقق وتجاوز المواعيد والعملاء غير القابلين للتسليم — كي لا يفوت شيء." } },
    ],
  },
];

/** Flat feature list for ItemList JSON-LD + llms files. */
export const ALL_FEATURES: Feature[] = FEATURE_GROUPS.flatMap((g) => g.features);
