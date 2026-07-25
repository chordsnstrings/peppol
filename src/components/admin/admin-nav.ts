import { LayoutDashboard, Building2, RadioTower, Wallet, Users, Terminal, ScrollText, ToggleRight, ShieldCheck, type LucideIcon } from "lucide-react";

export interface AdminNavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Minimum role required to see the item. */
  min?: "super";
}

/** Operator console navigation. Items are added as each phase ships. */
export const ADMIN_NAV: AdminNavItem[] = [
  { label: "Overview", href: "/admin", icon: LayoutDashboard },
  { label: "Tenants", href: "/admin/tenants", icon: Building2 },
  { label: "Deliverability", href: "/admin/deliverability", icon: RadioTower },
  { label: "Billing", href: "/admin/billing", icon: Wallet },
  { label: "Users", href: "/admin/users", icon: Users },
  { label: "Developers", href: "/admin/developers", icon: Terminal },
  { label: "Flags", href: "/admin/flags", icon: ToggleRight },
  { label: "Audit log", href: "/admin/audit", icon: ScrollText },
  { label: "Operators", href: "/admin/admins", icon: ShieldCheck, min: "super" },
];
