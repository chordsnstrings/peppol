import { notFound } from "next/navigation";
import { getPlatformAdmin } from "@/lib/server/platform-admin";
import { AdminShell } from "@/components/admin/admin-shell";

export const dynamic = "force-dynamic";

/**
 * Server-side gate for the whole operator console. Non-admins get a 404 (the
 * route's existence isn't leaked). Admins get the staff shell.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await getPlatformAdmin();
  if (!admin) notFound();
  return (
    <AdminShell admin={{ email: admin.email, name: admin.name, role: admin.role, viaAllowlist: admin.viaAllowlist }}>
      {children}
    </AdminShell>
  );
}
