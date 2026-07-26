import { MarketingNav } from "@/components/marketing/nav";
import { MarketingFooter } from "@/components/marketing/footer";
import "../../styles/marketing.css";

// Each marketing page sets its OWN canonical (via metadata). We deliberately do
// NOT set a layout-level canonical here — a shared canonical:"/" would silently
// mis-canonicalize every child route to the homepage.

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mkt min-h-dvh" dir="ltr">
      <MarketingNav locale="en" />
      <main>{children}</main>
      <MarketingFooter locale="en" />
    </div>
  );
}
