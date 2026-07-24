import { openDB, type DBSchema, type IDBPDatabase } from "idb";
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
  Organization,
  Product,
} from "@/lib/domain/types";

export type StoreName =
  | "organizations"
  | "entities"
  | "customers"
  | "products"
  | "invoices"
  | "invoiceEvents"
  | "connections"
  | "fixits"
  | "inbound"
  | "notifications"
  | "members"
  | "meta";

interface ArksDB extends DBSchema {
  organizations: { key: string; value: Organization };
  entities: { key: string; value: Entity; indexes: { orgId: string } };
  customers: { key: string; value: Customer; indexes: { entityId: string } };
  products: { key: string; value: Product; indexes: { entityId: string } };
  invoices: {
    key: string;
    value: Invoice;
    indexes: { entityId: string; direction: string; status: string };
  };
  invoiceEvents: { key: string; value: InvoiceEvent; indexes: { invoiceId: string } };
  connections: { key: string; value: Connection; indexes: { entityId: string } };
  fixits: { key: string; value: FixitItem; indexes: { entityId: string; status: string } };
  inbound: { key: string; value: InboundDoc; indexes: { entityId: string } };
  notifications: { key: string; value: AppNotification; indexes: { orgId: string } };
  members: { key: string; value: Member; indexes: { orgId: string } };
  meta: { key: string; value: { key: string; [k: string]: unknown } };
}

const DB_NAME = "arks-einvoicing";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<ArksDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<ArksDB>> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("IndexedDB is only available in the browser"));
  }
  if (!dbPromise) {
    dbPromise = openDB<ArksDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore("organizations", { keyPath: "id" });

        const entities = db.createObjectStore("entities", { keyPath: "id" });
        entities.createIndex("orgId", "orgId");

        const customers = db.createObjectStore("customers", { keyPath: "id" });
        customers.createIndex("entityId", "entityId");

        const products = db.createObjectStore("products", { keyPath: "id" });
        products.createIndex("entityId", "entityId");

        const invoices = db.createObjectStore("invoices", { keyPath: "id" });
        invoices.createIndex("entityId", "entityId");
        invoices.createIndex("direction", "direction");
        invoices.createIndex("status", "lifecycleStatus");

        const events = db.createObjectStore("invoiceEvents", { keyPath: "id" });
        events.createIndex("invoiceId", "invoiceId");

        const connections = db.createObjectStore("connections", { keyPath: "id" });
        connections.createIndex("entityId", "entityId");

        const fixits = db.createObjectStore("fixits", { keyPath: "id" });
        fixits.createIndex("entityId", "entityId");
        fixits.createIndex("status", "status");

        const inbound = db.createObjectStore("inbound", { keyPath: "id" });
        inbound.createIndex("entityId", "entityId");

        const notifications = db.createObjectStore("notifications", { keyPath: "id" });
        notifications.createIndex("orgId", "orgId");

        const members = db.createObjectStore("members", { keyPath: "id" });
        members.createIndex("orgId", "orgId");

        db.createObjectStore("meta", { keyPath: "key" });
      },
    });
  }
  return dbPromise;
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

/* ------------------------------------------------------------------ */
/* Generic CRUD                                                        */
/* ------------------------------------------------------------------ */

type ValueOf<S extends StoreName> = ArksDB[S]["value"];

export async function all<S extends StoreName>(store: S): Promise<ValueOf<S>[]> {
  const db = await getDB();
  return db.getAll(store) as Promise<ValueOf<S>[]>;
}

export async function getById<S extends StoreName>(
  store: S,
  key: string,
): Promise<ValueOf<S> | undefined> {
  const db = await getDB();
  return db.get(store, key) as Promise<ValueOf<S> | undefined>;
}

export async function put<S extends StoreName>(store: S, value: ValueOf<S>): Promise<ValueOf<S>> {
  const db = await getDB();
  await db.put(store, value as never);
  emitChange(store);
  return value;
}

export async function bulkPut<S extends StoreName>(store: S, values: ValueOf<S>[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(store, "readwrite");
  await Promise.all([...values.map((v) => tx.store.put(v as never)), tx.done]);
  emitChange(store);
}

export async function remove(store: StoreName, key: string): Promise<void> {
  const db = await getDB();
  await db.delete(store, key);
  emitChange(store);
}

export async function byIndex<S extends StoreName>(
  store: S,
  index: string,
  value: string,
): Promise<ValueOf<S>[]> {
  const db = await getDB();
  return db.getAllFromIndex(store, index as never, value as never) as Promise<ValueOf<S>[]>;
}

export async function metaGet<T = unknown>(key: string): Promise<T | undefined> {
  const db = await getDB();
  const row = await db.get("meta", key);
  return row?.value as T | undefined;
}

export async function metaSet(key: string, value: unknown): Promise<void> {
  const db = await getDB();
  await db.put("meta", { key, value } as never);
  emitChange("meta");
}

/** Wipe everything (used by "reset workspace" in settings). */
export async function resetWorkspace(): Promise<void> {
  const db = await getDB();
  const stores: StoreName[] = [
    "organizations",
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
  ];
  const tx = db.transaction(stores, "readwrite");
  await Promise.all([...stores.map((s) => tx.objectStore(s).clear()), tx.done]);
  stores.forEach(emitChange);
}
