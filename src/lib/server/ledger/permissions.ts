import { prisma } from "@/lib/server/prisma";
import { LedgerError } from "./post";

/**
 * Who may do what.
 *
 * Two decisions shape everything here.
 *
 * The first: **a workspace with no roles configured behaves exactly as it did
 * before roles existed.** Every member may do everything. Permissions are a
 * thing a business turns on when it grows past one bookkeeper, not a thing an
 * upgrade does to it — and a release that silently locks somebody out of their
 * own books at the month end is worse than no permissions at all. `check()`
 * returns `allowed: true` with the reason `no roles configured` until somebody
 * has said who may do what, and the screen says so plainly rather than
 * pretending to be enforcing something.
 *
 * The second: **separation of duties is reported, never silently imposed.** A
 * role holding both "propose a payment run" and "approve a payment run" defeats
 * the one control a payment run exists for. But a one-person business genuinely
 * needs both, and software that refuses to let a sole trader pay a supplier is
 * software that gets worked around. So a conflict is surfaced — on the role, on
 * the person, and on the screen — and the business decides. The controls that
 * must not be negotiable live in the database instead, where nobody negotiates
 * with them: a payment run's approver cannot be its preparer whatever role
 * either of them holds.
 */

export class PermissionError extends Error {
  status = 403;
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}

/* ------------------------------------------------------------ the catalogue */

export interface PermissionDef {
  key: string;
  group: string;
  label: string;
  /** What granting it lets somebody actually do, in a sentence. */
  effect: string;
}

/**
 * The complete set. A permission that is not here cannot be granted, because a
 * typo in a role's permission list would otherwise be a permission that is
 * never checked and silently never held.
 */
export const PERMISSIONS: PermissionDef[] = [
  { key: "ledger.read", group: "Ledger", label: "Read the books", effect: "See the chart, the journals, the statements and every report." },
  { key: "ledger.post", group: "Ledger", label: "Post journals", effect: "Put entries into the ledger by hand." },
  { key: "ledger.reverse", group: "Ledger", label: "Reverse entries", effect: "Correct a posted entry, which is the only way to correct one." },
  { key: "chart.edit", group: "Ledger", label: "Edit the chart", effect: "Add, rename, renumber and archive accounts." },
  { key: "period.close", group: "Close", label: "Close periods", effect: "Soft-close and hard-close a month, stopping further posting into it." },
  { key: "period.reopen", group: "Close", label: "Reopen periods", effect: "Reopen a closed month. A locked one never reopens, whoever holds this." },
  { key: "year.close", group: "Close", label: "Close the year", effect: "Roll the year's result into retained earnings." },
  { key: "ar.manage", group: "Sales", label: "Sales ledger", effect: "Post invoices and receipts, and manage customers and credit limits." },
  { key: "ar.credit_hold", group: "Sales", label: "Place and release credit holds", effect: "Stop new sales to a customer, and let them start again." },
  { key: "ap.manage", group: "Purchases", label: "Purchase ledger", effect: "Post bills and payments, and raise purchase orders." },
  { key: "payment_run.propose", group: "Purchases", label: "Propose payment runs", effect: "Build a batch of supplier payments." },
  { key: "payment_run.approve", group: "Purchases", label: "Approve payment runs", effect: "Sign off a batch so it can be released." },
  { key: "payment_run.release", group: "Purchases", label: "Release payment runs", effect: "Move the money and post the entries." },
  { key: "payroll.run", group: "People", label: "Run payroll", effect: "Calculate and post a payroll, including end-of-service." },
  { key: "payroll.read", group: "People", label: "See payroll", effect: "See salaries, which most people in a business should not." },
  { key: "expense.approve", group: "People", label: "Approve expense claims", effect: "Approve a colleague's claim for reimbursement." },
  { key: "tax.file", group: "Tax", label: "File returns", effect: "Prepare and mark filed the VAT return and the corporate tax computation." },
  { key: "bank.reconcile", group: "Cash", label: "Reconcile the bank", effect: "Import statements and match them to the ledger." },
  { key: "asset.manage", group: "Assets", label: "Fixed assets", effect: "Add, revalue, depreciate and dispose of assets." },
  { key: "setup.manage", group: "Administration", label: "Set up the books", effect: "Open books, open fiscal years, and load opening balances." },
  { key: "roles.manage", group: "Administration", label: "Manage roles", effect: "Decide who may do everything above, including this." },
];

