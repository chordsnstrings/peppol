import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { FaqList } from "@/components/marketing/faq";
import { OrganizationJsonLd, WebSiteJsonLd, ArticleJsonLd, FaqJsonLd, BreadcrumbJsonLd } from "@/components/marketing/jsonld";
import { MANDATE_FAQ, REGIME_FACTS, faqText } from "@/lib/marketing/content";
import { bilingualAlternates } from "@/lib/marketing/i18n";

const FAQ_AR = MANDATE_FAQ.map((f) => faqText(f, "ar"));

export const metadata: Metadata = {
  title: "الفوترة الإلكترونية في الإمارات — تفويض الهيئة وPINT AE وPeppol",
  description:
    "دليل مبسّط للفوترة الإلكترونية الإلزامية في الإمارات: القرار الوزاري 64، نموذج Peppol بالأركان الخمسة، صيغة PINT AE، مستند بيانات الضريبة، وجدول الطرح — وكيف تكون جاهزاً.",
  alternates: bilingualAlternates("/uae-e-invoicing", "ar"),
  openGraph: { type: "article", title: "الفوترة الإلكترونية في الإمارات — تفويض الهيئة وPINT AE وPeppol" },
};

const SECTIONS = [
  {
    h: "ما هي الفوترة الإلكترونية في الإمارات؟",
    body: [
      "تتجه الإمارات إلى الفوترة الإلكترونية الإلزامية. وبموجب القرار الوزاري رقم 64 لسنة 2025، ستتبادل المنشآت المسجّلة في ضريبة القيمة المضافة الفواتير كمستندات رقمية مُهيكلة عبر مزوّدي خدمة معتمدين على شبكة Peppol، وتُبلَّغ بيانات الضريبة إلى الهيئة الاتحادية للضرائب.",
      "الهدف رؤية موحّدة وشبه فورية لمعاملات الأعمال — تقلّل الاحتيال الضريبي والكلفة الإدارية وتواكب الأنظمة الدولية للرقابة على المعاملات.",
    ],
  },
  {
    h: "نموذج Peppol بالأركان الخمسة",
    body: ["تعتمد الإمارات إطار Peppol الدولي عبر نموذج الأركان الخمسة:"],
    bullets: [
      "الركن 1 — المورّد الذي يُصدر الفاتورة.",
      "الركن 2 — نقطة وصول المورّد التي تتحقق وترسل (هنا تقع ARKS).",
      "الركن 3 — نقطة وصول المشتري التي تستقبل وتسلّم.",
      "الركن 4 — المشتري الذي يستلم الفاتورة المُهيكلة.",
      "الركن 5 — الهيئة التي تستلم بيانات الضريبة المُبلَّغة.",
    ],
  },
  {
    h: "صيغة PINT AE",
    body: [
      "PINT AE هي تخصيص الإمارات لصيغة Peppol الدولية — مستند UBL بصيغة XML مُهيكلة يحدّد الحقول المطلوبة في الفاتورة الضريبية الإماراتية والقواعد التي يجب أن تستوفيها.",
      "التحقق وفق PINT AE قبل الإرسال هو الخطوة الأهم: الفاتورة التي لا تجتاز القواعد يجب ألا تصل إلى الشبكة. وتُجري ARKS هذا التحقق على كل مستند وتُظهر أخطاء على مستوى الحقل مع إصلاحات واضحة.",
    ],
  },
  {
    h: "جدول الطرح",
    body: [
      "تطرح الهيئة التفويض على مراحل، بدءاً من كبار المكلّفين ثم توسّعها لتشمل جميع المنشآت المسجّلة في ضريبة القيمة المضافة. ولكل مرحلة موعد تفعيل تحدّده الهيئة.",
      "الخلاصة العملية: الاتجاه ثابت والمراحل تقترب. والجاهزية المبكرة تعني عدم وجود تدافع في اللحظات الأخيرة ولا مخاطر امتثال عند بدء مرحلتك.",
    ],
  },
  {
    h: "كيف تساعد ARKS",
    body: [
      "ARKS هي نقطة الوصول وجسر الإبلاغ معاً. تنشئ فاتورة أو تستوردها؛ فتتحقق ARKS منها وفق PINT AE، وترسلها عبر Peppol، وتبلّغ مستند بيانات الضريبة للهيئة — ثم تسلّمك حزمة أدلة تُثبت التسليم والإبلاغ. فوترة غير محدودة وواجهة REST وخادم MCP، واشتراك ثابت مع تجربة 14 يوماً مجاناً.",
    ],
  },
];

