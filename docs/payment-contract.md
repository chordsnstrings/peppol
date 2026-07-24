# Payment gateways — ASSUMED contracts (Network International & noqodi)

We collect on invoices through a provider-agnostic `PaymentProviderPort`
(`src/lib/payments/port.ts`). Three drivers implement it:

- **`mock`** (default) — a self-hosted sandbox checkout at `/pay/<token>`. Runs
  credential-free so the whole collect → pay → mark-paid loop works today.
- **`network`** — Network International **N-Genius Online** hosted payment page.
- **`noqodi`** — noqodi hosted checkout.

Neither N-Genius nor noqodi credentials are in hand yet, so the two live drivers
are written against the **assumed** REST contracts below. When the real API keys
and docs arrive, reconcile endpoint paths / field names here — nothing above
`PaymentProviderPort` (routes, `/pay` page, AR page, webhooks) changes.

> Status: **ASSUMED / placeholder** for the field names marked below. The
> N-Genius flow mirrors Network International's published N-Genius Online docs;
> noqodi's shape is inferred from a standard hosted-checkout + HMAC webhook
> pattern. Replace on sign-up. Tracked in `OPEN-QUESTIONS.md`.

## Port surface

```ts
createPaymentLink(req): { paymentUrl, providerRef }   // hosted page URL to send the buyer to
getStatus(providerRef): PaymentEvent | null           // poll fallback
parseWebhook(headers, rawBody): PaymentEvent[]         // async settlement
healthcheck(): { ok, detail }
```

`PaymentEvent.status` ∈ `PAID | FAILED | PENDING | REFUNDED | EXPIRED`. A `PAID`
event is applied to the invoice by `applyPaymentToInvoice()` (AR status, timeline
event, notification). Amounts are integer **minor units**.

---

## Network International — N-Genius Online

Env: `NETWORK_API_BASE` (default `https://api-gateway.ngenius-payments.com`),
`NETWORK_API_KEY` (service-account key, base64), `NETWORK_OUTLET_REF`.

### Auth — `POST /identity/auth/access-token`
- Header `Authorization: Basic <NETWORK_API_KEY>`, content-type
  `application/vnd.ni-identity.v1+json`.
- Response: `{ "access_token": "…", "expires_in": 3600 }`. Bearer for all order calls.

### Create order — `POST /transactions/outlets/{outlet}/orders`
Request:
```json
{
  "action": "SALE",
  "amount": { "currencyCode": "AED", "value": 105000 },
  "emailAddress": "buyer@example.com",
  "merchantOrderReference": "INV-1042",
  "merchantAttributes": { "redirectUrl": "<origin>/pay/<token>?done=1", "skipConfirmationPage": true }
}
```
Response: `{ "reference": "…", "_links": { "payment": { "href": "https://…/pay/…" } } }`.
We redirect the buyer to `_links.payment.href`.

### Fetch order — `GET /transactions/outlets/{outlet}/orders/{reference}`
`_embedded.payment[0].state` ∈ `CAPTURED | PURCHASED | FAILED | DECLINED | …`.

### Webhook → `POST /api/payments/webhook`
Body `{ "order": { "reference", "amount": { "value" } }, "state": "CAPTURED" }`.
State mapping: `CAPTURED|PURCHASED|PAID → PAID`, `FAILED|DECLINED → FAILED`,
`REFUNDED → REFUNDED`, `EXPIRED → EXPIRED`, else `PENDING`.

**[HUMAN]** confirm on sign-up: exact minor-unit convention (N-Genius uses
minor units for AED), webhook signature header + secret, and whether the
outlet is single- or multi-currency.

---

## noqodi — hosted checkout

Env: `NOQODI_API_BASE` (default `https://api.noqodi.com`), `NOQODI_API_KEY`,
`NOQODI_MERCHANT_ID`, `NOQODI_WEBHOOK_SECRET`.

### Create checkout — `POST /api/v1/checkout`
- Header `Authorization: Bearer <NOQODI_API_KEY>`.
- Request:
```json
{
  "merchantId": "<NOQODI_MERCHANT_ID>",
  "reference": "INV-1042",
  "amount": 1050.00,
  "currency": "AED",
  "description": "Invoice INV-1042",
  "customer": { "name": "…", "email": "…" },
  "returnUrl": "<origin>/pay/<token>?done=1",
  "callbackUrl": "<origin>/api/payments/webhook"
}
```
- Response: `{ "checkoutId": "…", "paymentUrl": "https://pay.noqodi.com/…" }`.

### Webhook → `POST /api/payments/webhook`
- Signature: `X-Noqodi-Signature: <hex HMAC-SHA256(rawBody, NOQODI_WEBHOOK_SECRET)>`.
  We verify with a constant-time compare before trusting the body.
- Body `{ "reference", "status": "PAID|FAILED|EXPIRED", "amount", "transactionId" }`.

**[HUMAN]** confirm on sign-up: whether amounts are major (decimal) or minor
units, the exact signature header name + algorithm, and the status vocabulary.

---

## WhatsApp is not a payment gateway

WhatsApp (`src/lib/whatsapp/`) is a **delivery channel**, not a collector: it
sends the invoice plus the hosted pay link created by whichever payment driver is
active. See `docs/edge-cases.md` for the AR/dunning flow.
