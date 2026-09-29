import * as React from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { useTrustedPrompt } from "@/overlay/trusted-prompts";

/**
 * A self-contained, modal blocking overlay — intentionally NOT the radix
 * `Dialog` (which ships a close "X" and closes on outside-click). Preflight's
 * fatal case and feature 0002's terminal "out of memory" dialog both need a
 * modal the user cannot dismiss except via an explicit action button, so this
 * presentational component owns the whole overlay.
 */
export interface BlockingReason {
  title: string;
  detail: string;
}

export interface BlockingAction {
  label: string;
  onClick: () => void;
  variant?: ButtonProps["variant"];
}

export function BlockingDialog({
  title,
  description,
  reasons = [],
  primary,
  secondary,
}: {
  title: string;
  description?: string;
  reasons?: BlockingReason[];
  /** Right-most button (e.g. the "Try anyway" escape hatch). */
  primary?: BlockingAction;
  /** Left-of-primary button. */
  secondary?: BlockingAction;
}) {
  useTrustedPrompt(true);
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
    >
      <div className="w-full max-w-lg rounded-lg border bg-background p-6 shadow-lg">
        <h2 className="text-lg font-semibold leading-none tracking-tight">{title}</h2>
        {description && (
          <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        )}

        {reasons.length > 0 && (
          <ul className="mt-4 space-y-2 text-sm">
            {reasons.map((r) => (
              <li key={r.title} className="rounded-md border border-border/60 p-3">
                <div className="font-medium">{r.title}</div>
                <div className="text-muted-foreground">{r.detail}</div>
              </li>
            ))}
          </ul>
        )}

        {(primary || secondary) && (
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            {secondary && (
              <Button variant={secondary.variant ?? "outline"} onClick={secondary.onClick}>
                {secondary.label}
              </Button>
            )}
            {primary && (
              <Button variant={primary.variant ?? "default"} onClick={primary.onClick}>
                {primary.label}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
