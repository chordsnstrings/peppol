-- Roles and permissions.
--
-- Nothing here changes what an existing workspace can do. A workspace with no
-- roles configured behaves exactly as it did — every member may do everything —
-- because an upgrade that silently locks people out of their own books is worse
-- than no permissions at all. The guard only bites once somebody has said who
-- may do what.

CREATE TABLE "AccountingRole" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL,
    "code" TEXT NOT NULL, "name" TEXT NOT NULL, "description" TEXT,
    "permissions" JSONB NOT NULL,
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AccountingRole_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AccountingRole_status_check" CHECK ("status" IN ('active','archived')),
    -- A role granting nothing is a role that will be assigned by mistake and
    -- then wondered about.
    CONSTRAINT "AccountingRole_permissions_check"
      CHECK (jsonb_typeof("permissions") = 'array' AND jsonb_array_length("permissions") > 0)
);
CREATE UNIQUE INDEX "AccountingRole_orgId_code_key" ON "AccountingRole"("orgId","code");
CREATE INDEX "AccountingRole_orgId_status_idx" ON "AccountingRole"("orgId","status");

CREATE TABLE "RoleAssignment" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL DEFAULT '*',
    "grantedBy" TEXT, "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RoleAssignment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RoleAssignment_roleId_fkey" FOREIGN KEY ("roleId")
      REFERENCES "AccountingRole"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RoleAssignment_entity_check" CHECK ("entityId" <> '')
);
-- '*' is a literal rather than NULL precisely so this holds: Postgres treats
-- two NULLs as distinct, and the same grant could then be made twice.
CREATE UNIQUE INDEX "RoleAssignment_orgId_userId_roleId_entityId_key"
  ON "RoleAssignment"("orgId","userId","roleId","entityId");
CREATE INDEX "RoleAssignment_orgId_userId_idx" ON "RoleAssignment"("orgId","userId");
