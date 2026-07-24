# ARKS e-Invoicing — Web UI

A beautiful, fully responsive, PWA-ready front-end for the **ARKS UAE e-Invoicing platform**
(per `ARKS-EINV-BUILD-SPEC`). It lets any UAE business create compliant invoices, import them from
spreadsheets, validate against the rules, and transmit + report them across the Peppol 5-corner
network — with compliance on autopilot.

This is a **genuinely functional, multi-tenant application**, not a mock-up. Any company can
register and gets an **isolated workspace** — data is persisted server-side (Prisma) and every query
is scoped to the signed-in organization. There is **no seed/fake data**: everything is created
through real flows, and all money/tax math, validation, Peppol-ID derivation, numbering and the
invoice lifecycle are computed by real deterministic code.

## Multi-tenancy & auth

- **Registration/login** (email + password, scrypt-hashed) with a signed httpOnly JWT session.
- `User → Organization (tenant) → Membership`; every `/api/store/*` query is forced to the
  session's `orgId`. Cross-tenant reads return 404 and cross-tenant writes 403.
- Domain objects persist as tenant-scoped JSON documents in a single `Record` table, so the whole
  client keeps its object-store shape while gaining server persistence + isolation.
- Dev runs on **SQLite** in-container; production swaps to managed **Postgres** (connection string).

## Accounting integrations (per tenant)

- An `AccountingProviderPort` (§8.5) with a **Zoho Books** adapter (real OAuth2 + Books API) and a
  credential-free **mock driver**, selected by whether provider credentials are configured.
- Server route handlers do the OAuth secret-exchange + API proxy (`/api/integrations/[provider]/{authorize,callback,sync,disconnect}`);
  tokens are **AES-256-GCM encrypted at rest**, keyed by `orgId:connectionId` so every client's
  integration is fully separate.
- Synced invoices are mapped into the tenant store on the client (idempotent via `SyncLink`), so one
  provider record never imports twice.

## Highlights

- **Compliance autopilot** — you state the business facts; the app derives the doc type
  (tax / credit / commercial invoice), VAT per category (EN 16931-style, integer minor units,
  HALF_UP rounding), the 14-day clock and the Peppol participant ID (`0235:` + first 10 TRN digits).
- **AI-assisted spreadsheet importer** — drop a real `.xlsx`/`.csv`, columns auto-map (recognises
  Tally / Zoho / QBO headers), every row runs the validation engine, and valid rows become real drafts.
- **Real artifacts** — export a genuine PINT-AE-shaped **UBL XML** or a print-to-PDF invoice, and a
  CSV invoice register / VAT summary — all generated from your data.
- **Fix-it queue** — a live, derived inbox of everything blocking compliance, each with a one-click fix.
- **Bilingual-ready** — EN/AR with RTL layout support; logical CSS properties throughout.

## Design & UX

- **Aesthetic system**: navy `#0B1A2E` + gold `#C9A84C` brand, refined light/dark themes, a persistent
  navy sidebar as a brand signature, generous spacing, tabular figures for money.
- **Micro-animations everywhere** (Framer Motion): page transitions, staggered lists, animated
  counters & meters, spring modals/sheets, layout-animated tabs & nav indicators, skeleton shimmer,
  theme-morph toggle, confetti on activation.
- **Fully responsive**: fixed sidebar → collapsible → mobile drawer + bottom tab bar; tables collapse
  to cards; the editor and review grid adapt down to phones; safe-area insets respected.
- **PWA**: installable with a web manifest, maskable icons, app shortcuts, an offline-first service
  worker (app-shell precache + offline fallback), and theme-color meta.
- **Accessible**: keyboard paths, focus rings, `aria` roles on dialogs/menus/switches, reduced-motion
  support, and WCAG-minded contrast.
- **Command palette** (⌘K) with real search over navigation, invoices and customers.

## Tech stack

Next.js 15 (App Router) · React 18 · TypeScript (strict) · Tailwind CSS · Framer Motion ·
IndexedDB (`idb`) · SheetJS (`xlsx`, loaded on demand) · cmdk · sonner · lucide-react.

## Getting started

```bash
npm install
npm run dev      # http://localhost:3000
npm run build && npm run start
```

On first load you'll be guided through onboarding, which creates your organization and first entity.

## Project structure

```
src/
├── app/
│   ├── (app)/            # authenticated shell: dashboard, invoices, uploads, customers,
│   │   │                 # products, integrations, inbox, reports, fix-it, settings
│   │   └── layout.tsx    # AppShell (sidebar + topbar + mobile nav + command palette)
│   ├── onboarding/       # resumable setup wizard (creates org + entity for real)
│   ├── layout.tsx        # fonts, PWA metadata, providers
│   └── globals.css       # design tokens (light/dark), utilities, print styles
├── components/
│   ├── ui/               # button, card, badge, input, select, modal/sheet, dropdown,
│   │   │                 # tabs, pagination, progress/ring, stat, tooltip, empty-state…
│   ├── shell/            # sidebar, topbar, entity switcher, notifications, command palette…
│   ├── invoice/          # preview, status, customer picker
│   ├── charts/           # dependency-free animated SVG charts
│   └── motion/           # reveal/stagger, animated number
├── lib/
│   ├── domain/           # money, tax, validation, status machine, Peppol, UBL, types
│   ├── db/               # IndexedDB layer, repository, reactive hooks
│   ├── ingest.ts         # real CSV/XLSX parsing + column mapping + row→invoice
│   └── app-state.tsx     # current org/entity/locale context
└── public/               # manifest, service worker, icons, offline page
```

> Note: this is the presentation layer. Network transmission runs in **sandbox** (the real status
> machine, end-to-end) — swapping in a live Peppol gateway is a backend concern behind the same
> status model. No amount, tax value, TRN or document type ever originates from an LLM.
