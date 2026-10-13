/**
 * A model-supplied string (net name, value) as the inside of a KiCad quoted
 * atom. The agent's input may be steered by text other people wrote (comments,
 * part data), so it never reaches KiCad's parser raw: control characters go,
 * `\` and `"` are escaped (a trailing `\` would otherwise eat the closing quote
 * and turn the rest of the item into structure), and the length is capped.
 */
export function kicadString(text: string, max = 120): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
  return clean.replace(/[\\"]/g, (c) => `\\${c}`);
}
