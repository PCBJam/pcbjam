import { describe, it, expect, vi } from 'vitest';
import * as Y from 'yjs';
import { docToY, fileToDoc, docToFile, yToDoc, kicadItemsMap, Y_KDOC_META } from '@pcbjam/shared';
import { createDocumentAPI } from './document-api';
const text = '(kicad_sch (version 20250114) (lib_symbols (symbol "Local:R" (symbol "R_0_1"))) (symbol (lib_id "Local:R") (uuid "s1") (pin "1" (uuid "p1"))) (wire (uuid "w1")))';
function fixture(version = 2) {
    const doc = new Y.Doc(), abort = new AbortController();
    doc.getMap(Y_KDOC_META).set('sexprVersion', version);
    docToY(fileToDoc(text), doc);
    let selected = ['s1', 'missing', 's1'];
    let selectionChanged = () => { };
    const unsubscribe = vi.fn();
    const api = createDocumentAPI({ doc, project: { id: 'p1', scope: 'scope', name: 'test' }, fileName: 'main.kicad_sch', files: [{ path: 'main.kicad_sch' }, { path: 'board.kicad_pcb' }, { path: 'credentials.json' }], signal: abort.signal, selection: () => selected, subscribeSelection: cb => { selectionChanged = cb; return unsubscribe; } });
    return { doc, api, abort, unsubscribe, select: (ids: string[]) => { selected = ids; selectionChanged(); }, close: () => { abort.abort(); doc.destroy(); } };
}
describe('plugin current-document adapter', () => {
    it.each([1, 2])('returns detached canonical slots for format %s', version => {
        const f = fixture(version);
        try {
            const source = yToDoc(f.doc), snap = f.api.snapshot();
            expect(snap.items).toEqual(Object.keys(source.items).sort().map(id => ({ id, ...source.items[id] })));
            expect(snap.libSymbols).toHaveLength(1);
            expect(snap.root).toBe('kicad_sch');
            const item = f.api.getItems(['s1'])[0]!;
            item.body.length = 0;
            expect(f.api.getItems(['s1'])[0]!.body.length).toBeGreaterThan(0);
            expect(docToFile(yToDoc(f.doc))).toContain('Local:R');
        }
        finally {
            f.close();
        }
    });
    it('returns only project metadata and design file names', () => { const f = fixture(); try {
        expect(f.api.projectInfo()).toEqual({ id: 'p1', scope: 'scope', name: 'test' });
        expect(f.api.catalog().map(v => v.name)).toEqual(['main.kicad_sch', 'board.kicad_pcb']);
    }
    finally {
        f.close();
    } });
    it('paginates and filters items; rejects foreign IDs and invalid cursors', () => { const f = fixture(); try {
        expect(f.api.items(0, 1, [])).toEqual({ items: [{ id: 'p1', type: 'pin', parent: 's1' }], nextCursor: 1 });
        expect(f.api.items(0, 100, ['wire']).items.map(v => v.id)).toEqual(['w1']);
        expect(f.api.items(3, 1, []).nextCursor).toBeNull();
        expect(() => f.api.items(4, 1, [])).toThrow(/cursor/);
        expect(() => f.api.getItems(['foreign'])).toThrow(/current document/);
    }
    finally {
        f.close();
    } });
    it('tracks content and selection revisions separately; excludes comments and presence', () => { const f = fixture(); try {
        const initial = f.api.revision();
        f.doc.getMap('comments').set('secret', 'not for plugins');
        f.doc.getMap('presence').set('email', 'private@example.test');
        expect(f.api.revision()).toBe(initial);
        expect(JSON.stringify(f.api.snapshot())).not.toMatch(/secret|private@example|presence|comments/);
        expect(f.api.selection()).toEqual({ revision: 1, ids: ['s1'] });
        f.select(['p1']);
        expect(f.api.selection()).toEqual({ revision: 2, ids: ['p1'] });
        kicadItemsMap(f.doc).delete('w1');
        expect(f.api.revision()).toBe(initial + 1);
    }
    finally {
        f.close();
    } });
    it('bounds stored trees before conversion and stops observers on disposal', () => { const f = fixture(); try {
        const item = kicadItemsMap(f.doc).get('s1')!;
        item.set('body', [{ atom: 'é'.repeat(600000) }]);
        expect(() => f.api.snapshot()).toThrow(/1 MiB/);
        f.abort.abort();
        expect(f.unsubscribe).toHaveBeenCalledOnce();
        expect(() => f.api.getItems(['s1'])).toThrow();
        expect(() => f.api.projectInfo()).toThrow();
    }
    finally {
        f.close();
    } });
    it('partial reads isolate oversized items instead of failing the page', () => { const f = fixture(); try {
        const items = kicadItemsMap(f.doc);
        items.get('w1')!.set('body', [{ atom: 'é'.repeat(600000) }]);
        expect(() => f.api.getItems(['p1', 'w1', 's1'])).toThrow(/1 MiB/);
        const result = f.api.getItems(['p1', 'w1', 's1'], true) as any[];
        expect(result[1]).toEqual({ id: 'w1', error: 'TOO_LARGE' });
        // The failed item's partial walk does not count against its neighbours.
        expect(result[0].body.length).toBeGreaterThan(0);
        expect(result[2].body.length).toBeGreaterThan(0);
        // Fits alone, but not after p1 has used most of the shared response budget.
        items.get('p1')!.set('body', [{ atom: 'a'.repeat(700000) }]);
        items.get('w1')!.set('body', [{ atom: 'b'.repeat(700000) }]);
        const deferred = f.api.getItems(['p1', 'w1', 's1'], true) as any[];
        expect(deferred[0].body).toBeDefined();
        expect(deferred.slice(1)).toEqual([{ id: 'w1', error: 'DEFERRED' }, { id: 's1', error: 'DEFERRED' }]);
        expect((f.api.getItems(['w1'], true) as any[])[0].body).toBeDefined();
        expect(() => f.api.getItems(['p1', 'w1', 'foreign'], true)).toThrow(/current document/);
    }
    finally {
        f.close();
    } });
    it('bounds classification walks for a page of oversized items', () => { const f = fixture(); try {
        const items = kicadItemsMap(f.doc), ids = ['p1', 's1', 'w1'];
        for (let i = 0; i < 7; i++) {
            const clone = new Y.Map<any>();
            clone.set('type', 'wire'); clone.set('parent', null);
            items.set('big' + i, clone); ids.push('big' + i);
        }
        for (const id of ids) items.get(id)!.set('body', [{ atom: 'é'.repeat(600000) }]);
        const result = f.api.getItems(ids, true) as any[];
        expect(result.filter(item => item.error === 'TOO_LARGE')).toHaveLength(4);
        expect(result.filter(item => item.error === 'DEFERRED')).toHaveLength(ids.length - 4);
    }
    finally {
        f.close();
    } });
    const drain = (cursor: { read(ms: number, max: number): { text: string; done: boolean } }, ms: number, max: number) => {
        let text = '', slices = 0;
        for (;;) { const part = cursor.read(ms, max); expect(part.text.length).toBeLessThanOrEqual(max); text += part.text; slices++; if (part.done) break; if (slices > 100000) throw new Error('export never finished'); }
        return { records: text.split('\n').filter(Boolean).map(line => JSON.parse(line)), slices, text };
    };
    it.each([1, 2])('exports the whole document in resumable slices for format %s', version => { const f = fixture(version); try {
        const snap = f.api.snapshot(), all = { types: [], omit: [], layout: true, libSymbols: true };
        const whole = drain(f.api.openExport(all), 1000, 1 << 20);
        expect(whole.text.endsWith('\n')).toBe(true);
        expect(whole.records[0]).toEqual({ $: 'root', value: snap.root });
        expect(whole.records.filter(r => !r.$)).toEqual(snap.items);
        expect(whole.records.find(r => r.$ === 'layout').value).toEqual(snap.layout);
        expect(whole.records.filter(r => r.$ === 'libSymbol').map(r => r.text)).toEqual(snap.libSymbols);
        // Slicing is invisible: 7 characters at a time, and a zero time budget, give the same text.
        const tiny = drain(f.api.openExport(all), 1000, 7);
        expect(tiny.slices).toBeGreaterThan(20);
        expect(tiny.text).toBe(whole.text);
        expect(drain(f.api.openExport(all), 0, 1 << 20).text).toBe(whole.text);
        const bare = drain(f.api.openExport({ types: ['wire'], omit: [], layout: false, libSymbols: false }), 1000, 1 << 20).records;
        expect(bare.map(r => r.$ ?? r.type)).toEqual(['root', 'wire']);
        const noPins = drain(f.api.openExport({ ...all, omit: ['lib_id'] }), 1000, 1 << 20).text;
        expect(whole.text).toContain('lib_id');
        expect(noPins).not.toContain('lib_id');
    }
    finally {
        f.close();
    } });
    it('export stops inside a huge item, keeps surrogate pairs whole, and refuses a changed document', () => { const f = fixture(); try {
        const points = Array.from({ length: 5000 }, (_, i) => ({ k: 'xy', v: [{ atom: String(i) }, { atom: '😀' }] }));
        kicadItemsMap(f.doc).get('w1')!.set('body', [{ k: 'pts', v: points }]);
        const request = { types: ['wire'], omit: [], layout: false, libSymbols: false };
        const sliced = drain(f.api.openExport(request), 1000, 1001);
        expect(sliced.slices).toBeGreaterThan(50);
        expect(sliced.records[1].body[0].v).toEqual(points);
        const cursor = f.api.openExport(request), first = cursor.read(1000, 1001);
        expect(first.done).toBe(false);
        for (const part of [first.text, cursor.read(1000, 1000).text]) {
            expect((part.charCodeAt(part.length - 1) & 0xfc00) === 0xd800).toBe(false);
            expect((part.charCodeAt(0) & 0xfc00) === 0xdc00).toBe(false);
        }
        kicadItemsMap(f.doc).get('s1')!.set('parent', null);
        expect(() => cursor.read(1000, 1000)).toThrow(/Document changed/);
        f.abort.abort();
        expect(() => f.api.openExport(request)).toThrow();
    }
    finally {
        f.close();
    } });
    it('bounds nesting and selection cardinality', () => { const f = fixture(); try {
        f.select(Array(1001).fill('s1'));
        expect(() => f.api.selection()).toThrow(/limits/);
        let body: any = 'a';
        for (let i = 0; i < 60; i++)
            body = [body];
        kicadItemsMap(f.doc).get('s1')!.set('body', body);
        expect(() => f.api.getItems(['s1'])).toThrow(/structure/);
    }
    finally {
        f.close();
    } });
});
