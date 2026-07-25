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

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

interface AppStateValue {
  ready: boolean;
  authenticated: boolean;
  onboarded: boolean;
  user?: SessionUser;
  org?: Organization;
  impersonating?: { orgId: string; orgName: string } | null;
  entities: Entity[];
  currentEntity?: Entity;
  locale: Locale;
  setCurrentEntityId: (id: string) => Promise<void>;
  setLocale: (l: Locale) => Promise<void>;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AppStateContext = createContext<AppStateValue | null>(null);

interface MeResponse {
  user: SessionUser;
  org: Organization;
  impersonating?: { orgId: string; orgName: string } | null;
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [user, setUser] = useState<SessionUser | undefined>();
  const [org, setOrg] = useState<Organization | undefined>();
  const [impersonating, setImpersonating] = useState<{ orgId: string; orgName: string } | null>(null);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [currentEntityId, setCurrentEntityIdState] = useState<string | undefined>();
  const [locale, setLocaleState] = useState<Locale>("en");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { credentials: "same-origin" });
      if (!res.ok) {
        setAuthenticated(false);
        setUser(undefined);
        setOrg(undefined);
        setEntities([]);
        return;
      }
      const me = (await res.json()) as MeResponse;
      setAuthenticated(true);
      setUser(me.user);
      setOrg(me.org);
      setImpersonating(me.impersonating ?? null);

      const [ents, curId, loc] = await Promise.all([
        all("entities"),
        metaGet<string>("currentEntityId"),
        metaGet<Locale>("locale"),
      ]);
      setEntities(ents);
      setCurrentEntityIdState(ents.find((e) => e.id === curId)?.id ?? ents[0]?.id);
      setLocaleState(loc ?? (me.org.defaultLocale as Locale) ?? "en");
    } catch {
      setAuthenticated(false);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    load();
    const off = onChange("entities", load);
    return off;
  }, [load]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";
  }, [locale]);

  const setCurrentEntityId = useCallback(async (id: string) => {
    setCurrentEntityIdState(id);
    await metaSet("currentEntityId", id);
  }, []);

  const setLocale = useCallback(async (l: Locale) => {
    setLocaleState(l);
    await metaSet("locale", l);
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    window.location.href = "/login";
  }, []);

  const currentEntity = useMemo(
    () => entities.find((e) => e.id === currentEntityId),
    [entities, currentEntityId],
  );

  const value: AppStateValue = {
    ready,
    authenticated,
    onboarded: authenticated && entities.length > 0,
    user,
    org,
    impersonating,
    entities,
    currentEntity,
    locale,
    setCurrentEntityId,
    setLocale,
    refresh: load,
    logout,
  };

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState() {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useAppState must be used within AppStateProvider");
  return ctx;
}
