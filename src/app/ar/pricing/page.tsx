import type { Metadata } from "next";
import Link from "next/link";
import { Check, ArrowLeft, ShieldCheck, Infinity as InfinityIcon, FileCheck2 } from "lucide-react";
import { PricingCards } from "@/components/marketing/pricing-cards";
import { FaqList } from "@/components/marketing/faq";
import { OrganizationJsonLd, WebSiteJsonLd, SoftwareApplicationJsonLd, FaqJsonLd, BreadcrumbJsonLd } from "@/components/marketing/jsonld";
import { HOME_FAQ, faqText } from "@/lib/marketing/content";
import { bilingualAlternates } from "@/lib/marketing/i18n";

const FAQ_AR = HOME_FAQ.map((f) => faqText(f, "ar"));

export const metadata: Metadata = {
  title: "الأسعار — فوترة إلكترونية غير محدودة من 299 درهماً/شهر",
  description:
    "تسعير مسطّح للفوترة الإلكترونية في الإمارات. 299 درهماً شهرياً، أو 1,500 درهم لستة أشهر، أو 2,400 درهم سنوياً — الكل مع فوترة غير محدودة وكل الميزات. تجربة مجانية 14 يوماً دون بطاقة.",
  alternates: bilingualAlternates("/pricing", "ar"),
  openGraph: { title: "الأسعار — فوترة إلكترونية غير محدودة من 299 درهماً/شهر" },
};

const INCLUDED = [
  "فواتير وإشعارات دائنة ومدينة غير محدودة",
  "تحقق PINT AE قبل كل إرسال",
  "إرسال عبر Peppol من خلال نقطة وصول",
  "إبلاغ الهيئة + حزمة أدلة (UBL · TDD · سجل)",
  "استيراد Excel وموصّلات أنظمة المحاسبة",
  "واجهة REST + خادم MCP لوكلاء الذكاء الاصطناعي",
  "أعضاء فريق وأدوار ومنشآت متعددة",
  "سجل تدقيق وتصدير للبيانات، دائماً",
];

const TRUST = [
  { icon: InfinityIcon, t: "بلا عدّاد", d: "تكلفتنا لكل فاتورة كسر من الفلس. لا نعدّ — أنت ترسل فقط." },
  { icon: FileCheck2, t: "بلا احتجاز", d: "صدّر فواتيرك وحزم الأدلة في أي وقت، على أي خطة." },
  { icon: ShieldCheck, t: "بلا قطع دون إنذار", d: "مهلة 7 أيام وتذكيرات تسبق أي إيقاف. بياناتك تبقى لك." },
];

export default function ArPricingPage() {
  return (
    <>
      <OrganizationJsonLd />
      <WebSiteJsonLd locale="ar" />
      <SoftwareApplicationJsonLd />
      <FaqJsonLd items={FAQ_AR} locale="ar" />
      <BreadcrumbJsonLd items={[{ name: "الرئيسية", path: "/ar" }, { name: "الأسعار", path: "/ar/pricing" }]} />

      <section className="relative overflow-hidden">
        <div className="mkt-grid pointer-events-none absolute inset-0 opacity-50" />
        <div className="relative mx-auto max-w-3xl px-5 pb-4 pt-16 text-center lg:pt-24">
          <p className="mkt-eyebrow">الأسعار</p>
          <h1 className="mkt-display mt-4 text-5xl font-extrabold sm:text-6xl">
            فوترة غير محدودة.
            <br />
            سعر ثابت <span style={{ color: "var(--signal)" }}>واحد</span>.
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-lg" style={{ color: "var(--on-ink-soft)" }}>
            كل خطة هي المنتج كاملاً مع إرسال غير محدود إلى الهيئة. كلما التزمت أطول، دفعت أقل شهرياً — لا شيء آخر يتغيّر.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 pb-4 pt-8">
        <PricingCards locale="ar" />
        <p className="mkt-mono mt-6 text-center text-[12px]" style={{ color: "var(--on-ink-faint)" }}>
          الأسعار بالدرهم، شاملة الضريبة · تُصدَر فاتورة ضريبية عن اشتراكك · تجربة 14 يوماً دون بطاقة
        </p>
      </section>

      <section className="mkt-section">
        <div className="mx-auto max-w-6xl px-5">
          <div className="rounded-3xl border p-8 lg:p-12" style={{ borderColor: "var(--ink-line)", background: "var(--ink-2)" }}>
            <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr]">
              <div>
                <p className="mkt-eyebrow">في كل خطة</p>
                <h2 className="mkt-display mt-3 text-3xl font-bold sm:text-4xl">لا توجد خطة «احترافية». هذا هو المنتج كاملاً.</h2>
                <p className="mt-4 text-base" style={{ color: "var(--on-ink-soft)" }}>لا نحجب ميزات الامتثال خلف سعر أعلى. سواء أرسلت عشر فواتير أو عشرة آلاف، تحصل على المنصّة كاملة.</p>
                <Link href="/signup" className="mkt-btn mkt-btn-primary mt-6">ابدأ مجاناً <ArrowLeft className="size-4" /></Link>
              </div>
              <ul className="grid gap-3 sm:grid-cols-2">
                {INCLUDED.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-sm" style={{ color: "var(--on-ink)" }}>
                    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md" style={{ background: "var(--signal-ink)", color: "var(--signal-2)" }}><Check className="size-3.5" /></span>
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-3">
            {TRUST.map((t) => (
              <div key={t.t} className="rounded-2xl border p-6" style={{ borderColor: "var(--ink-line)" }}>
                <t.icon className="size-5" style={{ color: "var(--signal)" }} />
                <h3 className="mkt-display mt-4 text-lg font-bold">{t.t}</h3>
                <p className="mt-2 text-sm" style={{ color: "var(--on-ink-soft)" }}>{t.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t" style={{ borderColor: "var(--ink-line)" }}>
        <div className="mx-auto max-w-3xl px-5 py-16 lg:py-20">
          <h2 className="mkt-display text-center text-3xl font-bold sm:text-4xl">أسئلة عن الأسعار</h2>
          <div className="mt-10"><FaqList items={FAQ_AR.slice(1, 5)} /></div>
        </div>
      </section>
    </>
  );
}
