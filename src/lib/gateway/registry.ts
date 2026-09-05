import type { PeppolGatewayPort } from "./port";
import { mockGateway } from "./mock-gateway";
import { taxillaGateway } from "./taxilla-gateway";

/**
 * The drivers that actually put a document on the network. Everything else —
 * the mock today, any future replay or fixture driver — produces its outcome
 * in-process, so the list is written as an allowlist: a driver is a rehearsal
 * until it is named here.
 */
const LIVE_DRIVERS = new Set(["taxilla"]);

/**
 * Resolve the active Peppol gateway from config. Defaults to the mock gateway so
 * the product runs credential-free; set GATEWAY_DRIVER=taxilla (+ TAXILLA_* env)
 * to route real transmissions through the partner ASP.
 */
export function getGateway(): PeppolGatewayPort {
  const driver = (process.env.GATEWAY_DRIVER ?? "mock").toLowerCase();
  if (driver === "taxilla" && process.env.TAXILLA_BASE_URL) return taxillaGateway;
  return mockGateway;
}

/** Whether a live gateway is configured (drives sandbox vs live send behaviour). */
export function gatewayIsLive(): boolean {
  return (process.env.GATEWAY_DRIVER ?? "mock").toLowerCase() === "taxilla" && Boolean(process.env.TAXILLA_BASE_URL);
}

/**
 * The one question the rest of the product asks about a transmission: was it
 * real, or a rehearsal?
 *
 * Called with the `driver` recorded on a Transmission row, it answers for that
 * document — which is what an evidence bundle needs, because a bundle generated
 * after the deployment went live must still describe the send as it happened.
 * Called with nothing, it answers for a send made right now, which is what the
 * activation interlock and the send pipeline need.
 *
 * It fails closed in both directions: an unrecognised driver, and a half-set
 * configuration (GATEWAY_DRIVER=taxilla with no TAXILLA_BASE_URL, which
 * getGateway() silently resolves back to the mock), both count as simulated.
 * Claiming a rehearsal was real is the failure that costs somebody a penalty;
 * claiming a real send was a rehearsal only costs them a second look.
 */
export function isSimulatedTransmission(driver?: string | null): boolean {
  if (driver == null) return !gatewayIsLive();
  return !LIVE_DRIVERS.has(driver.toLowerCase());
}
