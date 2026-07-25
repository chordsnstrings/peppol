import type { PaymentDriverId, PaymentProviderPort } from "./port";
import { mockPayments } from "./mock";
import { networkPayments } from "./network-international";
import { noqodiPayments } from "./noqodi";

/**
 * Resolve the active payment provider from PAYMENT_DRIVER.
 *
 * Fail-closed: if PAYMENT_DRIVER names a real driver but its credentials are
 * absent (typo/missing env), we THROW rather than silently falling back to the
 * mock driver — a silent fallback would let anyone self-activate a subscription
 * through the unauthenticated mock /pay completion. The mock driver is only
 * selectable in non-production, or when ALLOW_MOCK_PAYMENTS is explicitly set.
 */
export function getPaymentProvider(): PaymentProviderPort {
  const driver = (process.env.PAYMENT_DRIVER ?? "mock").toLowerCase();
  if (driver === "network") {
    if (!process.env.NETWORK_API_KEY) throw new Error("PAYMENT_DRIVER=network but NETWORK_API_KEY is not set");
    return networkPayments;
  }
  if (driver === "noqodi") {
    if (!process.env.NOQODI_API_KEY) throw new Error("PAYMENT_DRIVER=noqodi but NOQODI_API_KEY is not set");
    return noqodiPayments;
  }
  if (driver === "mock") {
    if (process.env.NODE_ENV === "production" && process.env.ALLOW_MOCK_PAYMENTS !== "true") {
      throw new Error("Mock payments are disabled in production. Set PAYMENT_DRIVER=network|noqodi with credentials.");
    }
    return mockPayments;
  }
  throw new Error(`Unknown PAYMENT_DRIVER: ${driver}`);
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
