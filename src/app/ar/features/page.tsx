import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { FeatureGrid } from "@/components/marketing/feature-grid";
import { OrganizationJsonLd, WebSiteJsonLd, ServiceJsonLd, ItemListJsonLd, BreadcrumbJsonLd } from "@/components/marketing/jsonld";
import { FEATURE_GROUPS, ALL_FEATURES } from "@/lib/marketing/content";
import { bilingualAlternates } from "@/lib/marketing/i18n";

export const metadata: Metadata = {
  title: "المزايا — كل ما يلزم للفوترة الإلكترونية في الإمارات",
  description:
    "مجموعة مزايا ARKS الكاملة للفوترة الإلكترونية في الإمارات: تحقق PINT AE، إرسال Peppol، إبلاغ الهيئة مع حزم أدلة، الذمم المدينة، استيراد Excel والمحاسبة، واجهة REST وخادم MCP — فوترة غير محدودة في كل خطة.",
  alternates: bilingualAlternates("/features", "ar"),
  openGraph: { title: "المزايا — كل ما يلزم للفوترة الإلكترونية في الإمارات" },
};

export default function ArFeaturesPage() {
  return (
    <>
      <OrganizationJsonLd />
      <WebSiteJsonLd locale="ar" />
      <ServiceJsonLd />
      <ItemListJsonLd name="ARKS features" items={ALL_FEATURES.map((f) => ({ name: f.title.ar }))} />
      <BreadcrumbJsonLd items={[{ name: "الرئيسية", path: "/ar" }, { name: "المزايا", path: "/ar/features" }]} />

      <section className="relative overflow-hidden border-b" style={{ borderColor: "var(--ink-line)" }}>
        <div className="mkt-grid pointer-events-none absolute inset-0 opacity-50" />
        <div className="relative mx-auto max-w-6xl px-5 pb-12 pt-16 lg:pt-20">
          <p className="mkt-eyebrow">المنصّة</p>
          <h1 className="mkt-display mt-4 max-w-3xl text-5xl font-extrabold sm:text-6xl">
            كل ما تحتاجه لتكون <span style={{ color: "var(--signal)" }}>ممتثلاً</span> — وتُحصّل.
          </h1>
          <p className="mt-6 max-w-2xl text-lg" style={{ color: "var(--on-ink-soft)" }}>
            من محرّر الفاتورة إلى الهيئة ثم إلى حسابك البنكي. كل ميزة أدناه مشمولة في كل خطة — فوترة غير محدودة بسعر ثابت واحد.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/signup" className="mkt-btn mkt-btn-primary">ابدأ تجربة 14 يوماً مجاناً <ArrowLeft className="size-4" /></Link>
            <Link href="/ar/pricing" className="mkt-btn mkt-btn-ghost">عرض الأسعار</Link>
          </div>
        </div>
      </section>

      <section className="mkt-section">
        <div className="mx-auto max-w-6xl px-5">
          <FeatureGrid groups={FEATURE_GROUPS} locale="ar" />
        </div>
      </section>

      <section className="border-t" style={{ borderColor: "var(--ink-line)" }}>
        <div className="mx-auto max-w-3xl px-5 py-16 text-center lg:py-20">
          <h2 className="mkt-display text-3xl font-bold sm:text-4xl">شاهدها على فواتيرك.</h2>
          <p className="mx-auto mt-4 max-w-xl text-lg" style={{ color: "var(--on-ink-soft)" }}>ابدأ مجاناً — أرسل فاتورة مطابقة إلى الهيئة خلال دقائق.</p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Link href="/signup" className="mkt-btn mkt-btn-primary">ابدأ تجربة 14 يوماً مجاناً <ArrowLeft className="size-4" /></Link>
            <Link href="/ar/uae-e-invoicing" className="mkt-btn mkt-btn-ghost">اقرأ دليل التفويض</Link>
          </div>
        </div>
      </section>
    </>
  );
}
