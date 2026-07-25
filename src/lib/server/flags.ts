import { prisma } from "./prisma";

/**
 * Platform feature flags / kill switches. Global toggles stored in FeatureFlag.
 * Known keys are documented here; arbitrary keys are allowed for ad-hoc switches.
 */
export const KNOWN_FLAGS = [
  { key: "signups_frozen", label: "Freeze new signups", desc: "Block new workspace registration platform-wide." },
  { key: "sending_paused", label: "Pause all sending", desc: "Stop every tenant's send pipeline (incident switch)." },
] as const;

export async function listFlags(): Promise<{ key: string; value: string; updatedAt: string | null }[]> {
  const rows = await prisma.featureFlag.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  // Merge known flags (default off) with any ad-hoc rows.
  const keys = new Set<string>([...KNOWN_FLAGS.map((f) => f.key), ...rows.map((r) => r.key)]);
  return [...keys].map((key) => {
    const row = byKey.get(key);
    return { key, value: row?.value ?? "false", updatedAt: row?.updatedAt.toISOString() ?? null };
  });
}

export async function getFlag(key: string): Promise<string | null> {
  const row = await prisma.featureFlag.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function isFlagOn(key: string): Promise<boolean> {
  return (await getFlag(key)) === "true";
}

export async function setFlag(key: string, on: boolean, updatedBy: string): Promise<void> {
  await prisma.featureFlag.upsert({
    where: { key },
    create: { key, value: on ? "true" : "false", updatedBy },
    update: { value: on ? "true" : "false", updatedBy },
  });
}
