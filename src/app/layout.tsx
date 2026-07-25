import type { Metadata, Viewport } from "next";
import { Inter, Sora, JetBrains_Mono, Bricolage_Grotesque } from "next/font/google";
import { Providers } from "@/components/providers";
import { SITE_URL } from "@/lib/site";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const sora = Sora({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
  weight: ["500", "600", "700"],
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

// Distinctive display face for the marketing surface (diverges from the app).
const marketing = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-marketing",
  display: "swap",
  weight: ["400", "500", "600", "700", "800"],
});

const APP_NAME = "ARKS e-Invoicing";
const APP_DESCRIPTION =
  "The fastest way to become UAE e-invoicing compliant. Create, validate and transmit PINT AE invoices to the FTA over Peppol — with delivery and reporting proven. Unlimited invoicing from AED 299/mo.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  applicationName: APP_NAME,
  title: {
    default: `${APP_NAME} — UAE FTA compliance, made effortless`,
    template: `%s · ${APP_NAME}`,
  },
  description: APP_DESCRIPTION,
  manifest: "/manifest.webmanifest",
  alternates: { canonical: "/" },
  keywords: [
    "UAE e-invoicing", "FTA e-invoicing", "Peppol UAE", "PINT AE", "e-invoicing UAE 2026",
    "MD 64", "tax invoice UAE", "e-invoice compliance", "ASP UAE", "electronic invoicing UAE",
  ],
  openGraph: {
    type: "website",
    siteName: APP_NAME,
    title: `${APP_NAME} — UAE FTA compliance, made effortless`,
    description: APP_DESCRIPTION,
    url: SITE_URL,
    locale: "en_AE",
  },
  twitter: {
    card: "summary_large_image",
    title: `${APP_NAME} — UAE FTA compliance, made effortless`,
    description: APP_DESCRIPTION,
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: APP_NAME,
  },
  formatDetection: { telephone: false },
  icons: {
    icon: [
      { url: "/icons/icon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "any" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png" }],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#0B1A2E" },
    { media: "(prefers-color-scheme: dark)", color: "#0A121E" },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} ${sora.variable} ${mono.variable} ${marketing.variable}`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
