"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Lock, ShieldCheck, CreditCard, Loader2 } from "lucide-react";
import { formatMoney } from "@/lib/domain/money";
import { Logo } from "@/components/shell/logo";
import { Button } from "@/components/ui/button";

interface PayInfo {
  token: string;
  driver: string;
  status: string;
  sellerName: string;
  invoiceNumber: string;
  amountMinor: number;
  currency: string;
  buyerName: string;
}

export default function PayPage() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = React.useState<PayInfo | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [paying, setPaying] = React.useState(false);
  const [done, setDone] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/pay/${token}`);
      if (res.ok) {
        const j = (await res.json()) as PayInfo;
        setInfo(j);
        if (j.status === "PAID") setDone(true);
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  React.useEffect(() => {
    load();
  }, [load]);

  const pay = async () => {
    setPaying(true);
    try {
      const res = await fetch(`/api/pay/${token}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome: "success" }),
      });
      if (res.ok) setDone(true);
    } finally {
      setPaying(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-gradient-to-br from-[#12294a] via-[#0b1a2e] to-[#081422] p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <Logo tone="light" />
        </div>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          className="overflow-hidden rounded-2xl bg-white text-[#101828] shadow-2xl"
        >
          {loading ? (
            <div className="flex h-64 items-center justify-center">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : !info ? (
            <div className="p-8 text-center">
              <p className="font-semibold">Payment link not found</p>
              <p className="mt-1 text-sm opacity-60">This link may have expired.</p>
            </div>
          ) : (
            <AnimatePresence mode="wait">
              {done ? (
                <motion.div key="done" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="p-8 text-center">
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", stiffness: 260, damping: 16 }}
                    className="mx-auto flex size-16 items-center justify-center rounded-full bg-emerald-500 text-white"
                  >
                    <Check className="size-9" strokeWidth={3} />
                  </motion.div>
                  <h1 className="mt-5 text-xl font-bold">Payment successful</h1>
                  <p className="mt-1 text-sm opacity-60">
                    {formatMoney(info.amountMinor, info.currency)} paid to {info.sellerName}.
                  </p>
                  <p className="mt-4 text-xs opacity-50">Invoice {info.invoiceNumber} · a receipt has been recorded.</p>
                </motion.div>
              ) : (
                <motion.div key="pay" exit={{ opacity: 0 }}>
                  <div className="border-b border-black/[0.06] p-6">
                    <p className="text-xs font-medium uppercase tracking-wide opacity-50">Pay {info.sellerName}</p>
                    <p className="mt-2 text-3xl font-bold tnum">{formatMoney(info.amountMinor, info.currency)}</p>
                    <p className="mt-1 text-sm opacity-60">Invoice {info.invoiceNumber}</p>
                  </div>
                  <div className="p-6">
                    <div className="rounded-xl border border-black/[0.08] p-4">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <CreditCard className="size-4" /> Card payment
                        {info.driver === "mock" && (
                          <span className="ml-auto rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                            Sandbox
                          </span>
                        )}
                      </div>
                      <p className="mt-2 text-xs opacity-50">
                        {info.driver === "mock"
                          ? "Test mode — no real charge. Live cards process via Network International / noqodi."
                          : "Secured by your payment provider."}
                      </p>
                    </div>
                    <Button size="lg" className="mt-4 w-full !bg-[#0b1a2e] !text-white" loading={paying} onClick={pay}>
                      {!paying && <Lock className="size-4" />}
                      Pay {formatMoney(info.amountMinor, info.currency)}
                    </Button>
                    <p className="mt-3 flex items-center justify-center gap-1.5 text-[11px] opacity-50">
                      <ShieldCheck className="size-3.5" /> Encrypted & PCI-compliant checkout
                    </p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          )}
        </motion.div>
        <p className="mt-5 text-center text-xs text-white/40">Powered by ARKS e-Invoicing</p>
      </div>
    </div>
  );
}
