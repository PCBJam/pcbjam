import { afterEach, describe, it, expect, vi } from 'vitest';
import { verifyPluginAccount } from './verify-account';
afterEach(() => {vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('plugin account authorization', () => {
    it('uses fresh authenticated server identity, without sending plugin identity selectors', async () => { const fetch = vi.fn().mockResolvedValue(Response.json({ user: { slug: 'alice', email: 'private' } })); vi.stubGlobal('fetch', fetch); const signal = new AbortController().signal; await verifyPluginAccount('https://api.example', 'alice', signal); expect(fetch).toHaveBeenCalledWith('https://api.example/api/me', { credentials: 'include', cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal) }); });
    it.each([null, { slug: 'bob' }, {}])('rejects missing or changed account %j', async (user) => { vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ user }))); await expect(verifyPluginAccount('', 'alice', new AbortController().signal)).rejects.toThrow(/account changed/); });
    it.each([new Response('', { status: 401 }), new Response('{bad'), new Response('x'.repeat(65537))])('fails closed on unavailable or invalid server responses', async (response) => { vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response)); await expect(verifyPluginAccount('', 'alice', new AbortController().signal)).rejects.toThrow(); });
    it('does not authorize a cancelled instance', async () => { vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ user: { slug: 'alice' } }))); const controller = new AbortController(); controller.abort(); await expect(verifyPluginAccount('', 'alice', controller.signal)).rejects.toThrow(); });
    it('aborts a stalled identity request after its deadline',async()=>{
        const deadline=new AbortController();
        const timeout=vi.spyOn(AbortSignal,'timeout').mockReturnValue(deadline.signal);
        vi.stubGlobal('fetch',vi.fn((_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}))));
        const result=expect(verifyPluginAccount('https://api.example','alice',new AbortController().signal)).rejects.toThrow('deadline');
        expect(timeout).toHaveBeenCalledWith(10000);deadline.abort(new Error('deadline'));await result;
    });

});
