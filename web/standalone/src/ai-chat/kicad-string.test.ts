import { describe, expect, it } from 'vitest';
import { kicadString } from './kicad-string';

describe('kicadString', () => {
  it('keeps ordinary net names and values', () => {
    expect(kicadString('+3V3')).toBe('+3V3');
    expect(kicadString('/SDA')).toBe('/SDA');
    expect(kicadString('4.7k')).toBe('4.7k');
  });

  it('escapes what would end the atom early', () => {
    // A trailing backslash must not escape the closing quote.
    expect(kicadString('NET\\')).toBe('NET\\\\');
    expect(`(label "${kicadString('a" (junction (at 0 0)')}"`).toBe('(label "a\\" (junction (at 0 0)"');
  });

  it('drops control characters and caps the length', () => {
    expect(kicadString('A\nB\tC\u0000')).toBe('ABC');
    expect(kicadString('x'.repeat(500))).toHaveLength(120);
  });
});
