import * as React from "react";
import type { Collaborator } from "@pcbjam/shared";
import { filterCandidates } from "@/lib/mentions";

/**
 * Text input/textarea with `@`-mention autocomplete (comments-ux 0001 E).
 * Typing `@` at a word start opens a combobox under the field (candidates are
 * fetched lazily on that first keystroke); ↑/↓ navigate, Enter/Tab accept,
 * Esc dismisses (without closing the surrounding popover). Accepting inserts
 * `@slug ` into the plain-text body and reports the slug via `onMention` —
 * no contentEditable, no rich text. Hand-typed `@slug` text is legal too; it
 * just isn't recorded in the message's `mentions` array.
 */

interface ActiveToken {
  start: number; // index of the "@"
  query: string;
}

function activeToken(value: string, caret: number): ActiveToken | null {
  const at = value.lastIndexOf("@", caret - 1);
  if (at < 0) return null;
  // The @ must start a word (start-of-text or after whitespace).
  if (at > 0 && !/\s/.test(value.charAt(at - 1))) return null;
  const between = value.slice(at + 1, caret);
  if (/[\s@]/.test(between)) return null;
  return { start: at, query: between };
}

const MAX_ITEMS = 6;

export function MentionInput({
  value,
  onChange,
  onMention,
  onSubmit,
  getCandidates,
  multiline = false,
  placeholder,
  autoFocus = false,
  className,
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  /** An autocomplete completion was accepted. */
  onMention: (slug: string) => void;
  /** Enter (without Shift, combobox closed). */
  onSubmit?: () => void;
  /** Lazy candidate source — first `@` keystroke triggers it, then cached. */
  getCandidates: () => Promise<Collaborator[]>;
  multiline?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  testId?: string;
}) {
  const [open, setOpen] = React.useState<{
    token: ActiveToken;
    items: Collaborator[];
    sel: number;
  } | null>(null);
  const inputRef = React.useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const candidatesRef = React.useRef<Collaborator[] | null>(null);

  const refresh = (val: string, caret: number) => {
    const token = activeToken(val, caret);
    if (!token) {
      setOpen(null);
      return;
    }
    const apply = (cands: Collaborator[]) => {
      const items = filterCandidates(cands, token.query).slice(0, MAX_ITEMS);
      setOpen(items.length ? { token, items, sel: 0 } : null);
    };
    if (candidatesRef.current) {
      apply(candidatesRef.current);
    } else {
      void getCandidates().then((c) => {
        candidatesRef.current = c;
        // Re-derive against the CURRENT field state — the user kept typing
        // while the roster loaded.
        const el = inputRef.current;
        if (!el) return;
        const now = activeToken(el.value, el.selectionStart ?? el.value.length);
        if (now) {
          const items = filterCandidates(c, now.query).slice(0, MAX_ITEMS);
          setOpen(items.length ? { token: now, items, sel: 0 } : null);
        }
      });
    }
  };

  const accept = (c: Collaborator) => {
    if (!open) return;
    const el = inputRef.current;
    const caret = el?.selectionStart ?? value.length;
    const inserted = `@${c.slug} `;
    const next = value.slice(0, open.token.start) + inserted + value.slice(caret);
    onMention(c.slug);
    onChange(next);
    setOpen(null);
    const pos = open.token.start + inserted.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setOpen({ ...open, sel: (open.sel + d + open.items.length) % open.items.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const item = open.items[open.sel];
        if (item) accept(item);
        return;
      }
      if (e.key === "Escape") {
        // Only dismiss the combobox — not the popover/mode Esc handlers.
        e.preventDefault();
        e.stopPropagation();
        setOpen(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && onSubmit) {
      e.preventDefault();
      onSubmit();
    }
  };

  const onInput = (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    onChange(e.target.value);
    refresh(e.target.value, e.target.selectionStart ?? e.target.value.length);
  };

  const shared = {
    value,
    onChange: onInput,
    onKeyDown,
    placeholder,
    autoFocus,
    className,
    "data-testid": testId,
  };

  return (
    <div className="relative w-full">
      {multiline ? (
        <textarea
          {...shared}
          ref={(el) => {
            inputRef.current = el;
          }}
        />
      ) : (
        <input
          {...shared}
          ref={(el) => {
            inputRef.current = el;
          }}
        />
      )}

      {open && (
        <div
          data-testid="mention-combobox"
          className="absolute left-0 right-0 top-full z-[80] mt-1 overflow-hidden rounded-md bg-white shadow-xl ring-1 ring-black/10 dark:bg-neutral-900 dark:ring-white/15"
        >
          {open.items.map((c, i) => (
            <button
              key={c.slug}
              data-testid="mention-option"
              data-slug={c.slug}
              // pointerdown, not click: the field keeps focus (no blur race).
              onPointerDown={(e) => {
                e.preventDefault();
                accept(c);
              }}
              onPointerEnter={() => setOpen((o) => (o ? { ...o, sel: i } : o))}
              className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-neutral-900 dark:text-white ${
                i === open.sel ? "bg-sky-500/20 dark:bg-sky-600/40" : "hover:bg-black/5 dark:hover:bg-white/10"
              }`}
            >
              {c.image ? (
                <img src={c.image} alt="" className="h-4 w-4 shrink-0 rounded-full" />
              ) : (
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-black/10 text-[9px] uppercase dark:bg-white/15">
                  {(c.name || c.slug).slice(0, 1)}
                </span>
              )}
              <span className="truncate">{c.name}</span>
              <span className="ml-auto truncate text-[10px] text-neutral-400 dark:text-white/40">@{c.slug}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
