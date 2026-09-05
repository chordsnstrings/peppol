/**
 * What the product is allowed to say about a transmission a simulator produced.
 *
 * The mock driver invents terminal success on both legs — exchange accepted, C2
 * reporting accepted — without opening a socket, and the pipeline reads that as
 * COMPLETED. Every sentence a user then sees about that send has to carry the
 * fact, because one qualifier among five confident ones reads as a detail
 * rather than a warning: what a person remembers is "delivered & reported", not
 * the single parenthesis that said otherwise.
 *
 * The receiving half is here for the same reason and reads the same way: a
 * document the simulator delivered was sent by nobody, and a decision it
 * "transmitted" reached nobody. What differs is only which claim is being
 * corrected, which is why an arrival gets its own sentence rather than the
 * send's.
 *
 * The strings live in one place so the send pipeline, the receiver, the API
 * routes and the browser quote the same words, and so that changing what the
 * product claims is a one-file change somebody can review.
 *
 * This module must stay free of Node imports and of process.env: client
 * components import it, and registry.ts (which reads the environment and pulls
 * in both drivers) can never cross into the browser bundle.
 */

/** Exactly what a deployer has to set before anything can leave the machine. */
export const LIVE_GATEWAY_ENV = "GATEWAY_DRIVER=taxilla and TAXILLA_BASE_URL";

/** The instruction that follows every refusal, so the reason is also a fix. */
export const LIVE_GATEWAY_SETUP = `Set ${LIVE_GATEWAY_ENV} on the server to transmit for real.`;

/** Short enough for a chip or a badge beside a status the simulator produced. */
export const SIMULATED_LABEL = "Simulated";

/** Said before a send, while the user can still decide not to make it. */
export const SIMULATED_SEND_WARNING =
  "This deployment's gateway driver is a simulator. Nothing will reach the Peppol network or the FTA — the acceptance shown afterwards is one this deployment writes itself.";

/** Said after a send, wherever its outcome is reported. */
export const SIMULATED_SEND_NOTE =
  "This deployment's gateway driver is a simulator: it produced this outcome itself. Nothing was transmitted to the Peppol network and nothing was reported to the FTA.";

/**
 * Said when the network preflight came back negative on a simulated gateway.
 * "Not registered on the network" is a claim about the SMP directory, and the
 * mock answers it from a regular expression without asking any directory.
 */
export const SIMULATED_PREFLIGHT_NOTE =
  "The simulated gateway found no registration for this buyer. Nothing was looked up on the real Peppol network.";

/** Why the activation control is refused, and what would lift the refusal. */
export const SIMULATED_ACTIVATION_BLOCK = `The gateway driver in this deployment is a simulator, so nothing can reach the Peppol network from here. ${LIVE_GATEWAY_SETUP}`;

/**
 * The refusal the send pipeline returns when an entity is marked LIVE on a
 * deployment that cannot transmit. It is a server misconfiguration rather than
 * a bad request, hence the wording aimed at whoever runs the deployment.
 */
export const LIVE_ENTITY_ON_SIMULATOR = `This entity is activated for live transmission, but this deployment's gateway driver is a simulator — a send would be a rehearsal reported as a real filing. ${LIVE_GATEWAY_SETUP}`;

/**
 * The three things an evidence bundle can honestly say about a document. The
 * simulated statement is deliberately blunt: it is read by an auditor, and the
 * one thing it must not do is let a rehearsal pass for a filing.
 */
export const EVIDENCE_STATEMENT = {
  NOT_SENT:
    "This document was never submitted to a gateway. It has not been transmitted to the Peppol network and has not been reported to the FTA.",
  SIMULATED:
    "This document was processed by a simulated gateway driver, which produced its own acceptances in-process. It was NOT transmitted to the Peppol network and NOT reported to the FTA, and no acceptance in this bundle came from the buyer's Access Point or from the FTA. The document and its Tax Data Document below are genuine and were built by the same code a live send uses; the delivery and reporting outcomes are not evidence of anything.",
  TRANSMITTED:
    "This document was submitted through a live gateway driver. The exchange and reporting outcomes below are the ones the gateway reported back.",
} as const;

/* --------------------------------------------------------------- receiving */

/**
 * What may be said about a document the simulator produced rather than the
 * network delivered.
 *
 * `SIMULATED_SEND_NOTE` above covers a send, and it is the wrong sentence for
 * an arrival: "nothing was transmitted" answers a question nobody asked when
 * the thing in front of the reader claims to be an invoice from a supplier. The
 * claim being corrected here is that a supplier sent it.
 */
export const SIMULATED_ARRIVAL_NOTE =
  "This document was produced by this deployment's simulated gateway driver. Nothing arrived from the Peppol network and no supplier sent it.";

/** Said when the driver is real but has no channel for an answer back to the supplier. */
export const RECEIPT_NOT_TRANSMITTED =
  "This deployment's gateway driver has no channel for sending a decision back to the supplier, so the decision is recorded here only. The supplier has not been told.";

/** Said when the channel exists and the gateway refused the answer. */
export const RECEIPT_SEND_FAILED =
  "The gateway did not accept the decision, so the supplier has not been told. The decision is recorded here; send it again once the gateway is reachable.";

/** Said when a driver cannot be asked for post at all. */
export const FETCH_UNSUPPORTED =
  "This deployment's gateway driver cannot be asked for inbound documents. Documents it receives arrive over its webhook instead.";
