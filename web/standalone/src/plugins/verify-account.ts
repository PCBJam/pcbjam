/** Cached display identity is not proof the account is still signed in. */
export async function verifyPluginAccount(apiBase: string, expectedSlug: string, signal: AbortSignal) {
    const response = await fetch(apiBase + '/api/me', { credentials: 'include', cache: 'no-store', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
    if (!response.ok || !response.body)
        throw new Error('Cannot verify plugin account; sign in again');
    const reader = response.body.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done)
                break;
            bytes += chunk.value.length;
            if (bytes > 64 * 1024)
                throw new Error('Invalid account response');
            chunks.push(chunk.value);
        }
    }
    finally {
        await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
    signal.throwIfAborted();
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
    }
    const data = JSON.parse(new TextDecoder().decode(body));
    if (data?.user?.slug !== expectedSlug)
        throw new Error('Plugin account changed; reopen the editor');
}