const KEYS = new Set(PERMISSIONS.map((p) => p.key));

/**
 * Pairs that weaken a control when one person holds both. Reported, never
 * refused — see the note at the top of the file.
 *
 * They are not all the same weight, and pretending they are would train people
 * to dismiss the list. A `control` conflict defeats a separation the software
 * itself relies on and no shipped role holds one. A `note` is a weakness a
 * small business will accept knowingly — an accountant who both posts and
 * closes is how most books in the country are kept — and the shipped
 * Accountant role holds one deliberately.
 */
export type ConflictWeight = "control" | "note";

export const CONFLICTS: { a: string; b: string; weight: ConflictWeight; why: string }[] = [
  {
    a: "payment_run.propose", b: "payment_run.approve", weight: "control",
    why: "Preparing a payment and approving it are the one separation a payment run exists for. Fraud in accounts payable is rarely a forged invoice; it is one person who can do both.",
  },
  {
    a: "payment_run.approve", b: "payment_run.release", weight: "control",
    why: "Approving a batch and then moving the money are the last two steps, and somebody who holds both is the only person who ever sees the payment between the approval and the bank. This is why the shipped roles put approving and paying in different hands.",
  },
  {
    a: "expense.approve", b: "payment_run.release", weight: "control",
    why: "Approving your own claim and then paying it is the same person twice on the same money.",
  },
  {
    a: "ledger.post", b: "period.close", weight: "note",
    why: "Posting entries and closing the month over them means the same person can put something in and then stop anyone looking at it. Most small businesses accept this because one person keeps the books; it is worth knowing rather than worth refusing.",
  },
];

/* -------------------------------------------------------------- the roles */

/** The roles the product ships, which describe how businesses actually divide this work. */
export const BUILT_IN_ROLES: { code: string; name: string; description: string; permissions: string[] }[] = [
  {
    code: "OWNER", name: "Owner",
    description: "Everything, including deciding who may do what. A workspace must always have at least one.",
    permissions: PERMISSIONS.map((p) => p.key),
  },
  {
    code: "ACCOUNTANT", name: "Accountant",
    description: "Keeps the books and closes them, but does not move money.",
    permissions: [
      "ledger.read", "ledger.post", "ledger.reverse", "chart.edit",
      "period.close", "period.reopen", "year.close",
      "ar.manage", "ap.manage", "bank.reconcile", "asset.manage", "tax.file",
      "payment_run.propose",
    ],
  },
  {
    code: "BOOKKEEPER", name: "Bookkeeper",
    description: "Records the day's work. Cannot close a period or approve anything.",
    permissions: ["ledger.read", "ledger.post", "ar.manage", "ap.manage", "bank.reconcile", "payment_run.propose"],
  },
  {
    code: "APPROVER", name: "Approver",
    description: "Signs things off and records nothing. Does not move the money — that is the next role.",
    permissions: ["ledger.read", "payment_run.approve", "expense.approve", "ar.credit_hold"],
  },
  {
    code: "CASHIER", name: "Cashier",
    description: "Moves the money that has been approved, and reconciles the bank afterwards.",
    permissions: ["ledger.read", "payment_run.release", "bank.reconcile"],
  },
  {
    code: "VIEWER", name: "Viewer",
    description: "Reads the books and changes nothing. Payroll is not included: salaries are not a general read.",
    permissions: ["ledger.read"],
  },
];

