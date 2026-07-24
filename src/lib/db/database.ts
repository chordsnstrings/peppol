"use client";

import type {
  AppNotification,
  Connection,
  Customer,
  Entity,
  FixitItem,
  InboundDoc,
  Invoice,
  InvoiceEvent,
  Member,
  Product,
  SyncLink,
} from "@/lib/domain/types";

/**
 * Client data layer. Talks to the tenant-scoped server API (`/api/store/*`,
 * `/api/meta`) — the browser no longer owns the data. The exported surface is
 * kept identical to the previous IndexedDB layer so repositories, hooks and
 * pages are unchanged.
 */

export type StoreName =
  | "entities"
  | "customers"
  | "products"
  | "invoices"
  | "invoiceEvents"
  | "connections"
  | "syncLinks"
  | "fixits"
  | "inbound"
  | "notifications"
  | "members"
  | "meta";

interface StoreValue {
  entities: Entity;
  customers: Customer;
  products: Product;
  invoices: Invoice;
  invoiceEvents: InvoiceEvent;
  connections: Connection;
  syncLinks: SyncLink;
  fixits: FixitItem;
  inbound: InboundDoc;
  notifications: AppNotification;
  members: Member;
  meta: { key: string; [k: string]: unknown };
}

/* ------------------------------------------------------------------ */
/* Fetch helper                                                        */
/* ------------------------------------------------------------------ */

async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "same-origin",
  });
  if (res.status === 401) {
    // Session expired — send them to sign in.
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      window.location.href = "/login";
    }
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

/* ------------------------------------------------------------------ */
/* Reactive change notifications                                       */
/* ------------------------------------------------------------------ */

type Listener = () => void;
const listeners = new Map<StoreName, Set<Listener>>();

export function onChange(store: StoreName, cb: Listener): () => void {
  if (!listeners.has(store)) listeners.set(store, new Set());
  listeners.get(store)!.add(cb);
  return () => listeners.get(store)?.delete(cb);
}

function emitChange(store: StoreName) {
  listeners.get(store)?.forEach((cb) => cb());
}

/** Notify subscribers that a store changed out-of-band (e.g. after a server-side mutation). */
export function touch(store: StoreName) {
  emitChange(store);
}

/* ------------------------------------------------------------------ */
/* CRUD (same signatures as the old IndexedDB layer)                   */
/* ------------------------------------------------------------------ */

export async function all<S extends StoreName>(store: S): Promise<StoreValue[S][]> {
  const { items } = await api<{ items: StoreValue[S][] }>(`/api/store/${store}`);
  return items;
}

export async function getById<S extends StoreName>(
  store: S,
  key: string,
): Promise<StoreValue[S] | undefined> {
  try {
    const { item } = await api<{ item: StoreValue[S] }>(`/api/store/${store}/${encodeURIComponent(key)}`);
    return item;
  } catch {
    return undefined;
  }
}

export async function put<S extends StoreName>(store: S, value: StoreValue[S]): Promise<StoreValue[S]> {
  await api(`/api/store/${store}`, { method: "POST", body: JSON.stringify(value) });
  emitChange(store);
  return value;
}

export async function bulkPut<S extends StoreName>(store: S, values: StoreValue[S][]): Promise<void> {
  for (const value of values) {
    await api(`/api/store/${store}`, { method: "POST", body: JSON.stringify(value) });
  }
  emitChange(store);
}

export async function remove(store: StoreName, key: string): Promise<void> {
  await api(`/api/store/${store}/${encodeURIComponent(key)}`, { method: "DELETE" });
  emitChange(store);
}

export async function byIndex<S extends StoreName>(
  store: S,
  index: string,
  value: string,
): Promise<StoreValue[S][]> {
  // orgId is implicit (tenant scope); only entityId / invoiceId narrow further.
  const qs =
    index === "entityId" || index === "invoiceId"
      ? `?${index}=${encodeURIComponent(value)}`
      : "";
  const { items } = await api<{ items: StoreValue[S][] }>(`/api/store/${store}${qs}`);
  return items;
}

/* ------------------------------------------------------------------ */
/* Per-user meta                                                       */
/* ------------------------------------------------------------------ */

export async function metaGet<T = unknown>(key: string): Promise<T | undefined> {
  const { value } = await api<{ value: T | undefined }>(`/api/meta?key=${encodeURIComponent(key)}`);
  return value;
}

export async function metaSet(key: string, value: unknown): Promise<void> {
  await api(`/api/meta`, { method: "PUT", body: JSON.stringify({ key, value }) });
  emitChange("meta");
}

export async function resetWorkspace(): Promise<void> {
  await api(`/api/account/reset`, { method: "POST" });
  (
    [
      "entities",
      "customers",
      "products",
      "invoices",
      "invoiceEvents",
      "connections",
      "fixits",
      "inbound",
      "notifications",
      "members",
      "meta",
    ] as StoreName[]
  ).forEach(emitChange);
}
