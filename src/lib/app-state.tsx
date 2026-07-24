"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { all, metaGet, metaSet, onChange } from "@/lib/db/database";
import type { Entity, Locale, Organization } from "@/lib/domain/types";

interface AppStateValue {
  ready: boolean;
  onboarded: boolean;
  org?: Organization;
  entities: Entity[];
  currentEntity?: Entity;
  locale: Locale;
  setCurrentEntityId: (idv: string) => Promise<void>;
  setLocale: (l: Locale) => Promise<void>;
  refresh: () => Promise<void>;
}

const AppStateContext = createContext<AppStateValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [org, setOrg] = useState<Organization | undefined>();
  const [entities, setEntities] = useState<Entity[]>([]);
  const [currentEntityId, setCurrentEntityIdState] = useState<string | undefined>();
  const [locale, setLocaleState] = useState<Locale>("en");

  const load = useCallback(async () => {
    try {
      const [orgs, ents, curId, loc] = await Promise.all([
        all("organizations"),
        all("entities"),
        metaGet<string>("currentEntityId"),
        metaGet<Locale>("locale"),
      ]);
      setOrg(orgs[0]);
      setEntities(ents);
      const validId = ents.find((e) => e.id === curId)?.id ?? ents[0]?.id;
      setCurrentEntityIdState(validId);
      if (loc) setLocaleState(loc);
    } catch {
      /* fresh workspace */
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    load();
    const offEnt = onChange("entities", load);
    const offOrg = onChange("organizations", load);
    return () => {
      offEnt();
      offOrg();
    };
  }, [load]);

  // keep dir + lang on <html>
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";
  }, [locale]);

  const setCurrentEntityId = useCallback(async (idv: string) => {
    setCurrentEntityIdState(idv);
    await metaSet("currentEntityId", idv);
  }, []);

  const setLocale = useCallback(async (l: Locale) => {
    setLocaleState(l);
    await metaSet("locale", l);
  }, []);

  const currentEntity = useMemo(
    () => entities.find((e) => e.id === currentEntityId),
    [entities, currentEntityId],
  );

  const value: AppStateValue = {
    ready,
    onboarded: entities.length > 0 && Boolean(org),
    org,
    entities,
    currentEntity,
    locale,
    setCurrentEntityId,
    setLocale,
    refresh: load,
  };

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState() {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useAppState must be used within AppStateProvider");
  return ctx;
}
