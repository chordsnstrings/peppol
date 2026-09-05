"use client";

import * as React from "react";

/**
 * Asking a question without window.prompt or window.confirm.
 *
 * Thirteen screens used the natives, and every one of them was asking for
 * something the ledger then relied on — the reason a payment run was
 * cancelled, who prepared it, why a claim was rejected. The natives are wrong
 * for that in five ways at once, and the last two are the ones that matter:
 *
 *   they cannot validate, so "why?" accepts a single space and the record
 *   carries it;
 *   they cannot say what will happen, only ask;
 *   they are unstyled, so a destructive action looks the same as a routine one;
 *   they block the main thread, so nothing else on the page can respond;
 *   and they cannot be translated, which for an Arabic-first product is not a
 *   detail.
 *
 * This asks in the page instead. It is deliberately one small component rather
 * than a dialog system: every call site here is the same shape — a question, an
 * optional reason, a confirm and a cancel.
 *
 * Focus is moved into the dialog on open and returned to whatever opened it on
 * close, because a keyboard user who is dropped back at the top of a
 * forty-row table has lost their place. Escape cancels. The backdrop does not,
 * deliberately: a stray click should not discard a typed reason.
 */

export interface AskOptions {
  title: string;
  /** What will happen. Shown above the field; this is the part the natives could not do. */
  detail?: string;
  /** Ask for a reason. Omit for a plain confirmation. */
  reason?: {
    label: string;
    placeholder?: string;
    /** Below this many non-blank characters the confirm stays disabled. */
    minLength?: number;
    /** Why it is being asked, in one line under the field. */
    hint?: string;
  };
  confirmLabel?: string;
  cancelLabel?: string;
  /** Draws the confirm as destructive. */
  destructive?: boolean;
}

type Pending = AskOptions & { resolve: (value: string | null) => void };

const AskContext = React.createContext<((o: AskOptions) => Promise<string | null>) | null>(null);

/**
 * `ask` resolves to the typed reason, to an empty string for a plain
 * confirmation, or to null when the person cancels — the same contract
 * window.prompt had, so a call site converts without changing its logic.
 */
export function useAsk() {
  const ctx = React.useContext(AskContext);
  if (!ctx) throw new Error("useAsk needs an <AskProvider> above it.");
  return ctx;
}

export function AskProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = React.useState<Pending | null>(null);

  const ask = React.useCallback(
    (o: AskOptions) => new Promise<string | null>((resolve) => setPending({ ...o, resolve })),
    [],
  );

  return (
    <AskContext.Provider value={ask}>
      {children}
      {pending && (
        <AskDialog
          key={pending.title}
          options={pending}
          onDone={(value) => { pending.resolve(value); setPending(null); }}
        />
      )}
    </AskContext.Provider>
  );
}

function AskDialog({ options, onDone }: { options: AskOptions; onDone: (v: string | null) => void }) {
  const [value, setValue] = React.useState("");
  const fieldRef = React.useRef<HTMLTextAreaElement | null>(null);
  const confirmRef = React.useRef<HTMLButtonElement | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const opener = React.useRef<HTMLElement | null>(null);

  const min = options.reason?.minLength ?? 4;
  const enough = !options.reason || value.trim().length >= min;

  React.useEffect(() => {
    opener.current = document.activeElement as HTMLElement | null;
    // The field where there is one, otherwise the confirm — never the cancel,
    // which would make Enter dismiss a question somebody has not read.
    (options.reason ? fieldRef.current : confirmRef.current)?.focus();
    return () => opener.current?.focus?.();
  }, [options.reason]);

  // Escape cancels; Tab is trapped, so focus cannot wander behind the dialog to
  // the very controls it is asking about.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onDone(null); return; }
    if (e.key !== "Tab") return;
    const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
      "button:not([disabled]), textarea, input, [href], select",
    );
    if (!focusable?.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return (
    <div
      className="sw-scrim"
      role="presentation"
      // Deliberately no onClick: a stray click on the backdrop should not
      // discard a reason somebody has typed.
      onKeyDown={onKeyDown}
    >
      <div
        ref={panelRef}
        className="sw-panel sw-ask"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sw-ask-title"
        aria-describedby={options.detail ? "sw-ask-detail" : undefined}
        data-testid="ask-dialog"
      >
        <h2 id="sw-ask-title" className="sw-ask-title">{options.title}</h2>
        {options.detail && (
          <p id="sw-ask-detail" className="sw-sub sw-ask-detail">{options.detail}</p>
        )}

        {options.reason && (
          <label className="sw-ask-field">
            <span className="sw-label">{options.reason.label}</span>
            <textarea
              ref={fieldRef}
              className="sw-input sw-ask-input"
              rows={3}
              value={value}
              placeholder={options.reason.placeholder}
              onChange={(e) => setValue(e.target.value)}
              aria-describedby="sw-ask-hint"
            />
            <span id="sw-ask-hint" className="sw-sub">
              {options.reason.hint ??
                `At least ${min} characters. Whoever reads this record later has only what is written here.`}
            </span>
          </label>
        )}

        <div className="sw-ask-actions">
          <button type="button" className="sw-btn" onClick={() => onDone(null)} data-testid="ask-cancel">
            {options.cancelLabel ?? "Cancel"}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={options.destructive ? "sw-btn sw-btn-danger" : "sw-btn sw-btn-primary"}
            disabled={!enough}
            onClick={() => onDone(options.reason ? value.trim() : "")}
            data-testid="ask-confirm"
          >
            {options.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
