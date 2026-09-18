import * as Y from 'yjs';
import { kicadItemsMap, kicadLibSymbolsMap, yToItemUnchecked, streamBodyJson, Y_KDOC_META, Y_KDOC_LAYOUT } from '@pcbjam/shared';
const MAX_BYTES = 1024 * 1024;
/** Copy selected JSON/Yjs values with a shared budget before toJSON/serialization. */
function copier() {
    let nodes = 0, bytes = 0;
    const active = new Set<object>();
    function copy(value: any, depth = 0): any {
        if (++nodes > 100000 || depth > 48)
            throw new Error('Document structure exceeds limits');
        if (typeof value === 'string') {
            if (value.length > MAX_BYTES || (bytes += new TextEncoder().encode(value).length) > MAX_BYTES)
                throw new Error('Document response exceeds 1 MiB; use smaller item pages');
            return value;
        }
        if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value))
            return value;
        if (!value || typeof value !== 'object' || active.has(value))
            throw new Error('Invalid document data');
        active.add(value);
        let result: any;
        if (value instanceof Y.Array || Array.isArray(value)) {
            result = [];
            value.forEach((item: any) => result.push(copy(item, depth + 1)));
        }
        else if (value instanceof Y.Map) {
            result = Object.create(null);
            value.forEach((item: any, key: string) => { copy(key, depth + 1); result[key] = copy(item, depth + 1); });
        }
        else {
            if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
                throw new Error('Invalid document object');
            result = Object.create(null);
            for (const [key, item] of Object.entries(value)) {
                copy(key, depth + 1);
                result[key] = copy(item, depth + 1);
            }
        }
        active.delete(value);
        return result;
    }
    // A failed item must not consume the budget of the items that follow it.
    copy.mark = () => ({ nodes, bytes });
    copy.rewind = (mark: { nodes: number; bytes: number }) => { nodes = mark.nodes; bytes = mark.bytes; active.clear(); };
    return copy;
}
const LIMIT_ERROR = /exceeds/;
/** Classification walks are bounded too: each one may visit up to the node limit. */
const MAX_OVERSIZE_PROBES = 4;
export function createDocumentAPI(options: {
    doc: Y.Doc;
    project: {
        id: string;
        scope: string;
        name: string;
    };
    fileName: string;
    files: readonly {
        path: string;
    }[];
    selection(): readonly string[];
    /** Engine-backed board shapes, where the loaded engine has them. Pinned to the document revision here. */
    geometry?(request: { tracks: boolean; zones: boolean }): { read(budgetMs: number, maxChars: number): Promise<{ text: string; done: boolean }> };
    subscribeSelection(callback: () => void): () => void;
    signal: AbortSignal;
}) {
    let revision = 1, selectionRevision = 1;
    const roots = [kicadItemsMap(options.doc), kicadLibSymbolsMap(options.doc), options.doc.getMap(Y_KDOC_META), options.doc.getArray(Y_KDOC_LAYOUT)];
    const changed = (tr: Y.Transaction) => { if (roots.some(root => tr.changed.has(root as any) || tr.changedParentTypes.has(root as any)))
        revision++; };
    options.doc.on('afterTransaction', changed);
    const unsubscribe = options.subscribeSelection(() => { selectionRevision++; });
    const dispose = () => { options.doc.off('afterTransaction', changed); unsubscribe(); };
    options.signal.addEventListener('abort', dispose, { once: true });
    if (options.signal.aborted)
        dispose();
    const live = () => { options.signal.throwIfAborted(); const items = kicadItemsMap(options.doc); if (items.size > 50000)
        throw new Error('Document has too many items'); return items; };
    const item = (id: string, copy: ReturnType<typeof copier>) => {
        const entry = live().get(id);
        if (!entry)
            throw new Error('Item is not in the current document');
        // Bound the stored tree before the existing v2-to-slot conversion walks it.
        const stored = entry.get('body'), body = copy(stored ?? []);
        return { id: copy(id), type: copy(entry.get('type')), parent: copy(entry.get('parent') ?? null), body: stored instanceof Y.Map ? yToItemUnchecked(entry).body : body };
    };
    type Item = ReturnType<typeof item>;
    return {
        projectInfo: () => { live(); return { ...options.project }; },
        catalog: () => {
            live();
            if (options.files.length > 5000)
                throw new Error('Project catalog exceeds limits');
            return options.files.filter(file => /\.(kicad_sch|kicad_pcb|kicad_sym|kicad_mod)$/.test(file.path)).map(file => ({ name: file.path, kind: file.path.split('.').at(-1)!, current: file.path === options.fileName }));
        },
        revision: () => { live(); return revision; },
        items: (cursor: number, limit: number, types: string[]) => {
            const source = live();
            const ids = [...source.keys()].sort().filter(id => !types.length || types.includes(String(source.get(id)!.get('type'))));
            if (cursor > ids.length)
                throw new Error('Invalid item cursor');
            const copy = copier();
            return { items: ids.slice(cursor, cursor + limit).map(id => { const entry = source.get(id)!; return copy({ id, type: entry.get('type'), parent: entry.get('parent') ?? null }); }), nextCursor: cursor + limit < ids.length ? cursor + limit : null };
        },
        getItems: ((ids: string[], partial = false) => {
            const copy = copier();
            if (!partial)
                return ids.map(id => item(id, copy));
            // TOO_LARGE: over the limits on its own. DEFERRED: fits, but not in what is
            // left of this response; ask again. Unknown IDs still fail the whole call.
            let probes = 0, full = false;
            return ids.map(id => {
                if (full) {
                    if (!live().has(id))
                        throw new Error('Item is not in the current document');
                    return { id, error: 'DEFERRED' };
                }
                const mark = copy.mark();
                try { return item(id, copy); }
                catch (error) {
                    if (!(error instanceof Error) || !LIMIT_ERROR.test(error.message))
                        throw error;
                    copy.rewind(mark);
                    if (++probes > MAX_OVERSIZE_PROBES) { full = true; return { id, error: 'DEFERRED' }; }
                    try { item(id, copier()); }
                    catch (alone) {
                        if (!(alone instanceof Error) || !LIMIT_ERROR.test(alone.message))
                            throw alone;
                        return { id, error: 'TOO_LARGE' };
                    }
                    full = true;
                    return { id, error: 'DEFERRED' };
                }
            });
        }) as { (ids: string[]): Item[]; (ids: string[], partial: boolean): Array<Item | { id: string; error: 'TOO_LARGE' | 'DEFERRED' }> },
        /**
         * Whole-document read that never holds the UI thread: newline-delimited JSON
         * records produced a slice at a time. `read` stops after `budgetMs` or `maxChars`,
         * even in the middle of one huge zone, and refuses to resume once the document
         * has changed, because the walk reads the live document lazily.
         */
        openExport: (request: { types: string[]; omit: string[]; layout: boolean; libSymbols: boolean }) => {
            const source = live(), started = revision, omit = new Set(request.omit);
            const ids = [...source.keys()].sort().filter(id => !request.types.length || request.types.includes(String(source.get(id)!.get('type'))));
            let buffer = '', deadline = 0, maxChars = 0, ticks = 0, finished = false;
            const emit = (text: string) => { buffer += text; };
            const pause = () => buffer.length >= maxChars || (++ticks & 63) === 0 && performance.now() >= deadline;
            const records = (function* () {
                const root = options.doc.getMap(Y_KDOC_META).get('root');
                emit(JSON.stringify({ $: 'root', value: typeof root === 'string' ? root : '' }) + '\n');
                for (const id of ids) {
                    const entry = source.get(id)!, parent = entry.get('parent');
                    emit('{"id":' + JSON.stringify(id) + ',"type":' + JSON.stringify(String(entry.get('type'))) + ',"parent":' + JSON.stringify(typeof parent === 'string' ? parent : null) + ',"body":');
                    yield* streamBodyJson(entry.get('body'), emit, pause, omit);
                    emit('}\n');
                    if (pause()) yield;
                }
                if (request.layout) {
                    emit('{"$":"layout","value":');
                    yield* streamBodyJson(options.doc.getArray(Y_KDOC_LAYOUT).toArray(), emit, pause);
                    emit('}\n');
                }
                if (request.libSymbols) {
                    const symbols = kicadLibSymbolsMap(options.doc);
                    for (const id of [...symbols.keys()].sort()) {
                        const text = symbols.get(id);
                        if (typeof text !== 'string' || text.length > MAX_BYTES)
                            throw new Error('Document structure exceeds limits');
                        emit(JSON.stringify({ $: 'libSymbol', id, text }) + '\n');
                        if (pause()) yield;
                    }
                }
            })();
            return {
                revision: started,
                read: (budgetMs: number, max: number) => {
                    live();
                    if (revision !== started)
                        throw new Error('Document changed: get its current revision and retry');
                    maxChars = max; ticks = 0; deadline = performance.now() + budgetMs;
                    if (!finished && buffer.length < max)
                        finished = records.next().done === true;
                    // Never split a surrogate pair across two slices.
                    let cut = Math.min(max, buffer.length);
                    if (cut < buffer.length && cut > 0 && (buffer.charCodeAt(cut - 1) & 0xfc00) === 0xd800)
                        cut--;
                    const text = buffer.slice(0, cut);
                    buffer = buffer.slice(cut);
                    return { text, done: finished && !buffer.length };
                },
            };
        },
        /** Same session contract as openExport; the shapes come from the engine, the revision pin from here. */
        openGeometry: (request: { tracks: boolean; zones: boolean }) => {
            live();
            if (!options.geometry)
                throw new Error('Board shapes are unavailable in this editor');
            const started = revision, reader = options.geometry(request);
            return {
                revision: started,
                read: async (budgetMs: number, maxChars: number) => {
                    live();
                    if (revision !== started)
                        throw new Error('Document changed: get its current revision and retry');
                    return reader.read(budgetMs, maxChars);
                },
            };
        },
        snapshot: () => {
            const source = live(), copy = copier();
            // Export only KiCad content. Presence, comments, sync state and credentials
            // are not serialized; embedded library text is parsed only inside QuickJS.
            return { root: copy(options.doc.getMap(Y_KDOC_META).get('root')), items: [...source.keys()].sort().map(id => item(id, copy)),
                layout: copy(options.doc.getArray(Y_KDOC_LAYOUT)), libSymbols: [...kicadLibSymbolsMap(options.doc).keys()].sort().map(id => copy(kicadLibSymbolsMap(options.doc).get(id))) };
        },
        selection: () => {
            const source = live(), selected = options.selection();
            if (selected.length > 1000)
                throw new Error('Selection exceeds limits');
            return { revision: selectionRevision, ids: [...new Set(selected)].filter(id => source.has(id)) };
        },
    };
}
