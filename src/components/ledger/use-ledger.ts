"use client";

import * as React from "react";
import { useAppState } from "@/lib/app-state";

/** Every ledger read is entity-scoped; the API refuses a request without one. */
export function useEntityId(): string | undefined {
  const { currentEntity } = useAppState();
  return currentEntity?.id;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status}).`, res.status);
  return body;
}

/**
 * A read with the three states a ledger screen actually has: loading, an error
 * the user can act on, and data. No silent empty state that looks like "you
 * have no transactions" when the truth is "the request failed".
 */
export function useLedgerQuery<T>(
  path: string | null,
  /**
   * Anything else the read depends on. Joined into one string rather than
   * spread into the dependency array: React requires that array to be the same
   * length on every render, and a caller passing a list whose length varies
   * would break in a way that only shows up on the render where it changes.
   */
  deps: React.DependencyList = [],
): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(Boolean(path));
  const [nonce, setNonce] = React.useState(0);
  const depKey = deps.map((d) => String(d)).join("\u0000");

  React.useEffect(() => {
    if (!path) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<T>(path)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, depKey]);

  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}
