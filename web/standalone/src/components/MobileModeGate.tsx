import * as React from "react";
import { useSearchParams } from "react-router-dom";
import { Eye, Loader2, MessageSquare, PencilRuler } from "lucide-react";
import type { ProjectAccess, Tool } from "@pcbjam/shared";
import { isMobileMode } from "@/lib/mobile-mode";
import { requestedMode, type SessionMode } from "@/lib/read-only-mode";
import {
  mobileModeGateDecision,
  rememberMobileMode,
  rememberedMobileMode,
} from "@/lib/mobile-mode-choice";

/**
 * Mobile session-mode gate (mobile 0002). Sits between the boot payload and
 * WasmTool: on a phone/tablet a WRITER picks "view only", "comment only" or
 * the full editor BEFORE the wasm boots (the lighter modes skip every
 * outbound writer and lock the frame — see lib/read-only-mode). The choice is
 * written to the URL as `?mode=` (replace, so back still leaves the editor)
 * and the ToolPage resolvers pick it up on the next render; "remember on this
 * device" also stores it so later opens apply it without asking. Everyone
 * the server already narrowed passes straight through.
 */
export function MobileModeGate({
  access,
  tool,
  children,
}: {
  access: ProjectAccess | undefined;
  tool: Tool;
  children: React.ReactNode;
}) {
  const [search, setSearchParams] = useSearchParams();
  const requested = requestedMode({ location: { search: `?${search.toString()}` } });
  const decision = React.useMemo(
    () =>
      mobileModeGateDecision({
        mobile: isMobileMode(),
        access,
        requested,
        remembered: rememberedMobileMode(),
      }),
    [access, requested],
  );

  const choose = React.useCallback(
    (mode: SessionMode, remember: boolean) => {
      if (remember) rememberMobileMode(mode);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("mode", mode);
          next.delete("readonly"); // superseded alias
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // A remembered choice: apply silently (the URL update re-renders us into
  // the pass branch).
  React.useEffect(() => {
    if (decision.kind === "apply") choose(decision.mode, false);
  }, [decision, choose]);

  if (decision.kind === "pass") return <>{children}</>;
  if (decision.kind === "apply") {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-3 bg-[#1a1a2e] text-white">
        <Loader2 className="animate-spin" size={32} />
        <p className="font-mono text-sm text-white/80">Loading project…</p>
      </div>
    );
  }
  return <MobileModeDialog tool={tool} onChoose={choose} />;
}

/** Comments exist on boards and schematics only; other tools skip the option. */
function commentsAvailable(tool: Tool): boolean {
  return tool === "pcbnew" || tool === "eeschema";
}

function MobileModeDialog({
  tool,
  onChoose,
}: {
  tool: Tool;
  onChoose: (mode: SessionMode, remember: boolean) => void;
}) {
  const [remember, setRemember] = React.useState(false);
  const options: {
    mode: SessionMode;
    icon: React.ReactNode;
    title: string;
    detail: string;
  }[] = [
    {
      mode: "view",
      icon: <Eye size={20} />,
      title: "View only",
      detail: "Zoom, pan and inspect. Nothing can change by accident.",
    },
    ...(commentsAvailable(tool)
      ? [
          {
            mode: "comment" as const,
            icon: <MessageSquare size={20} />,
            title: "Comment only",
            detail: "View only, plus leave comments for the team.",
          },
        ]
      : []),
    {
      mode: "edit",
      icon: <PencilRuler size={20} />,
      title: "Full editor",
      detail: "Everything, as on a desktop. Heavier, and easy to nudge things on a touch screen.",
    },
  ];
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="mobile-mode-title"
      data-testid="mobile-mode-gate"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#1a1a2e] p-4"
    >
      <div className="w-full max-w-md rounded-lg border bg-background p-5 shadow-lg">
        <h2 id="mobile-mode-title" className="text-lg font-semibold leading-tight tracking-tight">
          You're on a phone or tablet
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Pick how to open this file. You can change it later from the session menu.
        </p>
        <div className="mt-4 flex flex-col gap-2">
          {options.map((o) => (
            <button
              key={o.mode}
              type="button"
              data-testid={`mobile-mode-${o.mode}`}
              onClick={() => onChoose(o.mode, remember)}
              className="flex items-start gap-3 rounded-md border p-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span className="mt-0.5 shrink-0 text-muted-foreground">{o.icon}</span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{o.title}</span>
                <span className="block text-xs text-muted-foreground">{o.detail}</span>
              </span>
            </button>
          ))}
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            data-testid="mobile-mode-remember"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="h-4 w-4"
          />
          Remember on this device
        </label>
      </div>
    </div>
  );
}
