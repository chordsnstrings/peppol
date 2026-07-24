"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  invalid?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, leading, trailing, invalid, ...props }, ref) => {
    if (leading || trailing) {
      return (
        <div
          className={cn(
            "flex h-10 items-center gap-2 rounded-lg border border-input bg-background px-3 text-sm transition-shadow",
            "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 ring-offset-background",
            invalid && "border-destructive focus-within:ring-destructive",
            className,
          )}
        >
          {leading && <span className="text-muted-foreground [&_svg]:size-4">{leading}</span>}
          <input
            ref={ref}
            type={type}
            className="h-full w-full bg-transparent outline-none placeholder:text-muted-foreground/70 tnum"
            {...props}
          />
          {trailing && <span className="text-muted-foreground [&_svg]:size-4">{trailing}</span>}
        </div>
      );
    }
    return (
      <input
        ref={ref}
        type={type}
        className={cn(
          "flex h-10 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm transition-shadow",
          "placeholder:text-muted-foreground/70 focus-ring",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium",
          "disabled:cursor-not-allowed disabled:opacity-50",
          invalid && "border-destructive focus-visible:ring-destructive",
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "flex min-h-[80px] w-full rounded-lg border border-input bg-background px-3 py-2 text-sm transition-shadow",
      "placeholder:text-muted-foreground/70 focus-ring disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

export const Label = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement> & { hint?: string; required?: boolean }
>(({ className, children, hint, required, ...props }, ref) => (
  <label
    ref={ref}
    className={cn("flex items-center gap-1.5 text-sm font-medium text-foreground", className)}
    {...props}
  >
    {children}
    {required && <span className="text-destructive">*</span>}
    {hint && <span className="font-normal text-muted-foreground">· {hint}</span>}
  </label>
));
Label.displayName = "Label";

/** A labelled field wrapper with optional error/help text. */
export function Field({
  label,
  htmlFor,
  required,
  hint,
  error,
  help,
  children,
  className,
}: {
  label?: string;
  htmlFor?: string;
  required?: boolean;
  hint?: string;
  error?: string;
  help?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <Label htmlFor={htmlFor} required={required} hint={hint}>
          {label}
        </Label>
      )}
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : help ? (
        <p className="text-xs text-muted-foreground">{help}</p>
      ) : null}
    </div>
  );
}
