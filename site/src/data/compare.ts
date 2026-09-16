/**
 * Comparison data for /compare and /compare/<competitor>.
 *
 * Every competitor cell was checked against the vendor's own pages on
 * CHECKED_ON; the URLs are in `sources` and render on the page. Rule for
 * edits: only state what an official page or one of our own devblogs says.
 * If a fact cannot be sourced, leave it out rather than guess. Prices and
 * Apple's Safari schedule go stale first — re-check them before a redeploy.
 */

export const CHECKED_ON = '3 September 2026';

export type Tone = 'yes' | 'part' | 'no' | 'info';
export type ColKey = 'pcbjam' | 'kicad' | 'easyeda' | 'flux';

export interface Cell {
  tone: Tone;
  note: string;
}

export interface Row {
  label: string;
  cells: Record<ColKey, Cell>;
}

export interface Source {
  label: string;
  url: string;
}

export interface Competitor {
  slug: 'kicad' | 'easyeda' | 'flux';
  name: string;
  /** Short label for the switcher. */
  tab: string;
  /** <title> for the pair page (must contain "PCBJam" — see BaseLayout). */
  title: string;
  description: string;
  lead: string;
  pickThem: string;
  pickUs: string;
  sources: Source[];
}

export const columnNames: Record<ColKey, string> = {
  pcbjam: 'PCBJam',
  kicad: 'KiCad',
  easyeda: 'EasyEDA',
  flux: 'Flux',
};

export const competitors: Competitor[] = [
  {
    slug: 'kicad',
    name: 'KiCad',
    tab: 'KiCad (desktop)',
    title: 'PCBJam vs KiCad: the same KiCad, in the browser',
    description:
      'PCBJam is KiCad compiled to WebAssembly: the same editors and the same files, running in a browser, with several people in one board. Where the two differ, checked against the docs.',
    lead: 'Same editors, same files, same shortcuts. The difference is where it runs and how many people can be in the board at once. This is not either-or: PCBJam reads and writes the files desktop KiCad does.',
    pickThem:
      'You work alone, you need to work offline, or you depend on KiCad’s Python plugins. KiCad is free, open source and runs on your own machine.',
    pickUs:
      'You want the KiCad you already know with your team in the same board, nothing to install, and a link instead of a zip when someone needs to look at a design.',
    sources: [
      { label: 'KiCad licenses', url: 'https://www.kicad.org/about/licenses/' },
      { label: 'KiCad 10.0.0 release', url: 'https://www.kicad.org/blog/2026/03/Version-10.0.0-Released/' },
      { label: 'KiCad downloads', url: 'https://www.kicad.org/download/' },
    ],
  },
  {
    slug: 'easyeda',
    name: 'EasyEDA',
    tab: 'EasyEDA',
    title: 'PCBJam vs EasyEDA',
    description:
      'Both run in a browser and both are free to use. EasyEDA is built around the LCSC catalogue in its own format; PCBJam is KiCad, with files you can take anywhere. Thirteen criteria, checked against the vendors’ docs.',
    lead: 'Both run in a browser and both are free to use. EasyEDA is built around the LCSC catalogue and ordering from JLCPCB, in its own format; PCBJam is KiCad, with files you can take anywhere.',
    pickThem:
      'You order from JLCPCB and the LCSC catalogue is your parts bin, and EasyEDA’s own file format is fine for you.',
    pickUs:
      'You want KiCad’s editors and KiCad’s file format, so you can move between desktop KiCad and the browser at any time, with your team in the board.',
    sources: [
      { label: 'EasyEDA pricing', url: 'https://easyeda.com/page/pricing' },
      { label: 'EasyEDA Pro: import KiCad', url: 'https://prodocs.easyeda.com/en/import-export/import-kicad/' },
      { label: 'EasyEDA Std: import KiCad', url: 'https://docs.easyeda.com/en/Import/Import-KiCAD/' },
      { label: 'EasyEDA Pro 3.0 release notes', url: 'https://prodocs.easyeda.com/en/release-note/v3.0.x/' },
      { label: 'EasyEDA Pro: project collaboration', url: 'https://prodocs.easyeda.com/en/project/project-collaboration/' },
      { label: 'EasyEDA Pro: desktop client', url: 'https://prodocs.easyeda.com/en/faq/client/' },
      { label: 'EasyEDA Pro: extension API', url: 'https://prodocs.easyeda.com/en/api/guide/' },
      { label: 'EasyEDA Pro: simulation', url: 'https://prodocs.easyeda.com/en/simulation/introduction/' },
      { label: 'EasyEDA mobile viewer', url: 'https://easyeda.com/editor-mobile/' },
      { label: 'KiCad: importing EasyEDA projects', url: 'https://dev-docs.kicad.org/en/import-formats/easyeda/index.html' },
    ],
  },
  {
    slug: 'flux',
    name: 'Flux',
    tab: 'Flux',
    title: 'PCBJam vs Flux',
    description:
      'Both are browser-based and collaborative. Flux is its own editor with an AI copilot and a proprietary format on a subscription; PCBJam is the real KiCad engine with KiCad’s files and a free tier. Checked against the vendors’ docs.',
    lead: 'Both are browser-based and collaborative. Flux is its own editor with an AI copilot and a proprietary format; PCBJam is the real KiCad engine with KiCad’s own files.',
    pickThem:
      'AI assistance is the point for you, and a proprietary format plus a subscription from $50 a month is an acceptable trade.',
    pickUs:
      'You want the KiCad you know, open files and a free tier, with real-time collaboration.',
    sources: [
      { label: 'Flux pricing', url: 'https://www.flux.ai/p/pricing' },
      { label: 'Flux: importing KiCad components', url: 'https://docs.flux.ai/reference/reference-import-kicad' },
      { label: 'Flux: collaboration', url: 'https://docs.flux.ai/tutorials/tutorial-collaboration-deep-dive' },
      { label: 'Flux: how the API works', url: 'https://docs.flux.ai/reference/how-the-api-works' },
      { label: 'Flux: the simulator', url: 'https://docs.flux.ai/flux-beta/Introduction/the-simulator' },
      { label: 'Flux: not available on mobile', url: 'https://feedback.flux.ai/bugreports/p/sign-in-on-mobile-leads-to-beta-application' },
    ],
  },
];

