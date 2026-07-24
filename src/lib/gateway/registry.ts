import type { PeppolGatewayPort } from "./port";
import { mockGateway } from "./mock-gateway";
import { taxillaGateway } from "./taxilla-gateway";

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
