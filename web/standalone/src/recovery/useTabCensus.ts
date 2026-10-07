import * as React from "react";
import { isFirefox, joinCensus, newTabId, takeCensus, type EditorTabInfo } from "./tab-census";

/** Per-session dismissal of the shared-memory notice. */
const DISMISS_KEY = "pcbjam:shared-tabs-notice-dismissed";

export interface SharedTabsNotice {
  tabs: EditorTabInfo[];
}

/**
 * The editor's side of the tab census (standalone-hardening 0009): answer
 * other tabs' pings for the life of the page and, in Firefox, warn once at
 * boot when other editor tabs share this process's memory budget.
 * `otherTabs()` is the on-demand census for the out-of-memory dialog.
 */
export function useTabCensus(tool: string): {
  notice: SharedTabsNotice | null;
  dismissNotice: () => void;
  otherTabs: () => Promise<EditorTabInfo[]>;
} {
  const selfId = React.useMemo(() => newTabId(), []);
  const [notice, setNotice] = React.useState<SharedTabsNotice | null>(null);

  React.useEffect(() => {
    const leave = joinCensus(
      () => ({ tool, title: document.title, url: location.href }),
      { tabId: selfId },
    );
    let cancelled = false;
    if (isFirefox() && !dismissed()) {
      void takeCensus({ selfId }).then((tabs) => {
        if (!cancelled && tabs.length > 0) setNotice({ tabs });
      });
    }
    return () => {
      cancelled = true;
      leave();
    };
  }, [tool, selfId]);

  const dismissNotice = React.useCallback(() => {
    setNotice(null);
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* storage disabled — dismissal lasts for this page only */
    }
  }, []);

  const otherTabs = React.useCallback(() => takeCensus({ selfId }), [selfId]);

  return { notice, dismissNotice, otherTabs };
}

function dismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}