/** Put the shipped roles into an organisation. Safe to call more than once. */
export async function seedBuiltInRoles(opts: { orgId: string }) {
  const created: string[] = [];
  for (const r of BUILT_IN_ROLES) {
    const existing = await prisma.accountingRole.findFirst({
      where: { orgId: opts.orgId, code: r.code },
      select: { id: true },
    });
    if (existing) {
      // Kept up to date, because a permission added in a later release would
      // otherwise be missing from every workspace that already has the role.
      await prisma.accountingRole.update({
        where: { id: existing.id },
        data: { permissions: r.permissions, name: r.name, description: r.description, builtIn: true },
      });
      continue;
    }
    await prisma.accountingRole.create({
      data: {
        orgId: opts.orgId, code: r.code, name: r.name, description: r.description,
        permissions: r.permissions, builtIn: true,
      },
    });
    created.push(r.code);
  }
  return { created };
}

function readPermissions(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) throw new LedgerError(`${where} has no permission list.`);
  return value.filter((v): v is string => typeof v === "string");
}

/* ------------------------------------------------------------ the decision */

export interface Decision {
  allowed: boolean;
  /** Why, in words a person can act on. */
  reason: string;
  /** True while the organisation has granted nothing to anybody. */
  unconfigured: boolean;
  /** Everything this person may do on this entity. */
  held: string[];
}

/**
 * What one person may do on one entity.
 *
 * Grants are additive: holding two roles gives the union of both, because that
 * is what a person told "you are also an approver" expects to happen. There is
 * no deny rule, deliberately — a permission system that can both grant and deny
 * needs an ordering, and every ordering is wrong for somebody.
 */
export async function permissionsOf(opts: {
  orgId: string;
  userId: string;
  entityId?: string;
}): Promise<{ held: Set<string>; unconfigured: boolean; roles: string[] }> {
  const anyAssignment = await prisma.roleAssignment.findFirst({
    where: { orgId: opts.orgId },
    select: { id: true },
  });
  if (!anyAssignment) return { held: new Set(KEYS), unconfigured: true, roles: [] };

  const mine = await prisma.roleAssignment.findMany({
    where: {
      orgId: opts.orgId,
      userId: opts.userId,
      ...(opts.entityId ? { entityId: { in: [opts.entityId, "*"] } } : {}),
    },
    include: { role: true },
  });

  const held = new Set<string>();
  const roles: string[] = [];
  for (const a of mine) {
    if (a.role.status !== "active") continue;
    roles.push(a.role.code);
    for (const p of readPermissions(a.role.permissions, a.role.code)) held.add(p);
  }
  return { held, unconfigured: false, roles };
}

export async function check(opts: {
  orgId: string;
  userId: string;
  entityId?: string;
  permission: string;
}): Promise<Decision> {
  if (!KEYS.has(opts.permission)) {
    // A permission nobody can grant would be a permission nobody ever holds,
    // so a typo in a guard would lock a screen for everybody with no clue why.
    throw new LedgerError(`"${opts.permission}" is not a permission this product has.`);
  }

  const { held, unconfigured, roles } = await permissionsOf(opts);
  if (unconfigured) {
    return {
      allowed: true, unconfigured: true, held: [...held],
      reason: "No roles have been set up in this workspace, so every member may do everything.",
    };
  }
  const def = PERMISSIONS.find((p) => p.key === opts.permission)!;
  if (held.has(opts.permission)) {
    return { allowed: true, unconfigured: false, held: [...held], reason: `Granted by ${roles.join(", ") || "a role"}.` };
  }
  return {
    allowed: false, unconfigured: false, held: [...held],
    reason: roles.length
      ? `${def.label} is not part of ${roles.length === 1 ? "the role" : "the roles"} you hold (${roles.join(", ")}). Somebody who can manage roles has to grant it.`
      : "You have no role on this entity yet. Somebody who can manage roles has to give you one.",
  };
}

/** The throwing form, for a route that has already decided the answer matters. */
export async function requirePermission(opts: {
  orgId: string;
  userId: string;
  entityId?: string;
  permission: string;
}): Promise<Decision> {
  const d = await check(opts);
  if (!d.allowed) throw new PermissionError(d.reason);
  return d;
}

/* --------------------------------------------------------------- managing */

const CODE_RE = /^[A-Z][A-Z0-9_]{1,31}$/;

