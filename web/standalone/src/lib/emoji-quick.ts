/**
 * Quick-react row (comments-ux 0001 D): the user's most-used reaction emoji,
 * seeded with a sensible default set. Usage counts persist per browser; the
 * fixed seed is a starting point, not a limit — anything picked from the full
 * emoji-mart picker joins the rotation.
 */

const KEY = "pcbjam:comment-quick-emoji";
const SEED = ["👍", "❤️", "😄", "🎉", "👀", "✅"];
export const QUICK_ROW_SIZE = 6;

function counts(): Record<string, number> {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).filter(([, n]) => typeof n === "number"),
      ) as Record<string, number>;
    }
  } catch {
    /* private mode / corrupt entry — fall through to seed */
  }
  return {};
}

/** Top emoji by use, seed-filled up to QUICK_ROW_SIZE. */
export function quickEmojis(): string[] {
  const used = Object.entries(counts())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([e]) => e);
  const out = [...used];
  for (const s of SEED) {
    if (out.length >= QUICK_ROW_SIZE) break;
    if (!out.includes(s)) out.push(s);
  }
  return out.slice(0, QUICK_ROW_SIZE);
}

export function noteEmojiUsed(emoji: string): void {
  try {
    const c = counts();
    c[emoji] = (c[emoji] ?? 0) + 1;
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* private mode — quick row just stays the seed */
  }
}
