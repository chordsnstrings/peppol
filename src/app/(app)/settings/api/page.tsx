"use client";

import * as React from "react";
import { KeyRound, Plus, Copy, Trash2, Check, Webhook } from "lucide-react";
import { id as makeId, timeAgo } from "@/lib/utils";
import { metaGet, metaSet } from "@/lib/db/database";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import { toast } from "sonner";

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
}

function randomKey() {
  const rand = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
  return `arks_live_${rand}`;
}

export default function ApiSettingsPage() {
  const [keys, setKeys] = React.useState<ApiKey[]>([]);
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState("");
  const [revealed, setRevealed] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [deleting, setDeleting] = React.useState<ApiKey | null>(null);

  React.useEffect(() => {
    metaGet<ApiKey[]>("apiKeys").then((k) => setKeys(k ?? []));
  }, []);

  const persist = async (next: ApiKey[]) => {
    setKeys(next);
    await metaSet("apiKeys", next);
  };

  const create = async () => {
    const full = randomKey();
    const key: ApiKey = {
      id: makeId("key"),
      name: name.trim() || "Untitled key",
      prefix: full.slice(0, 16),
      createdAt: new Date().toISOString(),
    };
    await persist([key, ...keys]);
    setRevealed(full);
    setCreating(false);
    setName("");
  };

  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-lg font-semibold">API keys</h2>
          <p className="text-sm text-muted-foreground">
            Programmatic access to the <code className="rounded bg-muted px-1 text-xs">/api/v1</code> REST API.
          </p>
        </div>
        <Button icon={<Plus />} onClick={() => setCreating(true)}>
          New key
        </Button>
      </div>

      {keys.length === 0 ? (
        <EmptyState
          icon={<KeyRound />}
          title="No API keys yet"
          description="Create a scoped key to push invoices, run validations and receive webhooks from your own systems."
          action={
            <Button icon={<Plus />} onClick={() => setCreating(true)}>
              Create key
            </Button>
          }
        />
      ) : (
        <Card className="divide-y divide-border">
          {keys.map((k) => (
            <CardContent key={k.id} className="flex items-center gap-3 !p-4">
              <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <KeyRound className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{k.name}</p>
                <p className="font-mono text-xs text-muted-foreground">{k.prefix}••••••••</p>
              </div>
              <span className="hidden text-xs text-muted-foreground sm:block">
                Created {timeAgo(k.createdAt)}
              </span>
              <Button variant="ghost" size="icon-sm" onClick={() => setDeleting(k)} aria-label="Revoke">
                <Trash2 className="size-4" />
              </Button>
            </CardContent>
          ))}
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Webhook className="size-4" /> Webhooks
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Subscribe to <code className="rounded bg-muted px-1 text-xs">invoice.status.changed</code>,{" "}
            <code className="rounded bg-muted px-1 text-xs">invoice.reported</code> and more. Each delivery
            is HMAC-signed. Configure endpoints when you connect your systems.
          </p>
        </CardContent>
      </Card>

      {/* Create modal */}
      <Modal open={creating} onClose={() => setCreating(false)} title="Create API key" size="sm">
        <div className="space-y-4 p-5">
          <Field label="Key name" help="A label to recognise this key later.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Production server" autoFocus />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button onClick={create}>Generate</Button>
          </div>
        </div>
      </Modal>

      {/* Reveal once */}
      <Modal open={Boolean(revealed)} onClose={() => setRevealed(null)} title="Copy your API key" size="md">
        <div className="p-5">
          <p className="text-sm text-muted-foreground">
            This is the only time you'll see the full key. Store it securely.
          </p>
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-muted p-3">
            <code className="flex-1 break-all font-mono text-sm">{revealed}</code>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => {
                navigator.clipboard?.writeText(revealed ?? "");
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              aria-label="Copy"
            >
              {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
            </Button>
          </div>
          <div className="mt-5 flex justify-end">
            <Button onClick={() => setRevealed(null)}>Done</Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await persist(keys.filter((k) => k.id !== deleting.id));
          toast.success("Key revoked");
          setDeleting(null);
        }}
        title="Revoke this key?"
        description={`${deleting?.name} will stop working immediately.`}
        confirmLabel="Revoke key"
        tone="destructive"
      />
    </div>
  );
}
