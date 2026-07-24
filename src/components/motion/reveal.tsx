"use client";

import * as React from "react";
import { motion, type HTMLMotionProps } from "framer-motion";

const easeOut = [0.22, 1, 0.36, 1] as const;

/** Fade + rise in on mount. */
export function Reveal({
  children,
  delay = 0,
  y = 10,
  className,
  ...props
}: {
  children: React.ReactNode;
  delay?: number;
  y?: number;
  className?: string;
} & HTMLMotionProps<"div">) {
  return (
    <motion.div
      initial={{ opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: easeOut, delay }}
      className={className}
      {...props}
    >
      {children}
    </motion.div>
  );
}

/** Stagger container — children use <StaggerItem>. */
export function Stagger({
  children,
  className,
  delayChildren = 0.04,
  staggerChildren = 0.055,
}: {
  children: React.ReactNode;
  className?: string;
  delayChildren?: number;
  staggerChildren?: number;
}) {
  return (
    <motion.div
      className={className}
      initial="hidden"
      animate="show"
      variants={{
        hidden: {},
        show: { transition: { delayChildren, staggerChildren } },
      }}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({
  children,
  className,
  y = 12,
}: {
  children: React.ReactNode;
  className?: string;
  y?: number;
}) {
  return (
    <motion.div
      className={className}
      variants={{
        hidden: { opacity: 0, y },
        show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: easeOut } },
      }}
    >
      {children}
    </motion.div>
  );
}
