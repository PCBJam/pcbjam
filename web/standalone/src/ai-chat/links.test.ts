import { describe, expect, it } from 'vitest';
import { fileHref, otherFile } from './links';

const at = { scope: 'acme', project: 'amp', file: 'amp.kicad_sch' };

describe('the "Open it" link (ai-chat 0006 S11)', () => {
  it('offers another schematic or board of this project', () => {
    expect(otherFile({ scope: 'acme', project: 'amp', path: 'sub/power.kicad_sch' }, at)).toBe('sub/power.kicad_sch');
    expect(otherFile({ file: 'amp.kicad_pcb' }, at)).toBe('amp.kicad_pcb');
    expect(otherFile({ path: 'amp.kicad_sch' }, at)).toBeNull();
    expect(otherFile({ scope: 'other', project: 'amp', path: 'x.kicad_sch' }, at)).toBeNull();
    expect(otherFile({ path: 'notes.md' }, at)).toBeNull();
  });

  it.each(['../../../mallory/projects/bait/main.kicad_pcb', '/mallory/projects/bait/main.kicad_pcb', 'a/./b.kicad_sch', 'a//b.kicad_sch', 'a\\..\\b.kicad_sch'])(
    'offers none for the path %s',
    (path) => {
      expect(otherFile({ path }, at)).toBeNull();
    },
  );

  it('keeps only the working copy of the query', () => {
    expect(fileHref(at, 'sub/power one.kicad_sch', '?copy=c-1&tool=pcbnew&x=y')).toBe('/acme/projects/amp/sub/power%20one.kicad_sch?copy=c-1');
    expect(fileHref(at, 'b.kicad_pcb', '')).toBe('/acme/projects/amp/b.kicad_pcb');
  });
});
