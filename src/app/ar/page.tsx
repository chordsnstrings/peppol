import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, FileStack, FileCheck2, Radio, ShieldCheck, Infinity as InfinityIcon, Terminal, Boxes, Lock, CircleCheck } from "lucide-react";
import { HeroProof } from "@/components/marketing/hero-proof";
import { PricingCards } from "@/components/marketing/pricing-cards";
import { FaqList } from "@/components/marketing/faq";
import { OrganizationJsonLd, WebSiteJsonLd, SoftwareApplicationJsonLd, ServiceJsonLd, FaqJsonLd, BreadcrumbJsonLd } from "@/components/marketing/jsonld";
import { HOME_FAQ, REGIME_FACTS, faqText } from "@/lib/marketing/content";
import { bilingualAlternates } from "@/lib/marketing/i18n";

const FAQ_AR = HOME_FAQ.map((f) => faqText(f, "ar"));

export const metadata: Metadata = {
  title: "الفوترة الإلكترونية في الإمارات — تحقّق وأرسِل إلى الهيئة",
  description:
    "امتثل لتفويض الفوترة الإلكترونية للهيئة الاتحادية للضرائب. تحقّق من فواتير PINT AE وأرسلها عبر Peppol وأثبت الإبلاغ للهيئة — فوترة غير محدودة من 299 درهماً شهرياً. تجربة مجانية 14 يوماً دون بطاقة.",
  alternates: bilingualAlternates("/", "ar"),
  openGraph: {
    title: "الفوترة الإلكترونية في الإمارات — تحقّق وأرسِل إلى الهيئة",
    description: "تحقّق من فواتير PINT AE وأرسلها عبر Peppol وأثبت الإبلاغ للهيئة. فوترة غير محدودة من 299 درهماً شهرياً.",
  },
};

const STEPS = [
  { icon: FileStack, n: "٠١", t: "أنشئ أو استورد", d: "أدخل فاتورة، أو استورد من Excel، أو ادفعها من نظام المحاسبة أو المتجر أو عبر الواجهة البرمجية." },
  { icon: FileCheck2, n: "٠٢", t: "تحقّق وفق PINT AE", d: "يُفحص كل حقل وفق قواعد PINT AE قبل أن يغادر مساحة عملك. تُكتشف الأخطاء هنا لا عند الهيئة." },
  { icon: Radio, n: "٠٣", t: "أرسِل وأبلِغ", d: "نرسلها إلى عميلك عبر Peppol ونبلّغ مستند بيانات الضريبة للهيئة — مع حزمة أدلة تُثبت الأمرين." },
];

const HIGHLIGHTS = [
  { icon: InfinityIcon, t: "فوترة غير محدودة", d: "سعر ثابت واحد. دون رسوم لكل فاتورة ولا مفاجآت آخر الشهر." },
  { icon: ShieldCheck, t: "مُثبت للهيئة", d: "كل فاتورة مع حزمة أدلة: UBL ومستند بيانات الضريبة وسجل زمني." },
  { icon: FileCheck2, t: "التحقق أولاً", d: "قواعد PINT AE تعمل قبل الإرسال، فلا تصل فاتورة غير صحيحة للشبكة." },
  { icon: Terminal, t: "واجهة وMCP", d: "واجهة REST وخادم MCP ليتمكّن برنامجك ووكلاء الذكاء الاصطناعي من الفوترة." },
  { icon: Boxes, t: "منشآت متعددة", d: "أدر عدة أرقام تسجيل ضريبي من مساحة عمل واحدة، كلٌّ معزول ومُدقَّق." },
  { icon: Lock, t: "معزول ومشفّر", d: "عزل بيانات لكل منشأة، وأسرار مشفّرة، ومصادقة قوية، وسجل تدقيق كامل." },
];

