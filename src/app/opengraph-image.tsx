import { ImageResponse } from "next/og";

export const runtime = "nodejs";
export const alt = "ARKS — UAE e-invoicing. Validate PINT AE, transmit over Peppol, prove FTA reporting.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * Site-wide social card. Inherited by all routes that don't define their own.
 * No external fonts or special glyphs (keeps the build offline-safe — Satori
 * would otherwise try to fetch a Google font for a non-Latin char). Every node
 * with more than one child sets display:flex, as Satori requires.
 */
export default function OgImage() {
  const ink = "#0a0e13";
  const signal = "#23d3a8";
  const soft = "#94a2b1";
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: ink,
          backgroundImage: "radial-gradient(60% 80% at 78% 12%, rgba(35,211,168,0.22), transparent 60%)",
          padding: "72px 80px",
          color: "#eaeef3",
          fontFamily: "sans-serif",
        }}
      >
        {/* brand row */}
        <div style={{ display: "flex", alignItems: "center" }}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 14,
              background: signal,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#05392e",
              fontSize: 34,
              fontWeight: 800,
              marginRight: 18,
            }}
          >
            A
          </div>
          <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: -0.5, marginRight: 12 }}>ARKS</div>
          <div style={{ fontSize: 20, color: soft }}>UAE e-invoicing</div>
        </div>

        {/* headline — each line is a single text child */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 82, fontWeight: 800, lineHeight: 1.04, letterSpacing: -2 }}>
            Reach the FTA in one
          </div>
          <div style={{ fontSize: 82, fontWeight: 800, lineHeight: 1.04, letterSpacing: -2, color: signal }}>
            clean send.
          </div>
          <div style={{ fontSize: 30, color: soft, marginTop: 26, maxWidth: 860 }}>
            Validate PINT AE, transmit over Peppol, prove FTA reporting. Unlimited invoicing.
          </div>
        </div>

        {/* footer facts */}
        <div style={{ display: "flex", alignItems: "center", fontSize: 22, color: soft }}>
          <div style={{ width: 12, height: 12, borderRadius: 6, background: signal, marginRight: 22 }} />
          <div style={{ marginRight: 22 }}>From AED 299/mo</div>
          <div style={{ marginRight: 22, opacity: 0.4 }}>/</div>
          <div style={{ marginRight: 22 }}>14-day free trial</div>
          <div style={{ marginRight: 22, opacity: 0.4 }}>/</div>
          <div>No per-invoice fees</div>
        </div>
      </div>
    ),
    { ...size },
  );
}
