"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Menu, Search, Globe, LogOut, Settings2, Palette } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppState } from "@/lib/app-state";
import { Logo } from "./logo";
import { EntitySwitcher } from "./entity-switcher";
import { Notifications } from "./notifications";
import { openCommandPalette } from "./command-palette";
import { ThemeToggle } from "@/components/theme-toggle";
import { Avatar } from "@/components/ui/avatar";
import { Kbd } from "@/components/ui/feedback";
import { Badge } from "@/components/ui/badge";
import {
  Dropdown,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
  DropdownTrigger,
} from "@/components/ui/dropdown";

export function Topbar({ onMenu }: { onMenu: () => void }) {
  const { org, currentEntity, locale, setLocale } = useAppState();
  const router = useRouter();

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border glass-strong px-4 safe-top md:px-6">
      {/* Mobile menu + logo */}
      <button
        onClick={onMenu}
        className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-ring md:hidden"
        aria-label="Open menu"
      >
        <Menu className="size-5" />
      </button>
      <div className="md:hidden">
        <Logo wordmark={false} size={30} />
      </div>

      {/* Entity switcher (desktop) */}
      <div className="hidden md:block">
        <EntitySwitcher />
      </div>

      {currentEntity && (
        <Badge
          tone={currentEntity.einvoicingStatus === "LIVE" ? "success" : "gold"}
          className="hidden lg:inline-flex"
          dot
        >
          {currentEntity.einvoicingStatus === "LIVE" ? "Live" : "Sandbox"}
        </Badge>
      )}

      <div className="flex-1" />

      {/* Search */}
      <button
        onClick={openCommandPalette}
        className="hidden h-9 items-center gap-2 rounded-xl border border-border bg-card px-3 text-sm text-muted-foreground transition-colors hover:bg-accent sm:flex"
      >
        <Search className="size-4" />
        <span className="hidden lg:inline">Search…</span>
        <Kbd className="hidden lg:inline-flex">⌘K</Kbd>
      </button>
      <button
        onClick={openCommandPalette}
        aria-label="Search"
        className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-ring sm:hidden"
      >
        <Search className="size-[18px]" />
      </button>

      <Notifications />
      <ThemeToggle className="hidden sm:inline-flex" />

      {/* User / account */}
      <Dropdown align="end">
        <DropdownTrigger>
          <button className="focus-ring rounded-full" aria-label="Account">
            <Avatar name={org?.name ?? "ARKS"} size={34} />
          </button>
        </DropdownTrigger>
        <div className="w-[240px]">
          <div className="flex items-center gap-2.5 px-2.5 py-2">
            <Avatar name={org?.name ?? "ARKS"} size={36} />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{org?.name ?? "Workspace"}</p>
              <p className="truncate text-xs text-muted-foreground">Organization</p>
            </div>
          </div>
          <DropdownSeparator />
          <DropdownLabel>Language</DropdownLabel>
          <DropdownItem
            icon={<Globe />}
            onSelect={() => setLocale(locale === "en" ? "ar" : "en")}
          >
            {locale === "en" ? "العربية (Arabic)" : "English"}
          </DropdownItem>
          <DropdownItem icon={<Palette />} onSelect={() => router.push("/settings/notifications")}>
            Preferences
          </DropdownItem>
          <DropdownItem icon={<Settings2 />} onSelect={() => router.push("/settings")}>
            Settings
          </DropdownItem>
          <DropdownSeparator />
          <DropdownItem icon={<LogOut />} tone="destructive" onSelect={() => router.push("/settings/billing")}>
            Manage workspace
          </DropdownItem>
        </div>
      </Dropdown>
    </header>
  );
}
