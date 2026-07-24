import * as React from "react";
import { createPortal } from "react-dom";
import { useThemeValue } from "@/lib/theme";

/**
 * Full emoji picker for comment reactions (comments-ux 0001 D): emoji-mart —
 * categories, search, skin tones, frequently-used — LAZY-LOADED so the picker
 * component and its ~0.5 MB data JSON become their own chunk, fetched on the
 * first "+" click and never in the boot path. The data is bundled locally
 * (no CDN fetch): the standalone must work in offline/@local mode.
 *
 * Reaction CHIPS need none of this — they render native glyphs as plain text.
 */

interface EmojiSelection {
  native?: string;
}

const LazyPicker = React.lazy(async () => {
  const [{ default: data }, { default: Picker }] = await Promise.all([
    import("@emoji-mart/data"),
    import("@emoji-mart/react"),
  ]);

  function PickerWithData(props: { onPick: (emoji: string) => void; theme: "light" | "dark" }) {
    return (
      <Picker
        data={data}
        theme={props.theme}
        previewPosition="none"
        autoFocus
        onEmojiSelect={(e: EmojiSelection) => {
          if (e.native) props.onPick(e.native);
        }}
      />
    );
  }

  return { default: PickerWithData };
});

// emoji-mart's rendered size — used only to clamp the popover into view.
const PICKER_W = 352;
const PICKER_H = 435;

/**
 * Click-away-dismissed full picker, PORTALED to the body at a fixed position
 * (anchor = the trigger's rect): the comment popover's scroll container would
 * clip an absolutely-positioned child, and the picker is bigger than the
 * popover anyway. z-[70]: above the thread popover's deliberate z-[60].
 */
export function EmojiPickerPopover({
  anchor,
  onPick,
  onClose,
}: {
  anchor: { x: number; y: number };
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const theme = useThemeValue();

  React.useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    // Capture phase: emoji-mart's search input consumes Escape (clears the
    // query, stops propagation) before a bubble listener would see it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // The picker is the focused surface: Esc closes IT, not the thread
        // popover underneath (CommentLayer's own window Esc handler).
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      data-testid="emoji-picker"
      className="fixed z-[70]"
      style={{
        left: Math.max(8, Math.min(anchor.x, window.innerWidth - PICKER_W - 8)),
        top: Math.max(8, Math.min(anchor.y + 4, window.innerHeight - PICKER_H - 8)),
      }}
    >
      <React.Suspense
        fallback={
          <div className="rounded-lg bg-white px-3 py-2 text-xs text-neutral-500 shadow-xl ring-1 ring-black/10 dark:bg-neutral-900 dark:text-white/60 dark:ring-white/15">
            Loading emoji…
          </div>
        }
      >
        <LazyPicker onPick={onPick} theme={theme} />
      </React.Suspense>
    </div>,
    document.body,
  );
}
