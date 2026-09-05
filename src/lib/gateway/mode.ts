"use client";

import * as React from "react";

/**
 * Which gateway a send would actually use, as seen from the browser.
 *
 * The answer lives in server environment (GATEWAY_DRIVER, TAXILLA_BASE_URL) and
 * `registry.ts` reads it — but registry pulls in both drivers and `node:crypto`
 * with them, so a client component cannot import it. The gateway health route
 * already publishes the two facts a screen needs, so this asks it once per page
 * load and shares the answer between the components that ask.
 *
 * `simulated` starts true and stays true if the request fails. A screen that
 * cannot find out whether it is live must not tell anybody it is: the cost of
 * an unnecessary warning is a second look, and the cost of a missing one is a
 * business believing the FTA has a filing it never received.
 */
export interface GatewayMode {
  /** The driver id the server resolved, once known. */
  driver: string | null;
  /** True while a send would be a rehearsal rather than a transmission. */
  simulated: boolean;
  /** False until the server has answered — a control that could be wrong waits. */
  known: boolean;
}

interface GatewayHealthResponse {
  driver?: string;
  live?: boolean;
}

/**
 * One request per page load, shared by every caller. The dashboard card, the
 * invoice editor and settings can all be mounted at once, and the health check
 * reaches the partner ASP when one is configured.
 */
let pending: Promise<GatewayHealthResponse> | null = null;

function loadGatewayHealth(): Promise<GatewayHealthResponse> {
  pending ??= fetch("/api/gateway/health", { credentials: "same-origin" })
    .then((res) => (res.ok ? (res.json() as Promise<GatewayHealthResponse>) : { live: false }))
    .catch(() => ({ live: false }));
  return pending;
}

export function useGatewayMode(): GatewayMode {
  const [mode, setMode] = React.useState<GatewayMode>({ driver: null, simulated: true, known: false });

  React.useEffect(() => {
    let live = true;
    loadGatewayHealth().then((res) => {
      if (live) setMode({ driver: res.driver ?? null, simulated: res.live !== true, known: true });
    });
    return () => {
      live = false;
    };
  }, []);

  return mode;
}
