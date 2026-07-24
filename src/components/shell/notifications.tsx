"use client";

import * as React from "react";
import Link from "next/link";
import { Bell, CheckCheck, Inbox } from "lucide-react";
import { motion } from "framer-motion";
import { cn, timeAgo } from "@/lib/utils";
import { useAppState } from "@/lib/app-state";
import { useCollection } from "@/lib/db/hooks";
import { put } from "@/lib/db/database";
import type { AppNotification } from "@/lib/domain/types";
import {
  Dropdown,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import { Button } from "@/components/ui/button";

const toneDot: Record<string, string> = {
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
  neutral: "bg-info",
};

export function Notifications() {
  const { org } = useAppState();
  const { data } = useCollection<AppNotification>("notifications", {
    index: org ? { name: "orgId", value: org.id } : undefined,
    sort: (a, b) => b.createdAt.localeCompare(a.createdAt),
    deps: [org?.id],
  });
  const unread = data.filter((n) => !n.readAt).length;

  const markAll = async () => {
    const now = new Date().toISOString();
    for (const n of data.filter((x) => !x.readAt)) {
      await put("notifications", { ...n, readAt: now });
    }
  };

  return (
    <Dropdown align="end">
      <DropdownTrigger>
        <button
          className="relative inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-ring"
          aria-label="Notifications"
        >
          <Bell className="size-[18px]" />
          {unread > 0 && (
            <span className="absolute end-1.5 top-1.5 flex size-4 items-center justify-center rounded-full bg-gold text-[9px] font-bold text-[#0B1A2E]">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
      </DropdownTrigger>

      <div className="w-[340px] max-w-[calc(100vw-2rem)] p-0">
        <div className="flex items-center justify-between px-3 py-2.5">
          <span className="text-sm font-semibold">Notifications</span>
          {unread > 0 && (
            <button
              onClick={markAll}
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <CheckCheck className="size-3.5" /> Mark all read
            </button>
          )}
        </div>
        <div className="max-h-[380px] overflow-y-auto px-1.5 pb-1.5">
          {data.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
              <Inbox className="size-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">You're all caught up.</p>
            </div>
          ) : (
            data.slice(0, 20).map((n, i) => (
              <motion.div
                key={n.id}
                initial={{ opacity: 0, x: 6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.02 }}
              >
                <Link
                  href={n.href ?? "#"}
                  onClick={() => !n.readAt && put("notifications", { ...n, readAt: new Date().toISOString() })}
                  className={cn(
                    "flex gap-3 rounded-lg px-2.5 py-2.5 transition-colors hover:bg-accent",
                    !n.readAt && "bg-gold/[0.06]",
                  )}
                >
                  <span
                    className={cn(
                      "mt-1.5 size-2 shrink-0 rounded-full",
                      toneDot[n.tone ?? "neutral"],
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium leading-snug">{n.title}</span>
                    {n.body && (
                      <span className="mt-0.5 block text-xs text-muted-foreground">{n.body}</span>
                    )}
                    <span className="mt-1 block text-[11px] text-muted-foreground/70">
                      {timeAgo(n.createdAt)}
                    </span>
                  </span>
                </Link>
              </motion.div>
            ))
          )}
        </div>
      </div>
    </Dropdown>
  );
}