export default function ArMandateGuide() {
  return (
    <>
      <OrganizationJsonLd />
      <WebSiteJsonLd locale="ar" />
      <ArticleJsonLd
        headline="الفوترة الإلكترونية في الإمارات: تفويض الهيئة وPINT AE وPeppol"
        description="دليل مبسّط للفوترة الإلكترونية الإلزامية في الإمارات بموجب القرار الوزاري 64 — نموذج Peppol بالأركان الخمسة، وصيغة PINT AE، ومستند بيانات الضريبة، وجدول الطرح."
        path="/ar/uae-e-invoicing"
        datePublished="2026-01-01"
        dateModified="2026-07-01"
        locale="ar"
      />
      <FaqJsonLd items={FAQ_AR} locale="ar" />
      <BreadcrumbJsonLd items={[{ name: "الرئيسية", path: "/ar" }, { name: "الفوترة الإلكترونية", path: "/ar/uae-e-invoicing" }]} />

      <section className="relative overflow-hidden border-b" style={{ borderColor: "var(--ink-line)" }}>
        <div className="mkt-grid pointer-events-none absolute inset-0 opacity-50" />
        <div className="relative mx-auto max-w-3xl px-5 pb-12 pt-16 lg:pt-20">
          <p className="mkt-eyebrow">دليل الامتثال</p>
          <h1 className="mkt-display mt-4 text-4xl font-extrabold sm:text-5xl">الفوترة الإلكترونية في الإمارات، مبسّطة.</h1>
          <p className="mt-5 text-lg" style={{ color: "var(--on-ink-soft)" }}>
            ما يتطلّبه تفويض الهيئة فعلاً — شبكة Peppol وصيغة PINT AE وخطوة الإبلاغ — بلغة واضحة ومحدّثة.
          </p>
          <div className="mkt-mono mt-6 flex flex-wrap gap-x-5 gap-y-1 text-[11px]" style={{ color: "var(--on-ink-faint)" }}>
            {REGIME_FACTS.map((f) => (
              <span key={f.k.ar}>{f.k.ar}: <span style={{ color: "var(--on-ink-soft)" }}>{f.v.ar}</span></span>
            ))}
          </div>
        </div>
      </section>

      <section className="mkt-paper">
        <div className="mx-auto max-w-3xl px-5 py-14 lg:py-20">
          <article className="mkt-article">
            {SECTIONS.map((s) => (
              <section key={s.h} className="[&:not(:first-child)]:mt-10">
                <h2 className="mkt-display text-2xl font-bold sm:text-3xl">{s.h}</h2>
                <div className="mt-4 space-y-4 text-[15px] leading-relaxed" style={{ color: "var(--on-paper-soft)" }}>
                  {s.body.map((p, i) => <p key={i}>{p}</p>)}
                  {s.bullets && (
                    <ul className="mt-3 list-disc space-y-1.5 pe-5">
                      {s.bullets.map((b) => <li key={b}>{b}</li>)}
                    </ul>
                  )}
                </div>
              </section>
            ))}

            <div className="mt-10 rounded-2xl border p-6" style={{ borderColor: "var(--paper-line)", background: "#fff" }}>
              <p className="mkt-display text-xl font-bold">جاهزون عند بدء مرحلتك.</p>
              <p className="mkt-soft mt-1.5 text-sm">ابدأ مجاناً — أرسل فاتورة مطابقة إلى الهيئة اليوم.</p>
              <Link href="/signup" className="mkt-btn mkt-btn-dark mt-4">ابدأ تجربة 14 يوماً مجاناً <ArrowLeft className="size-4" /></Link>
            </div>
          </article>
        </div>
      </section>

      <section className="border-t" style={{ borderColor: "var(--ink-line)" }}>
        <div className="mx-auto max-w-3xl px-5 py-16 lg:py-20">
          <h2 className="mkt-display text-center text-3xl font-bold sm:text-4xl">أسئلة عن التفويض</h2>
          <div className="mt-10"><FaqList items={FAQ_AR} /></div>
        </div>
      </section>
    </>
  );
}
