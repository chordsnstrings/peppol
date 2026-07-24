"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLockBody, useMounted } from "@/hooks/use-ui";
import { Button } from "./button";

function Backdrop({ onClose }: { onClose?: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={onClose}
      className="fixed inset-0 z-50 bg-[hsl(215_50%_4%/0.55)] backdrop-blur-sm"
    />
  );
}

export function Modal({
  open,
  onClose,
  children,
  title,
  description,
  size = "md",
  className,
  hideClose,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: React.ReactNode;
  description?: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
  hideClose?: boolean;
}) {
  const mounted = useMounted();
  useLockBody(open);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted) return null;
  const widths = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" };

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <Backdrop onClose={onClose} />
          <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto p-0 sm:items-center sm:p-6">
            <motion.div
              role="dialog"
              aria-modal="true"
              initial={{ opacity: 0, y: 24, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.98 }}
              transition={{ type: "spring", stiffness: 320, damping: 30 }}
              className={cn(
                "relative z-10 w-full rounded-t-2xl border border-border bg-card shadow-float sm:rounded-2xl",
                widths[size],
                className,
              )}
              onClick={(e) => e.stopPropagation()}
            >
              {(title || !hideClose) && (
                <div className="flex items-start justify-between gap-4 border-b border-border p-5 sm:p-6">
                  <div className="min-w-0">
                    {title && (
                      <h2 className="font-display text-lg font-semibold tracking-tight">{title}</h2>
                    )}
                    {description && (
                      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
                    )}
                  </div>
                  {!hideClose && (
                    <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
                      <X />
                    </Button>
                  )}
                </div>
              )}
              {children}
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export function Sheet({
  open,
  onClose,
  children,
  side = "right",
  className,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  side?: "right" | "left" | "bottom";
  className?: string;
}) {
  const mounted = useMounted();
  useLockBody(open);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted) return null;

  const variants = {
    right: { initial: { x: "100%" }, animate: { x: 0 }, exit: { x: "100%" }, cls: "inset-y-0 end-0 h-full w-[88%] max-w-sm border-s" },
    left: { initial: { x: "-100%" }, animate: { x: 0 }, exit: { x: "-100%" }, cls: "inset-y-0 start-0 h-full w-[88%] max-w-sm border-e" },
    bottom: { initial: { y: "100%" }, animate: { y: 0 }, exit: { y: "100%" }, cls: "inset-x-0 bottom-0 max-h-[85vh] w-full rounded-t-2xl border-t" },
  }[side];

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <Backdrop onClose={onClose} />
          <motion.div
            role="dialog"
            aria-modal="true"
            initial={variants.initial}
            animate={variants.animate}
            exit={variants.exit}
            transition={{ type: "spring", stiffness: 340, damping: 34 }}
            className={cn(
              "fixed z-50 overflow-y-auto border-border bg-card shadow-float",
              variants.cls,
              className,
            )}
          >
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirm",
  tone = "primary",
  loading,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  tone?: "primary" | "destructive";
  loading?: boolean;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm">
      <div className="p-5 sm:p-6">
        {description && <div className="text-sm text-muted-foreground">{description}</div>}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button variant={tone} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
