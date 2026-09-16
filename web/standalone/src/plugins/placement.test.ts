import { describe, it, expect, vi, afterEach } from 'vitest';
import { validatePlacement, placeImportedItem, preflightPlacement, type PlacementModule } from './placement';
const symbol = '(lib_symbols (symbol "Local:R" (symbol "R_0_1"))) (symbol (lib_id "Local:R") (uuid "11111111-2222-4333-8444-555555555555"))';
describe('plugin placement boundary', () => {
  it('accepts one matching symbol or one footprint for the appropriate editor', () => {
    expect(() => validatePlacement(symbol, 'eeschema')).not.toThrow();
    expect(() => validatePlacement('(footprint "Test")', 'pcbnew')).not.toThrow();
    expect(() => validatePlacement(symbol, 'pcbnew')).toThrow();
    expect(() => validatePlacement('(footprint "Test")', 'eeschema')).toThrow();
  });
  it('rejects extra roots, unrelated definitions and unsupported editor contexts', () => {
    expect(() => validatePlacement(symbol + ' (sheet)', 'eeschema')).toThrow();
    expect(() => validatePlacement(symbol.replace('(lib_id "Local:R")', '(lib_id "Other:R")'), 'eeschema')).toThrow();
    expect(() => validatePlacement(symbol, 'symbol_editor')).toThrow();
  });
  it('bounds parsing before the recursive parser and rejects malformed text', () => {
    expect(() => validatePlacement('('.repeat(60), 'eeschema')).toThrow(/limits/);
    expect(() => validatePlacement('x'.repeat(512 * 1024 + 1), 'eeschema')).toThrow();
    expect(() => validatePlacement(symbol + '\0', 'eeschema')).toThrow();
    expect(() => validatePlacement(')(', 'eeschema')).toThrow();
  });
  it.each([
    ['missing UUID', symbol.replace(/\(uuid [^)]+\)/, '')],
    ['invalid UUID', symbol.replace('11111111-2222-4333-8444-555555555555', 'not-a-uuid')],
    ['duplicate UUID', symbol.replace('(lib_id "Local:R")', '(uuid "11111111-2222-4333-8444-555555555555") (lib_id "Local:R")')],
    ['duplicate library ID', symbol.replace('(lib_id "Local:R")', '(lib_id "Local:R") (lib_id "Other:R")')],
    ['extra library ID arguments', symbol.replace('(lib_id "Local:R")', '(lib_id "Local:R" "Other:R")')],
    ['extra UUID arguments', symbol.replace('555555555555")', '555555555555" "extra")')],
    ['empty definitions', symbol.replace('(lib_symbols (symbol "Local:R" (symbol "R_0_1")))', '(lib_symbols)')],
    ['unrelated definition type', symbol.replace('(symbol "Local:R"', '(sheet "Local:R"')],
    ['trailing root atom', symbol + ' extra'],
    ['unterminated string', symbol + ' "unfinished'],
  ])('rejects %s before native parsing', (_name, text) => {
    expect(() => validatePlacement(text, 'eeschema')).toThrow();
  });
  it('counts UTF-8 bytes and forms, not just characters or nesting', () => {
    expect(() => validatePlacement('(footprint "' + 'é'.repeat(270000) + '")', 'pcbnew')).toThrow(/Invalid clipboard/);
    expect(() => validatePlacement('(footprint "Test" ' + '(pad)'.repeat(12001) + ')', 'pcbnew')).toThrow(/limits/);
  });
  it('ignores parentheses and escaped quotes within quoted properties', () => {
    const quoted = '(footprint "Test" (property "Value" "a (b) \\"quoted\\""))';
    expect(() => validatePlacement(quoted, 'pcbnew')).not.toThrow();
  });
});

describe('hosted native placement lifecycle',()=>{
  afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.unstubAllEnvs();});
  const native=()=>({kicadPluginPlacementVersion:()=>1,kicadPlaceImportedItem:vi.fn(()=>JSON.stringify({ok:true,operation:1})),
    kicadImportedItemStatus:vi.fn(()=>JSON.stringify({status:'placing'})),kicadCancelImportedItem:vi.fn(()=>true)} satisfies PlacementModule);
  it('does not report queued/placing as success and resolves only after commit',async()=>{
    vi.useFakeTimers();const mod=native();let finished=false;
    const result=placeImportedItem(mod,symbol,new AbortController().signal).then(value=>{finished=true;return value;});
    await vi.advanceTimersByTimeAsync(100);expect(finished).toBe(false);
    mod.kicadImportedItemStatus.mockReturnValue(JSON.stringify({status:'placed'}));
    await vi.advanceTimersByTimeAsync(50);expect(await result).toEqual({status:'placed'});expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['cancelled','error','expired'])('handles native %s without leaving timers',async status=>{
    vi.useFakeTimers();const mod=native();mod.kicadImportedItemStatus.mockReturnValue(JSON.stringify({status,error:'Parse failed'}));
    const result=placeImportedItem(mod,symbol,new AbortController().signal);
    const check=status==='cancelled'?expect(result).resolves.toEqual({status:'cancelled'}):expect(result).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(50);await check;expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels native work on teardown and on deadline',async()=>{
    vi.useFakeTimers();const mod=native(),abort=new AbortController();
    const result=placeImportedItem(mod,symbol,abort.signal);const rejected=expect(result).rejects.toThrow(/cancelled/);
    await Promise.resolve();abort.abort();await rejected;expect(mod.kicadCancelImportedItem).toHaveBeenCalledWith(1);expect(vi.getTimerCount()).toBe(0);
    const timed=expect(placeImportedItem(mod,symbol,new AbortController().signal)).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(110000);await timed;expect(vi.getTimerCount()).toBe(0);
  });
  it('refuses older native builds before handing over a proposal',async()=>{
    const mod=native();mod.kicadPluginPlacementVersion=()=>0;
    await expect(placeImportedItem(mod,symbol,new AbortController().signal)).rejects.toThrow(/build/);
    expect(mod.kicadPlaceImportedItem).not.toHaveBeenCalled();
  });
  it('settles teardown even if a failed native runtime throws while cancelling',async()=>{
    vi.useFakeTimers();const mod=native(),abort=new AbortController();
    mod.kicadCancelImportedItem.mockImplementation(()=>{throw new Error('Native runtime stopped');});
    const result=expect(placeImportedItem(mod,symbol,abort.signal)).rejects.toThrow(/cancelled/);
    await Promise.resolve();abort.abort();await result;expect(vi.getTimerCount()).toBe(0);
  });
  it('terminates a stuck preflight worker within its budget',async()=>{
    vi.useFakeTimers();const terminate=vi.fn();
    vi.stubGlobal('Worker',class{terminate=terminate;postMessage=vi.fn();});
    vi.stubEnv('VITE_PLUGIN_RUNTIME_BASE','/plugin-runtime/test/');
    const result=expect(preflightPlacement(symbol,'eeschema',new AbortController().signal)).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1000);await result;expect(terminate).toHaveBeenCalledOnce();
  });
});
