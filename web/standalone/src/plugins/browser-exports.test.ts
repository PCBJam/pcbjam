import { describe, expect, it } from 'vitest';
import { exportOptionWords } from './browser-exports';

// The words must be the ones the server builds for the same options: both paths
// hand them to the same parser in KiCad (wasm/bindings/fab_export.h).
describe('exportOptionWords', () => {
  it('every option becomes its kicad_tools word, gerbers first', () => {
    expect(exportOptionWords({
      gerbers: { layers: ['F.Cu', 'B.Cu', 'F.SilkS', 'Edge.Cuts', 'Margin'], canonicalNames: true, protelExtensions: false, jobFile: false, zeroMaskExpansion: true, zeroMaskMinWidth: true, precision: 6 },
      drill: { separatePlated: true, minimalHeader: true, routeOvalHoles: true },
    })).toEqual([
      '--layers', 'F.Cu,B.Cu,F.SilkS,Edge.Cuts,Margin',
      '--canonical-names',
      '--no-protel-ext',
      '--no-job-file',
      '--zero-mask-expansion',
      '--zero-mask-min-width',
      '--precision', '6',
      '--separate-plated',
      '--minimal-header',
      '--route-oval-holes',
    ]);
  });

  it('an option left at its default adds no word; no options, no words', () => {
    expect(exportOptionWords({
      gerbers: { canonicalNames: false, protelExtensions: true, jobFile: true, zeroMaskExpansion: false, zeroMaskMinWidth: false },
      drill: { separatePlated: false, minimalHeader: false, routeOvalHoles: false },
    })).toEqual([]);
    expect(exportOptionWords({})).toEqual([]);
    expect(exportOptionWords(undefined)).toEqual([]);
  });

  it('precision 5 is said, as the server says it', () => {
    expect(exportOptionWords({ gerbers: { precision: 5 } })).toEqual(['--precision', '5']);
  });
});
