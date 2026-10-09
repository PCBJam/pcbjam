import * as React from "react";
import { BlockingDialog, type BlockingReason } from "@/preflight/BlockingDialog";
import type { EditorTabInfo } from "./tab-census";
import { Code } from "@pcbjam/ui";

/**
 * Terminal "not enough memory" UI (feature 0002, rewritten for 0009) — shown
 * after the OOM retry chain hits MAX_RETRIES.
 *
 *   - "Restart the editor" (primary): the /recover airlock trip, which leaves
 *     the browser process that ran out instead of reloading inside it.
 *   - "Reload this tab" (secondary): the plain in-place retry.
 *
 * Firefox runs every cross-origin-isolated pcbjam.com page (editor, demo,
 * www demos) in ONE process, so the copy names the open editor tabs (census)
 * and the `about:processes` way of ending just that process. Pages cannot link
 * to about: URLs, hence the copy button.
 */
export function MemoryExhaustedDialog({
  firefox,
  otherTabs,
  onRestart,
  onReload,
}: {
  firefox: boolean;
  otherTabs: EditorTabInfo[];
  onRestart?: () => void;
  onReload?: () => void;
}) {
  const reasons: BlockingReason[] = [];
  if (otherTabs.length > 0) {
    reasons.push({
      title: `Close your other editor tabs (${otherTabs.length} open)`,
      detail: firefox
        ? `Firefox runs all PCBJam editors in one shared process with one memory budget: ${tabList(otherTabs)}.`
        : `Each open editor uses memory: ${tabList(otherTabs)}.`,
    });
  }
  if (firefox) {
    reasons.push({
      title: "End the PCBJam process",
      detail:
        "Close other pcbjam.com tabs, including the demos. If that isn't enough, open about:processes in a new tab, find the row \"https://pcbjam.com (…, cross-origin isolated)\" and end it with its × button. Then restart the editor.",
    });
  } else {
    reasons.push({
      title: "End the PCBJam process",
      detail:
        "Press Shift+Esc to open the browser's task manager, end the PCBJam tab's process, then restart the editor.",
    });
  }
  reasons.push(
    {
      title: "Free up memory",
      detail:
        "Close other tabs and applications, use a machine with more RAM, or open a smaller design.",
    },
    {
      title: "Unsaved changes",
      detail: "Edits that weren't synced to the server yet may be lost.",
    },
  );

  return (
    <BlockingDialog
      title="The editor ran out of memory"
      description="It restarted a few times and ran out of memory again, so it stopped instead of trying forever."
      reasons={reasons}
      primary={onRestart ? { label: "Restart the editor", onClick: onRestart } : undefined}
      secondary={onReload ? { label: "Reload this tab", onClick: onReload } : undefined}
    >
      {firefox && <CopyAboutProcesses />}
    </BlockingDialog>
  );
}

function tabList(tabs: EditorTabInfo[]): string {
  return tabs.map((t) => t.title || t.url).join(", ");
}

function CopyAboutProcesses() {
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="mt-3 flex items-center gap-2 text-sm">
      <Code data-testid="oom-about-processes" className="select-all px-2 py-1">
        about:processes
      </Code>
      <button
        type="button"
        className="rounded border px-2 py-1 text-xs hover:bg-muted"
        onClick={() => {
          navigator.clipboard?.writeText("about:processes").then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
