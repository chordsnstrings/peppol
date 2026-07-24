# Taxilla partner gateway — ASSUMED REST contract

Taxilla (Route A ASP) does not publish concrete endpoints publicly. Per the build
spec (§5.6), we implement `src/lib/gateway/taxilla-gateway.ts` against this
**assumed** contract so that dropping in the real API is a **one-file** change.
When the real Taxilla docs/credentials arrive, reconcile the endpoint paths,
field names, and status values below — nothing above `PeppolGatewayPort` changes.

> Status: **ASSUMED / placeholder.** Replace with Taxilla's real contract on
> sign-up. Tracked in `OPEN-QUESTIONS.md`.

## Auth
- `Authorization: Bearer <TAXILLA_API_KEY>` + `X-Client-Id: <TAXILLA_CLIENT_ID>`.
  (If Taxilla uses OAuth2 client-credentials instead, add a token-exchange step in
  `headers()` — localized to the adapter.)

## Base URL
- `TAXILLA_BASE_URL`, e.g. `https://api.taxilla.com/einvoice/ae`.

## Endpoints

### `GET /v1/participants/{participantId}` — SMP lookup
Response: `{ "registered": true, "documentTypes": ["PINT_AE_INVOICE", ...] }`

### `POST /v1/documents` — submit (exchange + reporting)
Request:
```json
{
  "idempotencyKey": "send:<invoiceId>",
  "sender": "0235:1001234567",
  "receiver": "0235:1009998887",
  "documentTypeId": "urn:…::Invoice##urn:peppol:pint:billing-1@ae-1::2.1",
  "processId": "urn:peppol:bis:billing",
  "payload": "<base64 PINT AE UBL>",
  "payloadFormat": "UBL",
  "reporting": { "taxDataDocument": "<base64 TDD>" }
}
```
Response: `{ "reference": "TXL-…", "status": "PENDING" }`

### `GET /v1/documents/{reference}` — status (reconciliation)
Response:
```json
{
  "reference": "TXL-…",
  "exchange": { "status": "DELIVERED", "code": null, "reasons": [] },
  "reporting": {
    "c2": { "status": "ACCEPTED", "code": null, "reasons": [] },
    "c3": { "status": "ACCEPTED" }
  }
}
```
Status values normalized in the adapter: `ACCEPTED|DELIVERED|SUCCESS|REPORTED` →
ACCEPTED; `REJECTED|FAILED|ERROR` → REJECTED.

### `POST` webhook → `/api/gateway/webhook`
Taxilla POSTs the same status shape as above on each MLS. We verify
`X-Taxilla-Signature: <hex HMAC-SHA256(body, TAXILLA_WEBHOOK_SECRET)>` before
applying. Configure this callback URL + secret in the Taxilla console.

### `GET /v1/health`
Response: `200` when the gateway is reachable.

## Switch to live
Set in the environment:
```
GATEWAY_DRIVER=taxilla
TAXILLA_BASE_URL=…
TAXILLA_API_KEY=…
TAXILLA_CLIENT_ID=…
TAXILLA_WEBHOOK_SECRET=…
```
No code change is required to flip from the mock gateway to Taxilla.
