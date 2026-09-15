import * as Y from 'yjs';
import { kicadItemsMap, kicadLibSymbolsMap, yToItemUnchecked, Y_KDOC_META, Y_KDOC_LAYOUT } from '@pcbjam/shared';
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
    return copy;
}
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
        getItems: (ids: string[]) => { const copy = copier(); return ids.map(id => item(id, copy)); },
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
