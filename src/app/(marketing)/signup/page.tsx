import type { Metadata } from "next";
import { SignupForm } from "@/components/marketing/signup-form";

export const metadata: Metadata = {
  title: "Start your free trial — 14 days, no card",
  description:
    "Create your ARKS workspace and start a 14-day free trial with full FTA transmission — no credit card required. Unlimited UAE e-invoicing from AED 299/month.",
  alternates: { canonical: "/signup" },
};

export default function SignupPage() {
  return <SignupForm />;
}
