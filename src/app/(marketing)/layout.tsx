import type { Metadata } from "next";
import { MarketingNav } from "@/components/marketing/nav";
import { MarketingFooter } from "@/components/marketing/footer";
import "./marketing.css";

export const metadata: Metadata = {
  // Marketing pages are statically rendered for SEO/CWV.
  alternates: { canonical: "/" },
};

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mkt min-h-dvh">
      <MarketingNav />
      <main>{children}</main>
      <MarketingFooter />
    </div>
  );
}
