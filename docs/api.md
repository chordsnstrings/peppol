# ARKS public API (v1)

A REST API for pushing invoices from your own systems. All `/api/v1/*` endpoints
authenticate with an **API key** — create one in **Settings → API** (the key is
shown once). Send it as a bearer token:

```
Authorization: Bearer arks_live_xxxxxxxxxxxxxxxxxxxxxxxx
```

Keys are scoped to one workspace (org). Only the SHA-256 hash is stored; a
revoked key stops working immediately.

## Endpoints

### `GET /api/v1/invoices`
List invoices. Query: `entityId`, `status` (e.g. `DRAFT`, `SENT`, `COMPLETED`).
→ `{ "invoices": [ … ] }`

### `GET /api/v1/invoices/:id`
Fetch one invoice. → `{ "invoice": { … } }`

### `POST /api/v1/invoices`
Create an invoice. Amounts are integer **minor units** (fils). Totals, VAT per
category, and doc type are computed server-side with the same engine as the app.

```json
{
  "entityId": "ent_…",
  "number": "INV-1042",
  "currency": "AED",
  "buyer": { "nameEn": "Buyer FZE", "trn": "100…", "peppolId": "0235:100…", "email": "ap@buyer.ae" },
  "lines": [
    { "description": "Consulting", "qty": 2, "unitPriceMinor": 50000, "taxProfileCode": "STANDARD_5" }
  ],
  "send": true
}
```

- `send: true` also runs the send pipeline (validate → PINT AE UBL + Tax Data
  Document → gateway → apply MLS). Omit it to create a DRAFT.
- Tax profile codes: `STANDARD_5`, `ZERO_EXPORT`, `ZERO_OTHER`, `EXEMPT`,
  `OUT_OF_SCOPE`, `REVERSE_CHARGE`, `DESIGNATED_ZONE`, `MARGIN_SCHEME`.
- → `201 { "invoice": { … }, "blocked"?: "NOT_ON_NETWORK" }`

### `POST /api/v1/invoices/:id/send`
Run the send pipeline for an existing invoice. → `{ "invoice": { … } }`

### `POST /api/v1/validate`
Validate a payload (same body as create) **without persisting**.
→ `{ "canSend": boolean, "issues": [ … ], "totals": { … }, "docType": "TAX_INVOICE" }`

## Errors
- `401` — missing / invalid / revoked key.
- `404` — entity or invoice not found (within your workspace).
- `422` — invoice has blocking validation issues (see `issues`).

## Billing / metering
Each successful transmission counts one billable exchange against the entity's
yearly allowance (`GET /api/usage?entityId=…`). MD 64 mandates 100 free
exchanges per entity per year — compliance never stops for a billing issue.
