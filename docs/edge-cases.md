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
| 9 | Invoice patterns (proforma, advance, recurring) | 🔜 | proforma doc type, deposit/advance, recurring templates |
| 10 | Human/operational (Arabic RTL, offline, accountant) | 🔜 | full AR i18n, accountant consolidated views |
| 11 | Billing/metering (free-100, gaming, what's billable) | 🔜 | usage events, correct billable counting, allowance enforcement |

🔒 **Needs the business/infra program (cannot be completed in code):** UAE-region
data residency, real TRN ownership verification (EmaraTax), ASP accreditation or a
signed Taxilla contract, official PINT AE schematron/XSD artefacts, insurance/SLA.
