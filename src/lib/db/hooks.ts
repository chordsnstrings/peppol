"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { all, byIndex, onChange, type StoreName } from "./database";

export interface QueryOptions<T> {
  index?: { name: string; value: string };
  filter?: (item: T) => boolean;
  sort?: (a: T, b: T) => number;
  deps?: unknown[];
}

/** Reactive collection query. Re-runs on store changes and dep changes. */
export function useCollection<T>(store: StoreName, options: QueryOptions<T> = {}) {
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const optRef = useRef(options);
  optRef.current = options;

  const run = useCallback(async () => {
    try {
      const opt = optRef.current;
      const rows = (opt.index
        ? await byIndex(store, opt.index.name, opt.index.value)
        : await all(store)) as unknown as T[];
      let out = rows;
      if (opt.filter) out = out.filter(opt.filter);
      if (opt.sort) out = [...out].sort(opt.sort);
      setData(out);
    } catch {
      setData([]);
    } finally {
      setLoading(false);
    }
  }, [store, optRef]);

  useEffect(() => {
    run();
    const off = onChange(store, run);
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, run, ...(options.deps ?? [])]);

  return { data, loading, refresh: run };
}

/** Reactive single record. */
export function useRecord<T extends { id: string }>(store: StoreName, id?: string) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const run = useCallback(async () => {
    if (!id) {
      setData(undefined);
      setLoading(false);
      return;
    }
    const rows = (await all(store)) as unknown as T[];
    setData(rows.find((r) => r.id === id));
    setLoading(false);
  }, [store, id]);

  useEffect(() => {
    run();
    const off = onChange(store, run);
    return off;
  }, [store, run]);

  return { data, loading, refresh: run };
}
