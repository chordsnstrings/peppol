"use client";

import { useMemo } from "react";
import { useAppState } from "@/lib/app-state";
import { useCollection } from "@/lib/db/hooks";
import { deriveFixits } from "@/lib/fixit";
import type {
  Customer,
  InboundDoc,
  Invoice,
  Product,
} from "@/lib/domain/types";

/** All invoices for the current entity, newest first. */
export function useInvoices(filter?: (i: Invoice) => boolean) {
  const { currentEntity } = useAppState();
  const { data, loading } = useCollection<Invoice>("invoices", {
    index: currentEntity ? { name: "entityId", value: currentEntity.id } : undefined,
    filter,
    sort: (a, b) => b.createdAt.localeCompare(a.createdAt),
    deps: [currentEntity?.id],
  });
  return { invoices: data, loading };
}

export function useCustomers() {
  const { currentEntity } = useAppState();
  const { data, loading } = useCollection<Customer>("customers", {
    index: currentEntity ? { name: "entityId", value: currentEntity.id } : undefined,
    sort: (a, b) => a.displayName.localeCompare(b.displayName),
    deps: [currentEntity?.id],
  });
  return { customers: data, loading };
}

export function useProducts() {
  const { currentEntity } = useAppState();
  const { data, loading } = useCollection<Product>("products", {
    index: currentEntity ? { name: "entityId", value: currentEntity.id } : undefined,
    sort: (a, b) => a.nameEn.localeCompare(b.nameEn),
    deps: [currentEntity?.id],
  });
  return { products: data, loading };
}

export function useInbound() {
  const { currentEntity } = useAppState();
  const { data, loading } = useCollection<InboundDoc>("inbound", {
    index: currentEntity ? { name: "entityId", value: currentEntity.id } : undefined,
    sort: (a, b) => b.receivedAt.localeCompare(a.receivedAt),
    deps: [currentEntity?.id],
  });
  return { inbound: data, loading };
}

/** Live badge counts for the shell. */
export function useBadgeCounts() {
  const { invoices } = useInvoices();
  const { inbound } = useInbound();
  return useMemo(() => {
    const fixits = deriveFixits(invoices);
    return {
      fixit: fixits.filter((f) => f.status === "OPEN").length,
      inbox: inbound.filter((d) => d.buyerAction === "NONE").length,
    };
  }, [invoices, inbound]);
}