export default function ArLandingPage() {
  return (
    <>
      <OrganizationJsonLd />
      <WebSiteJsonLd locale="ar" />
      <SoftwareApplicationJsonLd />
      <ServiceJsonLd />
      <FaqJsonLd items={FAQ_AR} locale="ar" />
      <BreadcrumbJsonLd items={[{ name: "الرئيسية", path: "/ar" }]} />

      {/* hero */}
      <section className="relative overflow-hidden">
        <div className="mkt-grid pointer-events-none absolute inset-0 opacity-60" />
        <div className="pointer-events-none absolute -top-40 left-0 h-[520px] w-[520px] rounded-full opacity-40 blur-3xl" style={{ background: "radial-gradient(circle, color-mix(in srgb, var(--signal) 40%, transparent), transparent 70%)" }} />
        <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-5 pb-16 pt-14 lg:grid-cols-[1.05fr_0.95fr] lg:pb-24 lg:pt-20">
          <div>
            <span className="mkt-mono inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px]" style={{ borderColor: "var(--ink-line)", color: "var(--on-ink-soft)" }}>
              <span className="size-1.5 rounded-full" style={{ background: "var(--signal)" }} />
              تفويض الهيئة الاتحادية للضرائب · القرار الوزاري 64
            </span>
            <h1 className="mkt-display mt-6 text-5xl font-extrabold sm:text-6xl lg:text-[4.4rem]">
              أوصِل فاتورتك للهيئة
              <br />
              بإرسال <span style={{ color: "var(--signal)" }}>واحد</span> نظيف.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed" style={{ color: "var(--on-ink-soft)" }}>
              تتحقق ARKS من فاتورتك وفق PINT AE، وترسلها عبر Peppol، وتُثبت وصولها إلى الهيئة الاتحادية للضرائب. فوترة غير محدودة بسعر ثابت — ليصبح الامتثال حقيقة في الخلفية لا هَمّاً شهرياً.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/signup" className="mkt-btn mkt-btn-primary">ابدأ تجربة 14 يوماً مجاناً <ArrowLeft className="size-4" /></Link>
              <Link href="/ar#how" className="mkt-btn mkt-btn-ghost">كيف تعمل</Link>
            </div>
            <div className="mkt-mono mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px]" style={{ color: "var(--on-ink-faint)" }}>
              <span className="inline-flex items-center gap-1.5"><CircleCheck className="size-3.5" style={{ color: "var(--signal)" }} /> دون بطاقة</span>
              <span className="inline-flex items-center gap-1.5"><CircleCheck className="size-3.5" style={{ color: "var(--signal)" }} /> فواتير غير محدودة</span>
              <span className="inline-flex items-center gap-1.5"><CircleCheck className="size-3.5" style={{ color: "var(--signal)" }} /> من 299 درهماً/شهر</span>
            </div>
          </div>
          <div className="lg:pe-4"><HeroProof locale="ar" /></div>
        </div>

        {/* regime facts */}
        <div className="relative border-y" style={{ borderColor: "var(--ink-line)", background: "color-mix(in srgb, var(--ink-2) 60%, transparent)" }}>
          <div className="mx-auto grid max-w-6xl grid-cols-2 gap-px px-5 md:grid-cols-4">
            {REGIME_FACTS.map((f) => (
              <div key={f.k.ar} className="px-2 py-5">
                <p className="mkt-eyebrow">{f.k.ar}</p>
                <p className="mt-1.5 text-sm font-medium" style={{ color: "var(--on-ink)" }}>{f.v.ar}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* how it works (paper) */}
      <section id="how" className="mkt-paper mkt-section scroll-mt-20">
        <div className="mx-auto max-w-6xl px-5">
          <div className="max-w-2xl">
            <p className="mkt-eyebrow">كيف تعمل</p>
            <h2 className="mkt-display mt-3 text-4xl font-bold sm:text-5xl">من المسودة إلى الهيئة، دون تخمين.</h2>
            <p className="mkt-soft mt-4 text-lg">ثلاث خطوات، آليّة بالكامل. أنت تعتمد؛ وARKS تتحقق وترسل وتبلّغ.</p>
          </div>
          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {STEPS.map((s) => (
              <div key={s.n} className="rounded-2xl border p-6" style={{ borderColor: "var(--paper-line)", background: "#fff" }}>
                <div className="flex items-center justify-between">
                  <span className="flex size-11 items-center justify-center rounded-xl" style={{ background: "var(--signal-ink)", color: "var(--signal-2)" }}><s.icon className="size-5" /></span>
                  <span className="mkt-mono text-xl font-bold" style={{ color: "var(--paper-line)" }}>{s.n}</span>
                </div>
                <h3 className="mkt-display mt-5 text-xl font-bold">{s.t}</h3>
                <p className="mkt-soft mt-2 text-sm leading-relaxed">{s.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* features highlights */}
      <section className="mkt-section">
        <div className="mx-auto max-w-6xl px-5">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div className="max-w-2xl">
              <p className="mkt-eyebrow">ما تحصل عليه</p>
              <h2 className="mkt-display mt-3 text-4xl font-bold sm:text-5xl">مبنيّ لامتثال لا تفكّر فيه.</h2>
            </div>
            <Link href="/ar/features" className="mkt-btn mkt-btn-ghost">كل المزايا <ArrowLeft className="size-4" /></Link>
          </div>
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {HIGHLIGHTS.map((f) => (
              <div key={f.t} className="mkt-card rounded-2xl border p-6" style={{ borderColor: "var(--ink-line)", background: "var(--ink-2)" }}>
                <span className="flex size-11 items-center justify-center rounded-xl" style={{ background: "var(--ink-3)", color: "var(--signal)" }}><f.icon className="size-5" /></span>
                <h3 className="mkt-display mt-5 text-lg font-bold">{f.t}</h3>
                <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--on-ink-soft)" }}>{f.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* pricing teaser */}
      <section className="mkt-section border-t" style={{ borderColor: "var(--ink-line)" }}>
        <div className="mx-auto max-w-6xl px-5">
          <div className="mx-auto max-w-2xl text-center">
            <p className="mkt-eyebrow">تسعير بسيط</p>
            <h2 className="mkt-display mt-3 text-4xl font-bold sm:text-5xl">سعر ثابت واحد. كل شيء مشمول.</h2>
            <p className="mt-4 text-lg" style={{ color: "var(--on-ink-soft)" }}>فوترة غير محدودة في كل خطة. التزم أطول، وادفع أقل — هذا هو الفرق الوحيد.</p>
          </div>
          <div className="mt-12"><PricingCards compact locale="ar" /></div>
          <div className="mt-6 text-center">
            <Link href="/ar/pricing" className="mkt-mono text-sm" style={{ color: "var(--signal-2)" }}>عرض كل التفاصيل ←</Link>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t" style={{ borderColor: "var(--ink-line)" }}>
        <div className="mx-auto max-w-3xl px-5 py-16 lg:py-24">
          <div className="text-center">
            <p className="mkt-eyebrow">أسئلة</p>
            <h2 className="mkt-display mt-3 text-4xl font-bold sm:text-5xl">كل ما كنت ستسأل عنه.</h2>
          </div>
          <div className="mt-10"><FaqList items={FAQ_AR} /></div>
        </div>
      </section>

      {/* CTA */}
      <section className="relative overflow-hidden border-t" style={{ borderColor: "var(--ink-line)" }}>
        <div className="pointer-events-none absolute inset-0 opacity-50" style={{ background: "radial-gradient(60% 120% at 50% 0%, color-mix(in srgb, var(--signal) 18%, transparent), transparent 70%)" }} />
        <div className="relative mx-auto max-w-3xl px-5 py-20 text-center lg:py-28">
          <h2 className="mkt-display text-4xl font-extrabold sm:text-5xl">كن جاهزاً قبل أن يصلك التفويض.</h2>
          <p className="mx-auto mt-5 max-w-xl text-lg" style={{ color: "var(--on-ink-soft)" }}>ابدأ مجاناً اليوم. أرسل أول فاتورة مطابقة إلى الهيئة خلال دقائق — دون بطاقة ولا مكالمة مبيعات.</p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link href="/signup" className="mkt-btn mkt-btn-primary">ابدأ تجربة 14 يوماً مجاناً <ArrowLeft className="size-4" /></Link>
            <Link href="/ar/pricing" className="mkt-btn mkt-btn-ghost">قارن الخطط</Link>
          </div>
        </div>
      </section>
    </>
  );
}
