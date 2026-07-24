import type { RecurringCadence } from "./types";

export const CADENCES: { code: RecurringCadence; label: string; everyDaysApprox: number }[] = [
  { code: "WEEKLY", label: "Weekly", everyDaysApprox: 7 },
  { code: "MONTHLY", label: "Monthly", everyDaysApprox: 30 },
  { code: "QUARTERLY", label: "Quarterly", everyDaysApprox: 91 },
  { code: "YEARLY", label: "Yearly", everyDaysApprox: 365 },
];

export function cadenceLabel(c: RecurringCadence): string {
  return CADENCES.find((x) => x.code === c)?.label ?? c;
}

function toDate(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`);
}
function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Advance an ISO date by one cadence step (calendar-correct for month/quarter/year). */
export function advanceDate(iso: string, cadence: RecurringCadence): string {
  const d = toDate(iso);
  switch (cadence) {
    case "WEEKLY":
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case "MONTHLY":
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
    case "QUARTERLY":
      d.setUTCMonth(d.getUTCMonth() + 3);
      break;
    case "YEARLY":
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      break;
  }
  return isoOf(d);
}

/** Is this template due to run on/before the given day (default today)? */
export function isDue(nextRunDate: string, today = isoOf(new Date())): boolean {
  return nextRunDate.slice(0, 10) <= today;
}