export async function createRole(opts: {
  orgId: string;
  code: string;
  name: string;
  description?: string;
  permissions: string[];
}) {
  const code = opts.code.trim().toUpperCase();
  if (!CODE_RE.test(code)) {
    throw new LedgerError("A role code is capitals, digits and underscores — SALES_MANAGER, not \"Sales Manager\".");
  }
  const unknown = opts.permissions.filter((p) => !KEYS.has(p));
  if (unknown.length) {
    throw new LedgerError(
      `${unknown.join(", ")} ${unknown.length === 1 ? "is not a permission" : "are not permissions"} this product has. ` +
        `A permission nobody can check is a permission nobody holds.`,
    );
  }
  if (!opts.permissions.length) {
    throw new LedgerError("A role that grants nothing will be assigned by mistake and then wondered about. Give it something.");
  }

  const dup = await prisma.accountingRole.findFirst({ where: { orgId: opts.orgId, code }, select: { name: true } });
  if (dup) throw new LedgerError(`Role ${code} already exists — it is "${dup.name}".`);

  return prisma.accountingRole.create({
    data: {
      orgId: opts.orgId, code, name: opts.name.trim() || code,
      description: opts.description?.trim() || null,
      permissions: [...new Set(opts.permissions)],
    },
  });
}

export async function updateRole(opts: {
  orgId: string;
  code: string;
  name?: string;
  description?: string;
  permissions?: string[];
}) {
  const role = await prisma.accountingRole.findFirst({ where: { orgId: opts.orgId, code: opts.code } });
  if (!role) throw new LedgerError(`There is no role ${opts.code} in this workspace.`);
  if (role.builtIn) {
    throw new LedgerError(
      `${role.name} is a role the product ships, so it cannot be edited — otherwise "Approver" would mean something ` +
        `different in every workspace and nobody could reason about it. Copy it into a role of your own instead.`,
    );
  }
  if (opts.permissions) {
    const unknown = opts.permissions.filter((p) => !KEYS.has(p));
    if (unknown.length) throw new LedgerError(`${unknown.join(", ")} is not a permission this product has.`);
    if (!opts.permissions.length) throw new LedgerError("A role has to grant something.");
  }

  return prisma.accountingRole.update({
    where: { id: role.id },
    data: {
      ...(opts.name === undefined ? {} : { name: opts.name.trim() }),
      ...(opts.description === undefined ? {} : { description: opts.description.trim() || null }),
      ...(opts.permissions ? { permissions: [...new Set(opts.permissions)] } : {}),
    },
  });
}

export async function assignRole(opts: {
  orgId: string;
  userId: string;
  roleCode: string;
  entityId?: string;
  grantedBy?: string;
}) {
  const role = await prisma.accountingRole.findFirst({ where: { orgId: opts.orgId, code: opts.roleCode } });
  if (!role) throw new LedgerError(`There is no role ${opts.roleCode} in this workspace.`);

  const member = await prisma.membership.findUnique({
    where: { userId_orgId: { userId: opts.userId, orgId: opts.orgId } },
    select: { userId: true },
  });
  if (!member) throw new LedgerError("That person is not a member of this workspace, so there is nothing to grant them.");

  const entityId = opts.entityId?.trim() || "*";
  return prisma.roleAssignment.upsert({
    where: {
      orgId_userId_roleId_entityId: { orgId: opts.orgId, userId: opts.userId, roleId: role.id, entityId },
    },
    create: { orgId: opts.orgId, userId: opts.userId, roleId: role.id, entityId, grantedBy: opts.grantedBy },
    update: {},
  });
}

/**
 * Take a role away.
 *
 * The one thing this refuses is removing the last grant of `roles.manage` from
 * the workspace. A workspace that can no longer say who may do what cannot be
 * repaired from inside itself, and the person who did it will not realise until
 * they need to grant something.
 */
