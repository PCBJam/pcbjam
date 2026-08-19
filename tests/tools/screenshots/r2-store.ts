/**
 * Minimal S3 client for the content-addressed screenshot-baseline bucket.
 *
 * Baselines live in a PRIVATE R2 bucket as immutable objects keyed by content
 * hash (`sha256/<hex>.png`); the R2-hosted manifest
 * (baselines/pcbjam/manifest.json, written only by the morelli app) maps
 * `<engine>/<name>` to a hash. Auth is a bucket-scoped S3 keypair — read-only
 * for fetch, a separate write pair for CI's run uploads — via the env vars in
 * config.ts R2_ENV; see this directory's README for where to get credentials.
 *
 * aws4fetch does the SigV4 signing (dependency-free; region is always "auto"
 * on R2). Objects are never deleted here — a baseline prune only edits the
 * manifest, old hashes stay resolvable for old commits.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import { AwsClient } from 'aws4fetch';
import { R2_DEFAULT_BUCKET, R2_ENV, R2_KEY_PREFIX } from './config';

export function hashBytes(bytes: Buffer): string {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function hashFile(file: string): string {
    return hashBytes(fs.readFileSync(file));
}

const RETRIES = 3;
const BACKOFF_MS = 2000;

export class R2Store {
    private client: AwsClient;
    private base: string;

    constructor(opts: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string }) {
        // aws4fetch has its own 5xx retry loop; disable it (retries: 0) so the
        // backoff policy lives in exactly one place (fetchWithRetry below).
        this.client = new AwsClient({
            accessKeyId: opts.accessKeyId,
            secretAccessKey: opts.secretAccessKey,
            region: 'auto',
            service: 's3',
            retries: 0,
        });
        this.base = `${opts.endpoint.replace(/\/+$/, '')}/${opts.bucket}`;
    }

    private url(hash: string): string {
        return `${this.base}/${R2_KEY_PREFIX}${hash}.png`;
    }

    /** Signed fetch, retrying network errors and 5xx — an R2 blip shouldn't fail a whole sync. */
    private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
        let lastErr: unknown;
        for (let attempt = 1; attempt <= RETRIES; attempt++) {
            try {
                const res = await this.client.fetch(url, init);
                if (res.status < 500 && res.status !== 429) return res;
                lastErr = new Error(`HTTP ${res.status}`);
                await res.arrayBuffer().catch(() => undefined); // drain before retrying
            } catch (e) {
                lastErr = e;
            }
            if (attempt < RETRIES) await new Promise((r) => setTimeout(r, BACKOFF_MS * attempt));
        }
        throw new Error(`request failed after ${RETRIES} attempts: ${(lastErr as Error).message}`);
    }

    async exists(hash: string): Promise<boolean> {
        const res = await this.fetchWithRetry(this.url(hash), { method: 'HEAD' });
        if (res.status === 200) return true;
        if (res.status === 404) return false;
        throw new Error(`HEAD ${R2_KEY_PREFIX}${hash}.png → HTTP ${res.status}`);
    }

    /** Download one object; the key IS the sha256, so every download is integrity-checked. */
    async get(hash: string): Promise<Buffer> {
        const res = await this.fetchWithRetry(this.url(hash), { method: 'GET' });
        if (res.status === 404) throw new Error(`missing object ${R2_KEY_PREFIX}${hash}.png`);
        if (res.status !== 200) throw new Error(`GET ${R2_KEY_PREFIX}${hash}.png → HTTP ${res.status}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        const actual = hashBytes(bytes);
        if (actual !== hash) throw new Error(`corrupt download for ${hash} (received sha256 ${actual})`);
        return bytes;
    }

    /** Upload one object unless already present (same-hash PUTs are idempotent regardless). */
    async put(hash: string, bytes: Buffer): Promise<'uploaded' | 'exists'> {
        if (await this.exists(hash)) return 'exists';
        const res = await this.fetchWithRetry(this.url(hash), {
            method: 'PUT',
            // Buffer is a Uint8Array and a valid fetch body; the cast bridges
            // @types/node's Buffer<ArrayBufferLike> vs DOM BufferSource generics.
            body: bytes as unknown as BodyInit,
            headers: { 'content-type': 'image/png' },
        });
        if (res.status !== 200) throw new Error(`PUT ${R2_KEY_PREFIX}${hash}.png → HTTP ${res.status}`);
        await res.arrayBuffer().catch(() => undefined);
        return 'uploaded';
    }

    /**
     * Download an ARBITRARY key (the R2-hosted baseline manifest) — unlike
     * get(), not content-addressed, so no hash verification is possible; null
     * on 404 so the caller can degrade like the no-credentials path.
     */
    async getKey(key: string): Promise<Buffer | null> {
        const res = await this.fetchWithRetry(`${this.base}/${key}`, { method: 'GET' });
        if (res.status === 404) {
            await res.arrayBuffer().catch(() => undefined);
            return null;
        }
        if (res.status !== 200) throw new Error(`GET ${key} → HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
    }

    /**
     * Upload to an ARBITRARY key (the per-run uploads under runs/…, consumed by
     * the morelli review app) — unlike put(), not content-addressed and always
     * overwrites (workflow re-runs reuse the run id; last attempt wins).
     */
    async putKey(key: string, bytes: Buffer, contentType: string): Promise<void> {
        const res = await this.fetchWithRetry(`${this.base}/${key}`, {
            method: 'PUT',
            body: bytes as unknown as BodyInit,
            headers: { 'content-type': contentType },
        });
        if (res.status !== 200) throw new Error(`PUT ${key} → HTTP ${res.status}`);
        await res.arrayBuffer().catch(() => undefined);
    }
}

let envFileLoaded = false;
/** Best-effort load of ./.env (gitignored) so a dev's keypair can live in a file
 *  instead of the shell. Node ≥20.12 built-in; CI is unaffected (no .env there). */
function ensureEnvFileLoaded(): void {
    if (envFileLoaded) return;
    envFileLoaded = true;
    try {
        if (fs.existsSync('.env')) process.loadEnvFile('.env');
    } catch {
        /* unreadable/malformed .env → shell env only */
    }
}

/** The required R2 env vars that are currently unset (bucket has a default, so it's not required). */
export function missingEnv(): string[] {
    ensureEnvFileLoaded();
    return [R2_ENV.endpoint, R2_ENV.accessKeyId, R2_ENV.secretAccessKey].filter((v) => !process.env[v]);
}

/** Build a store from the environment (shell vars, falling back to ./.env), or null when credentials are absent. */
export function storeFromEnv(): R2Store | null {
    if (missingEnv().length) return null;
    return new R2Store({
        endpoint: process.env[R2_ENV.endpoint]!,
        bucket: process.env[R2_ENV.bucket] || R2_DEFAULT_BUCKET,
        accessKeyId: process.env[R2_ENV.accessKeyId]!,
        secretAccessKey: process.env[R2_ENV.secretAccessKey]!,
    });
}
