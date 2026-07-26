import { MarketingNav } from "@/components/marketing/nav";
import { MarketingFooter } from "@/components/marketing/footer";
import "../../styles/marketing.css";

/**
 * Arabic marketing subtree — RTL, its own shell so it never double-wraps under the
 * English (marketing) layout. lang/dir are set on the container (the shared root
 * <html> stays en); Google reads content language from the copy + hreflang.
 */
export default function ArMarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mkt min-h-dvh" dir="rtl" lang="ar">
      <MarketingNav locale="ar" />
      <main>{children}</main>
      <MarketingFooter locale="ar" />
    </div>
  );
}
