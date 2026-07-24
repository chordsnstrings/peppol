import {
  LayoutDashboard,
  FileText,
  Inbox,
  Sheet,
  Users,
  Package,
  Plug,
  BarChart3,
  Wrench,
  Settings,
  CreditCard,
  Repeat,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** dynamic badge key resolved by the shell (e.g. open fix-it count) */
  badge?: "fixit" | "inbox";
  /** show in the mobile bottom bar */
  mobile?: boolean;
}

export const MAIN_NAV: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, mobile: true },
  { label: "Invoices", href: "/invoices", icon: FileText, mobile: true },
  { label: "Recurring", href: "/recurring", icon: Repeat },
  { label: "Get paid", href: "/payments", icon: CreditCard },
  { label: "Inbox", href: "/inbox", icon: Inbox, badge: "inbox" },
  { label: "Uploads", href: "/uploads", icon: Sheet },
  { label: "Customers", href: "/customers", icon: Users },
  { label: "Products", href: "/products", icon: Package },
  { label: "Integrations", href: "/integrations", icon: Plug },
  { label: "Reports", href: "/reports", icon: BarChart3 },
  { label: "Fix-it", href: "/fixit", icon: Wrench, badge: "fixit", mobile: true },
  { label: "Settings", href: "/settings", icon: Settings },
];

export const SETTINGS_NAV = [
  { label: "Entity", href: "/settings" },
  { label: "Team", href: "/settings/team" },
  { label: "Billing", href: "/settings/billing" },
  { label: "API keys", href: "/settings/api" },
  { label: "Notifications", href: "/settings/notifications" },
];
