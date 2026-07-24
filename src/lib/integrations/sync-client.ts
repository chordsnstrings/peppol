"use client";

import { id as makeId } from "@/lib/utils";
import { all, put } from "@/lib/db/database";
import { makeDraft, persistInvoice, saveCustomer } from "@/lib/db/repo";
import { cleanTaxId, derivePeppolId } from "@/lib/domain/peppol";
import type { Connection, Customer, Entity, InvoiceLine, SyncLink, TaxProfileCode } from "@/lib/domain/types";
import type { ExternalCustomer, ExternalInvoice } from "./port";

function rateToProfile(rate: number): TaxProfileCode {
  if (rate >= 5) return "STANDARD_5";
  if (rate === 0) return "ZERO_OTHER";
  return "STANDARD_5";
}

async function upsertCustomer(entity: Entity, ext: ExternalCustomer): Promise<Customer> {
  const existing = (await all("customers")).filter((c) => c.entityId === entity.id);
  const trn = ext.trn ? cleanTaxId(ext.trn) : undefined;
  const match = existing.find(
    (c) =>
      (trn && c.trn === trn) || c.displayName.toLowerCase() === ext.name.toLowerCase(),
  );
  if (match) return match;

  const now = new Date().toISOString();
  const customer: Customer = {
    id: makeId("cus"),
    orgId: entity.orgId,
    entityId: entity.id,
    displayName: ext.name,
    trn,
    peppolId: trn ? derivePeppolId(trn) : undefined,
    participantStatus: trn ? "LOOKUP_OK" : "UNKNOWN",
    emails: ext.email ? [ext.email] : undefined,
    defaultCurrency: "AED",
    createdAt: now,
    updatedAt: now,
  };
  await saveCustomer(customer);
  return customer;
}

export interface SyncOutcome {
  imported: number;
  updated: number;
  skipped: number;
  mode: "live" | "mock";
}

/** Pull from the provider and map results into the tenant store (idempotent). */
export async function syncConnection(
  entity: Entity,
  connection: Connection,
  slug: string,
): Promise<SyncOutcome> {
  const res = await fetch(`/api/integrations/${slug}/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connectionId: connection.id }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Sync failed");
  }
  const { mode, invoices } = (await res.json()) as {
    mode: "live" | "mock";
    invoices: ExternalInvoice[];
  };

  const links = (await all("syncLinks")).filter((l) => l.connectionId === connection.id);
  const seen = new Map(links.map((l) => [l.externalId, l]));

  let imported = 0;
  let updated = 0;
  let skipped = 0;

  for (const ext of invoices) {
    const link = seen.get(ext.externalId);
    if (link && link.hash === ext.hash) {
      skipped++;
      continue;
    }
    const customer = await upsertCustomer(entity, ext.customer);

    const draft = makeDraft(entity, { number: ext.number });
    if (link) draft.id = link.internalId; // update in place
    draft.source = "INTEGRATION";
    draft.currency = ext.currency;
    draft.issueDate = ext.date;
    draft.supplyDate = ext.date;
    draft.buyer = { nameEn: customer.displayName, trn: customer.trn, peppolId: customer.peppolId };
    draft.customerId = customer.id;
    draft.lines = ext.lines.map((l, i): InvoiceLine => ({
      id: makeId("ln"),
      lineNo: i + 1,
      description: l.description,
      qty: l.qty,
      unitCode: "C62",
      unitPriceMinor: l.unitPriceMinor,
      taxProfileCode: rateToProfile(l.taxRatePercent),
      lineNetMinor: 0,
      lineVatMinor: 0,
    }));

    const saved = await persistInvoice(draft);

    const newLink: SyncLink = {
      id: `${connection.id}:${ext.externalId}`,
      orgId: entity.orgId,
      entityId: entity.id,
      connectionId: connection.id,
      provider: connection.provider,
      objectType: "INVOICE",
      externalId: ext.externalId,
      internalId: saved.id,
      hash: ext.hash,
      createdAt: new Date().toISOString(),
    };
    await put("syncLinks", newLink);

    if (link) updated++;
    else imported++;
  }

  await put("connections", {
    ...connection,
    status: "CONNECTED",
    mode,
    lastSyncAt: new Date().toISOString(),
    syncedCount: (connection.syncedCount ?? 0) + imported,
    updatedAt: new Date().toISOString(),
  });

  return { imported, updated, skipped, mode };
}
