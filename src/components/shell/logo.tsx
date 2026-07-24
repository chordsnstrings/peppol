import { cn } from "@/lib/utils";

export function LogoMark({ className, size = 32 }: { className?: string; size?: number }) {
  return (
    <span
      className={cn("relative inline-flex shrink-0 items-center justify-center", className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 512 512" width={size} height={size} className="rounded-[28%]">
        <defs>
          <linearGradient id="lm-bg" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
            <stop stopColor="#12294A" />
            <stop offset="1" stopColor="#0B1A2E" />
          </linearGradient>
          <linearGradient id="lm-gold" x1="150" y1="120" x2="380" y2="400" gradientUnits="userSpaceOnUse">
            <stop stopColor="#E6C978" />
            <stop offset="0.5" stopColor="#C9A84C" />
            <stop offset="1" stopColor="#B08F38" />
          </linearGradient>
        </defs>
        <rect width="512" height="512" rx="140" fill="url(#lm-bg)" />
        <path
          d="M256 108 L360 404 L300 404 L281 346 L231 346 L212 404 L152 404 L256 108 Z M248 232 L248 292 L268 292 L258 262 Z"
          fill="url(#lm-gold)"
        />
        <circle cx="352" cy="150" r="26" fill="url(#lm-gold)" />
        <path
          d="M340 150 l8 9 l16 -18"
          stroke="#0B1A2E"
          strokeWidth="7"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    </span>
  );
}

export function Logo({
  className,
  wordmark = true,
  size = 32,
  tone = "auto",
}: {
  className?: string;
  wordmark?: boolean;
  size?: number;
  tone?: "auto" | "light";
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark size={size} />
      {wordmark && (
        <span className="flex flex-col leading-none">
          <span
            className={cn(
              "font-display text-[15px] font-bold tracking-tight",
              tone === "light" ? "text-white" : "text-foreground",
            )}
          >
            ARKS
          </span>
          <span
            className={cn(
              "text-[10px] font-medium tracking-[0.18em]",
              tone === "light" ? "text-white/50" : "text-muted-foreground",
            )}
          >
            E-INVOICING
          </span>
        </span>
      )}
    </span>
  );
}