export async function revokeRole(opts: {
  orgId: string;
  userId: string;
  roleCode: string;
  entityId?: string;
}) {
  const role = await prisma.accountingRole.findFirst({ where: { orgId: opts.orgId, code: opts.roleCode } });
  if (!role) throw new LedgerError(`There is no role ${opts.roleCode} in this workspace.`);
  const entityId = opts.entityId?.trim() || "*";

  const grants = await prisma.roleAssignment.findMany({
    where: { orgId: opts.orgId },
    include: { role: true },
  });
  const managers = grants.filter(
    (g) => g.role.status === "active" && readPermissions(g.role.permissions, g.role.code).includes("roles.manage"),
  );
  const losing = managers.filter((g) => g.userId === opts.userId && g.roleId === role.id && g.entityId === entityId);
  if (losing.length && managers.length === losing.length) {
    throw new LedgerError(
      `That is the last grant of "Manage roles" in this workspace. Removing it would leave nobody able to say who may ` +
        `do what, and nothing inside the workspace could put it back. Give somebody else the permission first.`,
    );
  }

  const deleted = await prisma.roleAssignment.deleteMany({
    where: { orgId: opts.orgId, userId: opts.userId, roleId: role.id, entityId },
  });
  if (deleted.count === 0) throw new LedgerError(`${opts.roleCode} was not granted to that person on ${entityId === "*" ? "any entity" : entityId}.`);
  return { revoked: opts.roleCode, entityId };
}

/* ------------------------------------------------------------- the screen */

export interface RoleView {
  code: string;
  name: string;
  description: string | null;
  builtIn: boolean;
  status: string;
  permissions: string[];
  /** Pairs this role holds that weaken a control. */
  conflicts: { a: string; b: string; weight: ConflictWeight; why: string }[];
  assignedCount: number;
}

export interface PersonView {
  userId: string;
  name: string | null;
  email: string;
  /** Roles held, with the entity each applies to. */
  grants: { roleCode: string; roleName: string; entityId: string }[];
  permissions: string[];
  conflicts: { a: string; b: string; weight: ConflictWeight; why: string }[];
}

function conflictsIn(held: string[]) {
  const s = new Set(held);
  return CONFLICTS.filter((c) => s.has(c.a) && s.has(c.b));
}

/**
 * Everything the roles screen needs, in one read: the roles, the people, what
 * each of them can actually do, and where somebody holds two permissions that
 * were meant to be held by two people.
 */
export async function rolesOverview(opts: { orgId: string }) {
  const [roles, members, assignments] = await Promise.all([
    prisma.accountingRole.findMany({ where: { orgId: opts.orgId }, orderBy: [{ builtIn: "desc" }, { code: "asc" }] }),
    prisma.membership.findMany({ where: { orgId: opts.orgId }, include: { user: true } }),
    prisma.roleAssignment.findMany({ where: { orgId: opts.orgId }, include: { role: true } }),
  ]);

  const roleViews: RoleView[] = roles.map((r) => {
    const perms = readPermissions(r.permissions, r.code);
    return {
      code: r.code, name: r.name, description: r.description, builtIn: r.builtIn, status: r.status,
      permissions: perms,
      conflicts: conflictsIn(perms),
      assignedCount: assignments.filter((a) => a.roleId === r.id).length,
    };
  });

  const people: PersonView[] = members.map((m) => {
    const mine = assignments.filter((a) => a.userId === m.userId && a.role.status === "active");
    const held = [...new Set(mine.flatMap((a) => readPermissions(a.role.permissions, a.role.code)))];
    return {
      userId: m.userId,
      name: m.user.name ?? null,
      email: m.user.email,
      grants: mine.map((a) => ({ roleCode: a.role.code, roleName: a.role.name, entityId: a.entityId })),
      permissions: held,
      conflicts: conflictsIn(held),
    };
  });

  return {
    roles: roleViews,
    people,
    catalogue: PERMISSIONS,
    /** True while nothing is granted, which is the state most workspaces are in. */
    unconfigured: assignments.length === 0,
    /** Members with no role at all, once roles are in use — they can do nothing. */
    unassigned: assignments.length === 0 ? [] : people.filter((p) => p.grants.length === 0).map((p) => p.email),
  };
}
