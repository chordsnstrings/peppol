# SME edge-case ledger

Tracks the edge cases raised for UAE SME adoption and how each is handled.
Status: ✅ done · 🟡 partial/scaffolded · 🔜 planned next · 🔒 needs [HUMAN]/infra.

| # | Edge case | Status | Where |
|---|-----------|--------|-------|
| 1 | Counterparty not on network (phased rollout) | ✅ | participant check endpoint, buyer readiness badges, queued-for-network state + fix-it + retry |
| 2 | No-undo · corrections · reject-after-report | ✅ | credit-note-from-invoice flow, fix-&-resend corrected copy, lock-after-send |
| 3 | Dirty counterparty data (missing/wrong TRN) | ✅ | TRN validation, per-customer network check, bulk check, editor buyer badge |
| 4 | Identity / TRN-ownership fraud | 🟡 | duplicate-TRN detection across orgs (fraud flag) + attestation; real verification 🔒 EmaraTax |
| 5 | We fail → they're fined · single-ASP risk | 🟡 | reconcile stuck sends, gateway health, gateway abstraction (swap ASP); SLA/insurance 🔒 |
| 6 | Data residency · portability · archive | 🟡 | evidence-bundle export, full account data export, retention metadata; UAE-region bucket 🔒 |
| 7 | Tax-treatment traps (RCM, export, exempt, DZ) | ✅ | tax advisories in editor + smarter validation warnings; official schematron 🔒 |
| 8 | Inbound / receiver surface | 🟡 | webhook inbound ingestion + MLS + inbox actions (accept/reject/export/dispute) |
| 9 | Invoice patterns (proforma, advance, recurring) | ✅ | proforma doc type (convert-to-tax-invoice, never transmitted) + recurring templates (cadence, auto-send, due-run, metered); advance/deposit via a proforma→tax-invoice workflow |
| 10 | Human/operational (Arabic RTL, offline, accountant) | 🔜 | full AR i18n, accountant consolidated views |
| 11 | Billing/metering (free-100, gaming, what's billable) | 🔜 | usage events, correct billable counting, allowance enforcement |
| 12 | Getting paid / AR (invoice ≠ cash) | ✅ | hosted pay links, `/payments` AR page (aging, DSO), reminders/dunning, mark-paid, part-payments; card rails 🟡 (assumed contracts) |
| 13 | Payment gateways (card, wallet) | 🟡 | `PaymentProviderPort` + Network International (N-Genius) + noqodi drivers behind mock; live keys 🔒 |
| 14 | Storefront sales (e-commerce) | 🟡 | Shopify + WooCommerce order → compliant invoice connectors behind mock; live app creds 🔒 |
| 15 | Customer delivery channel (WhatsApp) | 🟡 | per-tenant WhatsApp send of invoice + pay link via `WhatsAppPort`; Meta Cloud API driver behind mock, live token 🔒 |

🔒 **Needs the business/infra program (cannot be completed in code):** UAE-region
data residency, real TRN ownership verification (EmaraTax), ASP accreditation or a
signed Taxilla contract, official PINT AE schematron/XSD artefacts, insurance/SLA,
live gateway credentials (N-Genius / noqodi), Meta WhatsApp Business system-user
token, and Shopify/WooCommerce app credentials.
