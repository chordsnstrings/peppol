import * as React from "react";
import { cn, hueFromString, initials } from "@/lib/utils";

export function Avatar({
  name,
  src,
  size = 36,
  className,
  rounded = "full",
}: {
  name: string;
  src?: string;
  size?: number;
  className?: string;
  rounded?: "full" | "lg";
}) {
  const hue = hueFromString(name);
  return (
    <div
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden font-semibold text-white",
        rounded === "full" ? "rounded-full" : "rounded-lg",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: src
          ? undefined
          : `linear-gradient(135deg, hsl(${hue} 55% 45%), hsl(${(hue + 40) % 360} 58% 38%))`,
      }}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={name} className="h-full w-full object-cover" />
      ) : (
        <span>{initials(name)}</span>
      )}
    </div>
  );
}
