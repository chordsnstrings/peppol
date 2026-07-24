import type {
  ExchangeStatus,
  LifecycleStatus,
  ReportingStatus,
} from "./types";

export type StatusTone = "neutral" | "info" | "success" | "warning" | "error" | "gold";

export interface StatusMeta {
  label: string;
  tone: StatusTone;
  description: string;
}

export const LIFECYCLE_META: Record<LifecycleStatus, StatusMeta> = {
  DRAFT: { label: "Draft", tone: "neutral", description: "Editable. Nothing sent yet." },
  READY: { label: "Ready", tone: "info", description: "Validated and ready to send." },
  QUEUED: { label: "Queued", tone: "info", description: "Waiting in the send pipeline." },
  SENDING: { label: "Sending", tone: "warning", description: "In transit across the network." },
  SENT: { label: "Sent", tone: "info", description: "Submitted to the network." },
  DELIVERED: { label: "Delivered", tone: "success", description: "Received by the buyer's provider." },
  COMPLETED: {
    label: "Completed",
    tone: "success",
    description: "Delivered to the buyer and reported to the FTA.",
  },
  FAILED: { label: "Failed", tone: "error", description: "Something needs fixing. See the fix-it queue." },
  CANCELLED: { label: "Cancelled", tone: "neutral", description: "This draft was cancelled." },
};

export const EXCHANGE_META: Record<ExchangeStatus, StatusMeta> = {
  NOT_SENT: { label: "Not sent", tone: "neutral", description: "Not yet transmitted." },
  SUBMITTED: { label: "Submitted", tone: "info", description: "Handed to the network." },
  DELIVERED: { label: "Delivered", tone: "success", description: "Buyer's provider accepted it." },
  REJECTED_BY_C3: { label: "Rejected", tone: "error", description: "Buyer's provider rejected it." },
  DELIVERY_FAILED: { label: "Delivery failed", tone: "error", description: "Could not deliver." },
  UNDELIVERABLE_NO_PARTICIPANT: {
    label: "Not on network",
    tone: "warning",
    description: "Buyer isn't reachable on Peppol yet.",
  },
};

export const REPORTING_META: Record<ReportingStatus, StatusMeta> = {
  NOT_REPORTED: { label: "Not reported", tone: "neutral", description: "Not yet reported to FTA." },
  SUBMITTED: { label: "Reporting", tone: "info", description: "Tax Data Document submitted." },
  ACCEPTED: { label: "Reported", tone: "success", description: "Accepted by the FTA." },
  REJECTED: { label: "Report rejected", tone: "error", description: "FTA rejected the report." },
};

/** Legal lifecycle transitions (a real subset of §7.2). */
const TRANSITIONS: Record<LifecycleStatus, LifecycleStatus[]> = {
  DRAFT: ["READY", "CANCELLED"],
  READY: ["QUEUED", "DRAFT", "CANCELLED"],
  QUEUED: ["SENDING", "FAILED"],
  SENDING: ["SENT", "DELIVERED", "FAILED"],
  SENT: ["DELIVERED", "COMPLETED", "FAILED"],
  DELIVERED: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: ["DRAFT"],
  CANCELLED: [],
};

export function canTransition(from: LifecycleStatus, to: LifecycleStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export const ALL_LIFECYCLE: LifecycleStatus[] = [
  "DRAFT",
  "READY",
  "QUEUED",
  "SENDING",
  "SENT",
  "DELIVERED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
];
