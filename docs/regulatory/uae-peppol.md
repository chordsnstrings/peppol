# UAE e-Invoicing — Peppol / FTA integration (research notes)

_Last researched: July 2026. Values marked `[VERIFY-LATEST]` must be re-confirmed
against the official MoF/FTA sources before production go-live._

## Model
The UAE uses the **Decentralised Continuous Transaction Control & Exchange
(DCTCE)** model — the Peppol-based **5-corner model**:

- **C1** Supplier → **C2** Supplier's Accredited Service Provider (ASP) → **C3**
  Buyer's ASP → **C4** Buyer, with **C5 = the Federal Tax Authority (FTA)** as a
  central reporting/monitoring node.
- Both **C2 and C3 independently report** a **Tax Data Document (TDD)** to the FTA
  (dual-verification). Reporting is **near-real-time**, in parallel with delivery
  (not pre-clearance).

## Format
- Invoices/credit notes MUST be **PINT AE** structured XML (UBL 2.1). **PDF/Excel
  do not qualify.** Current published spec at research date: PINT AE **v1.0.x**,
  UAE TDD **v1.0.0** `[VERIFY-LATEST]`.
- **Peppol participant ID**: scheme `0235` + first 10 digits of the TRN/TIN →
  `0235:XXXXXXXXXX` `[VERIFY-LATEST]`.
- Records must be **stored in the UAE** for the statutory retention period
  (REG-02).

## Timeline (as researched, July 2026) `[VERIFY-LATEST]`
- Businesses with revenue **≥ AED 50M** must **appoint an ASP by 30 Oct 2026**
  (extended from 31 Jul 2026); smaller businesses + government by **31 Mar 2027**.
- Go-live: large **1 Jan 2027**, smaller **1 Jul 2027**, government **1 Oct 2027**.

## What "going live" requires
1. An **accredited ASP** to reach the network + FTA. Two routes (spec §1.2):
   - **Route A (partner):** use an accredited ASP's API — **we are wiring Taxilla**
     (a pre-approved UAE provider with an "API as a Service"; see
     `docs/partner-contract.md`). Fastest path.
   - **Route B (own accreditation):** own AS4 Access Point + OpenPeppol
     conformance + ISO 27001/22301 + insurance. Business/legal program.
2. **Official validation artefacts** — the real PINT AE **schematron** + UBL XSDs
   (our validator is the plain-language layer and must be backed by these).
3. **TDD + MLS** handling on both legs (built here; see `src/lib/gateway`).
4. **EmaraTax** ASP designation per taxpayer.
5. **UAE-region immutable archive** for the statutory period.

## How this app maps to the model
- `PeppolGatewayPort` (`src/lib/gateway/port.ts`) is the single seam over the
  network + FTA. Drivers: `mock` (default, credential-free), `taxilla` (Route A).
- The send pipeline (`/api/invoices/[id]/send`) generates the **PINT AE UBL**
  (`src/lib/domain/ubl.ts`) + the **TDD** (`src/lib/gateway/tdd.ts`), submits both
  legs via the port, records a `Transmission`, and applies MLS to the invoice's
  two status dimensions (exchange + C2 reporting).
- Live MLS/status arrives at `/api/gateway/webhook` and is routed back to the
  owning tenant/invoice via the `Transmission.gatewayRef`.

## Sources
- FTA / MoF e-invoicing programme overviews (ClearTax, Basware, Comarch, Cygnet,
  RTC, Corporate Tax UAE) — timeline, 5-corner model, TDD dual reporting.
- Taxilla — UAE e-invoicing mandate guide + "API as a Service" (pre-approved ASP).
