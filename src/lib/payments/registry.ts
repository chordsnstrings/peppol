import type { PaymentDriverId, PaymentProviderPort } from "./port";
import { mockPayments } from "./mock";
import { networkPayments } from "./network-international";
import { noqodiPayments } from "./noqodi";

/**
 * Resolve the active payment provider from PAYMENT_DRIVER. Defaults to the mock
 * driver (self-hosted /pay page) so collection runs credential-free; set
 * PAYMENT_DRIVER=network|noqodi (+ that provider's credentials) to go live.
 */
export function getPaymentProvider(): PaymentProviderPort {
  const driver = (process.env.PAYMENT_DRIVER ?? "mock").toLowerCase();
  if (driver === "network" && process.env.NETWORK_API_KEY) return networkPayments;
  if (driver === "noqodi" && process.env.NOQODI_API_KEY) return noqodiPayments;
  return mockPayments;
}

export function paymentsAreLive(): boolean {
  const d = (process.env.PAYMENT_DRIVER ?? "mock").toLowerCase();
  return (d === "network" && Boolean(process.env.NETWORK_API_KEY)) || (d === "noqodi" && Boolean(process.env.NOQODI_API_KEY));
}

export const PAYMENT_DRIVERS: { id: PaymentDriverId; label: string }[] = [
  { id: "mock", label: "Sandbox (test)" },
  { id: "network", label: "Network International (N-Genius)" },
  { id: "noqodi", label: "noqodi" },
];
