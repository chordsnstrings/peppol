"use client";

import * as React from "react";
import { UserPlus, Mail, Shield } from "lucide-react";
import { id as makeId } from "@/lib/utils";
import { useAppState } from "@/lib/app-state";
import { useCollection } from "@/lib/db/hooks";
import { put, remove } from "@/lib/db/database";
import type { Member } from "@/lib/domain/types";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Modal } from "@/components/ui/modal";
import { Dropdown, DropdownItem, DropdownTrigger } from "@/components/ui/dropdown";
import { MoreHorizontal, Trash2 } from "lucide-react";
import { toast } from "sonner";

const ROLES = [
  { value: "OWNER", label: "Owner", desc: "Full access, billing & org control" },
  { value: "ADMIN", label: "Admin", desc: "Everything except billing" },
  { value: "FINANCE", label: "Finance", desc: "Send invoices & view billing" },
  { value: "CLERK", label: "Clerk", desc: "Create & edit, cannot send" },
  { value: "VIEWER", label: "Viewer", desc: "Read-only" },
  { value: "ACCOUNTANT_EXTERNAL", label: "External accountant", desc: "Scoped, flagged external" },
] as const;

export default function TeamPage() {
  const { org } = useAppState();
  const { data: members } = useCollection<Member>("members", {
    index: org ? { name: "orgId", value: org.id } : undefined,
    sort: (a, b) => a.createdAt.localeCompare(b.createdAt),
    deps: [org?.id],
  });
  const [inviting, setInviting] = React.useState(false);

  return (
    <div className="max-w-3xl">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="font-display text-lg font-semibold">Team members</h2>
          <p className="text-sm text-muted-foreground">Invite teammates and set what they can do.</p>
        </div>
        <Button icon={<UserPlus />} onClick={() => setInviting(true)}>
          Invite
        </Button>
      </div>

      {members.length === 0 ? (
        <EmptyState
          icon={<UserPlus />}
          title="Just you so far"
          description="Invite colleagues or your accountant. Each gets a role with plain-language permissions."
          action={
            <Button icon={<UserPlus />} onClick={() => setInviting(true)}>
              Invite a teammate
            </Button>
          }
        />
      ) : (
        <Card className="divide-y divide-border">
          {members.map((m) => {
            const role = ROLES.find((r) => r.value === m.role);
            return (
              <CardContent key={m.id} className="flex items-center gap-3 !p-4">
                <Avatar name={m.name || m.email} size={40} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{m.name || m.email}</p>
                  <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                </div>
                {m.status === "INVITED" && <Badge tone="warning" size="sm">Invited</Badge>}
                <Badge tone="neutral" size="sm">
                  <Shield className="size-3" /> {role?.label}
                </Badge>
                <Dropdown align="end">
                  <DropdownTrigger>
                    <button className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent focus-ring">
                      <MoreHorizontal className="size-4" />
                    </button>
                  </DropdownTrigger>
                  <div className="w-40">
                    <DropdownItem
                      icon={<Trash2 />}
                      tone="destructive"
                      onSelect={async () => {
                        await remove("members", m.id);
                        toast.success("Member removed");
                      }}
                    >
                      Remove
                    </DropdownItem>
                  </div>
                </Dropdown>
              </CardContent>
            );
          })}
        </Card>
      )}

      <InviteModal open={inviting} onClose={() => setInviting(false)} />
    </div>
  );
}

function InviteModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { org } = useAppState();
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState<Member["role"]>("CLERK");
  const [saving, setSaving] = React.useState(false);

  const submit = async () => {
    if (!org || !email.trim()) return;
    setSaving(true);
    const member: Member = {
      id: makeId("mbr"),
      orgId: org.id,
      email: email.trim(),
      name: name.trim(),
      role,
      status: "INVITED",
      createdAt: new Date().toISOString(),
    };
    await put("members", member);
    setSaving(false);
    setEmail("");
    setName("");
    toast.success("Invitation sent", { description: `${email} was invited as ${role}.` });
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Invite a teammate" size="md">
      <div className="space-y-4 p-5 sm:p-6">
        <Field label="Email" required>
          <Input type="email" leading={<Mail />} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.ae" autoFocus />
        </Field>
        <Field label="Name" hint="optional">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value as Member["role"])}>
            {ROLES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label} — {r.desc}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={saving} disabled={!email.trim()}>
            Send invite
          </Button>
        </div>
      </div>
    </Modal>
  );
}