export const pcbjamSources: Source[] = [
  { label: 'Devblog week 28: collaboration, presence, comments, mobile view', url: '/blog/devblog-2026-w28/' },
  { label: 'Devblog week 29: ngspice in WebAssembly', url: '/blog/devblog-2026-w29/' },
  { label: 'Devblog week 30: comment threads, reactions, mentions', url: '/blog/devblog-2026-w30/' },
  { label: 'Devblog weeks 32 to 35: the JSPI switch and Safari', url: '/blog/devblog-2026-w32-35/' },
  { label: 'PCBJam pricing', url: '/pricing/' },
  { label: 'PCBJam on GitHub (GPL-3.0)', url: 'https://github.com/emergence-engineering/pcbjam' },
];

const SAFARI =
  'Chromium browsers and Firefox. Safari, iPhone and iPad wait on a WebAssembly feature (JSPI) that Apple has scheduled for its September 2026 Safari release.';

export const rows: Row[] = [
  {
    label: 'Runs in the browser, nothing to install',
    cells: {
      pcbjam: { tone: 'part', note: SAFARI },
      kicad: { tone: 'no', note: 'an install on Windows, macOS or Linux' },
      easyeda: { tone: 'yes', note: 'browser, or a desktop client' },
      flux: { tone: 'yes', note: 'desktop browsers' },
    },
  },
  {
    label: 'It is KiCad: the same editors, shortcuts and libraries',
    cells: {
      pcbjam: { tone: 'yes', note: 'the KiCad engine compiled to WebAssembly' },
      kicad: { tone: 'yes', note: '' },
      easyeda: { tone: 'no', note: 'its own editor' },
      flux: { tone: 'no', note: 'its own editor' },
    },
  },
  {
    label: 'An open file format you can take anywhere',
    cells: {
      pcbjam: { tone: 'yes', note: '.kicad_pro, .kicad_sch and .kicad_pcb; import and export at any time' },
      kicad: { tone: 'yes', note: 'the same files' },
      easyeda: {
        tone: 'part',
        note: 'its own format. Imports KiCad 5-era files only; no export to KiCad, though KiCad’s own importer reads EasyEDA projects',
      },
      flux: {
        tone: 'part',
        note: 'its own format. Imports KiCad parts and libraries, not schematics or boards; no export to KiCad',
      },
    },
  },
  {
    label: 'Several people in one board at the same time',
    cells: {
      pcbjam: { tone: 'yes', note: 'live cursors, selection highlights, follow a teammate' },
      kicad: { tone: 'no', note: 'no built-in collaboration' },
      easyeda: {
        tone: 'yes',
        note: 'since EasyEDA Pro 3.0 (June 2026): the same document at once, with history and rollback',
      },
      flux: { tone: 'yes', note: 'real-time multiplayer' },
    },
  },
  {
    label: 'Review by link and comments, nothing to install for the reviewer',
    cells: {
      pcbjam: { tone: 'yes', note: 'invite links; reader and commenter roles; comment threads with mentions' },
      kicad: { tone: 'no', note: 'send the files, or use a third-party viewer' },
      easyeda: { tone: 'part', note: 'member roles including an observer role; public projects' },
      flux: { tone: 'yes', note: 'share the URL, permissions, comments on the design' },
    },
  },
  {
    label: 'Open a board on a phone or tablet',
    cells: {
      pcbjam: {
        tone: 'part',
        note: 'a touch-friendly read-only view on mobile, except iPhone and iPad until the Safari release above; mobile editing is on the roadmap',
      },
      kicad: { tone: 'no', note: '' },
      easyeda: { tone: 'part', note: 'a limited mobile viewer' },
      flux: { tone: 'no', note: 'desktop browsers only' },
    },
  },
  {
    label: 'Schematic, layout, DRC, 3D and Gerber export',
    cells: {
      pcbjam: { tone: 'yes', note: 'the full KiCad flow' },
      kicad: { tone: 'yes', note: '' },
      easyeda: { tone: 'yes', note: '' },
      flux: { tone: 'yes', note: '' },
    },
  },
  {
    label: 'Circuit simulation',
    cells: {
      pcbjam: { tone: 'yes', note: 'ngspice runs in the browser; XSPICE and CIDER work' },
      kicad: { tone: 'yes', note: 'ngspice, built in' },
      easyeda: { tone: 'yes', note: 'NGSpice, plus SimulIDE in Pro' },
      flux: { tone: 'yes', note: 'built in' },
    },
  },
  {
    label: 'Plugins and extensions',
    cells: {
      pcbjam: { tone: 'part', note: 'custom extensions are on the roadmap' },
      kicad: { tone: 'yes', note: 'Python API and a plugin manager' },
      easyeda: { tone: 'yes', note: 'Pro extension API and a marketplace' },
      flux: { tone: 'part', note: 'an API for integrations' },
    },
  },
  {
    label: 'Component libraries',
    cells: {
      pcbjam: { tone: 'yes', note: 'KiCad’s libraries, plus libraries shared inside a team' },
      kicad: { tone: 'yes', note: 'the official libraries' },
      easyeda: { tone: 'yes', note: 'the LCSC catalogue' },
      flux: { tone: 'yes', note: 'its own parts library; KiCad parts can be imported' },
    },
  },
  {
    label: 'Open source',
    cells: {
      pcbjam: { tone: 'part', note: 'the editor is GPL-3.0 on GitHub; the collaboration platform is not open source' },
      kicad: { tone: 'yes', note: 'GPLv3 or later' },
      easyeda: { tone: 'no', note: '' },
      flux: { tone: 'no', note: '' },
    },
  },
  {
    label: 'Where your files live',
    cells: {
      pcbjam: { tone: 'yes', note: 'in your PCBJam projects, exportable at any time; self-hosting is on the roadmap' },
      kicad: { tone: 'yes', note: 'on your disk' },
      easyeda: {
        tone: 'part',
        note: 'in EasyEDA’s cloud by default; the Pro desktop client has offline modes that keep projects local',
      },
      flux: { tone: 'no', note: 'in Flux’s cloud' },
    },
  },
  {
    label: `Price, checked ${CHECKED_ON}`,
    cells: {
      pcbjam: { tone: 'info', note: 'free tier; Pro $10 a month' },
      kicad: { tone: 'info', note: 'free' },
      easyeda: { tone: 'info', note: 'free (Std and Pro); paid tiers from $19.90 a month add storage and support' },
      flux: { tone: 'info', note: 'no free plan; 14-day trial, then $50 to $250 a month; Teams $158 per editor' },
    },
  },
];

export const toneMark: Record<Tone, string> = { yes: '[x]', part: '[~]', no: '[ ]', info: '' };
export const toneWord: Record<Tone, string> = { yes: 'yes', part: 'partly', no: 'no', info: '' };

export function competitorBySlug(slug: string): Competitor | undefined {
  return competitors.find((c) => c.slug === slug);
}
