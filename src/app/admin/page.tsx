import { requirePlatformAdmin } from "@/lib/server/platform-admin";
import { Terminal } from "lucide-react";

export const dynamic = "force-dynamic";

/** Operator console landing. The platform overview KPIs land here in Phase 1. */
export default async function AdminHome() {
  const admin = await requirePlatformAdmin();
  return (
    <div>
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-xl bg-muted text-foreground">
          <Terminal className="size-5" />
        </div>
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Operator console</h1>
          <p className="text-sm text-muted-foreground">
            Signed in as {admin.email} · {admin.role.replace("_", " ")}
          </p>
        </div>
      </div>

      <div className="mt-6 rounded-xl border border-border bg-card p-6">
        <p className="text-sm text-muted-foreground">
          The access &amp; audit foundation is live. Every screen here reads across all workspaces and every
          action is written to the audit log. Overview metrics, tenant management, deliverability, billing and
          the rest arrive as each phase ships.
        </p>
      </div>
    </div>
  );
}
