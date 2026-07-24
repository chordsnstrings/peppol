"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronsUpDown, Building2, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppState } from "@/lib/app-state";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Dropdown,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
  DropdownTrigger,
} from "@/components/ui/dropdown";

export function EntitySwitcher() {
  const { entities, currentEntity, setCurrentEntityId } = useAppState();
  const router = useRouter();

  if (!currentEntity) return null;

  const statusTone =
    currentEntity.einvoicingStatus === "LIVE"
      ? "success"
      : currentEntity.einvoicingStatus === "SANDBOX"
        ? "gold"
        : "neutral";

  return (
    <Dropdown align="start">
      <DropdownTrigger>
        <button className="flex max-w-[220px] items-center gap-2.5 rounded-xl border border-border bg-card px-2.5 py-1.5 text-start transition-colors hover:bg-accent focus-ring">
          <Avatar name={currentEntity.legalNameEn} size={30} rounded="lg" />
          <div className="hidden min-w-0 flex-col sm:flex">
            <span className="truncate text-sm font-semibold leading-tight">
              {currentEntity.legalNameEn}
            </span>
            <span className="truncate text-[11px] leading-tight text-muted-foreground">
              {currentEntity.trn ? `TRN ${currentEntity.trn}` : "No TRN yet"}
            </span>
          </div>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownTrigger>

      <div className="w-[260px]">
        <DropdownLabel>Entities</DropdownLabel>
        {entities.map((e) => (
          <DropdownItem
            key={e.id}
            onSelect={() => setCurrentEntityId(e.id)}
            className="!items-center"
          >
            <span className="flex w-full items-center gap-2.5">
              <Avatar name={e.legalNameEn} size={28} rounded="lg" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{e.legalNameEn}</span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {e.peppolParticipantId ?? "—"}
                </span>
              </span>
              {e.id === currentEntity.id ? (
                <Check className="size-4 text-gold" />
              ) : (
                <Badge tone={e.einvoicingStatus === "LIVE" ? "success" : "gold"} size="sm">
                  {e.einvoicingStatus === "LIVE" ? "Live" : "Sandbox"}
                </Badge>
              )}
            </span>
          </DropdownItem>
        ))}
        <DropdownSeparator />
        <DropdownItem icon={<Plus />} onSelect={() => router.push("/settings/entities/new")}>
          Add entity
        </DropdownItem>
        <DropdownItem icon={<Building2 />} onSelect={() => router.push("/settings")}>
          Entity settings
        </DropdownItem>
      </div>
    </Dropdown>
  );
}
