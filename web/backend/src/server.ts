// Thin REFERENCE backend for the @pcbjam/shared contract.
//
// It serves a SINGLE KiCad project straight off the local filesystem
// (PROJECT_DIR) with no database, no auth, and no uploads — just enough for the
// standalone editor to enumerate the project, read its file tree, and stream
// file bytes. It exists to (a) let the GPL editor run end-to-end on its own and
// (b) document the minimum a "real" backend must implement. Collaboration is
// browser-tab only (BroadcastChannel) and needs nothing from the server.

import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { initServer } from "@ts-rest/fastify";
import {
  contract,
  USER_HEADER,
  type Project,
  type ProjectFile,
} from "@pcbjam/shared";
import {
  itemBodyPath,
  type LibsConfig,
  libsConfig,
  listLibItems,
  listLibs,
} from "./libs.js";
import {
  createUserLib,
  DEFAULT_OWNER,
  listUserItems,
  listUserLibs,
  type UserLibsConfig,
  UserLibError,
  userItemBodyPath,
  userLibsConfig,
  writeUserItem,
} from "./user-libs.js";

/** The (thin, pre-auth) user from USER_HEADER; absent ⇒ the default. User libs
 *  are namespaced by this slug (this reference backend serves one project off the
 *  filesystem regardless of the URL scope). */
function userOf(
  headers: Record<string, string | string[] | undefined>,
): string {
  const v = headers[USER_HEADER];
  const s = Array.isArray(v) ? v[0] : v;
  return (s && String(s).trim()) || DEFAULT_OWNER;
}

const PROJECT_DIR = path.resolve(
  process.cwd(),
  process.env.PROJECT_DIR ?? "./project",
);
const PORT = Number(process.env.PORT ?? 3060);
// Bind to loopback by default: this is an unauthenticated reference backend, so
// it shouldn't be reachable off-box unless an operator opts in via HOST. The
// owner namespace is a client-asserted hint, not an auth boundary — see
// user-libs.ts.
const HOST = process.env.HOST ?? "127.0.0.1";
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:3048";

// Write bounds: a real s-expr symbol/footprint body is KB. Cap the body parser
// well below the old 1 GiB so a single request can't write unbounded data.
// Overridable.
const MAX_ITEM_BYTES = Number(process.env.MAX_ITEM_BYTES ?? 5 * 1024 * 1024);

const TEXT_EXT = new Set([
  ".kicad_pcb",
  ".kicad_sch",
  ".kicad_pro",
  ".kicad_sym",
  ".kicad_mod",
  ".kicad_dru",
  ".kicad_wks",
  ".net",
  ".txt",
  ".csv",
  ".json",
]);

function guessContentType(relPath: string): string {
  const ext = path.posix.extname(relPath).toLowerCase();
  return TEXT_EXT.has(ext)
    ? "text/plain; charset=utf-8"
    : "application/octet-stream";
}

/** Reject paths that escape PROJECT_DIR (traversal guard). */
function safeJoin(relPath: string): string {
  const normalized = path.posix
    .normalize(relPath.replace(/\\/g, "/"))
    .replace(/^(\.\.(\/|$))+/, "")
    .replace(/^\/+/, "");
  const abs = path.resolve(PROJECT_DIR, normalized);
  if (abs !== PROJECT_DIR && !abs.startsWith(PROJECT_DIR + path.sep)) {
    throw new Error(`path escapes project: ${relPath}`);
  }
  return abs;
}

const SLUG = (path.basename(PROJECT_DIR) || "project")
  .toLowerCase()
  .replace(/[^a-z0-9._-]+/g, "-")
  .replace(/^-+|-+$/g, "") || "project";

// Stable-per-process ids (no DB; the editor only needs them to be unique).
const PROJECT_ID = randomUUID();
const fileIds = new Map<string, string>();
function fileId(relPath: string): string {
  let id = fileIds.get(relPath);
  if (!id) {
    id = randomUUID();
    fileIds.set(relPath, id);
  }
  return id;
}

async function walk(dir: string, prefix = ""): Promise<ProjectFile[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: ProjectFile[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // skip dotfiles
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(abs, rel)));
    } else if (entry.isFile()) {
      const st = await fs.stat(abs);
      out.push({
        id: fileId(rel),
        projectId: PROJECT_ID,
        path: rel,
        size: st.size,
        contentType: guessContentType(rel),
        createdAt: st.birthtime.toISOString(),
        updatedAt: st.mtime.toISOString(),
      });
    }
  }
  return out;
}

// The reference backend serves one project for any scope; it echoes back the
// requested scope so the editor's links stay consistent.
async function project(scope: string): Promise<Project> {
  const st = await fs.stat(PROJECT_DIR);
  return {
    id: PROJECT_ID,
    scope,
    slug: SLUG,
    name: path.basename(PROJECT_DIR) || SLUG,
    createdAt: st.birthtime.toISOString(),
    updatedAt: st.mtime.toISOString(),
  };
}

export async function buildApp(): Promise<import("fastify").FastifyInstance> {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    bodyLimit: MAX_ITEM_BYTES,
  });
  // CORS: an explicit origin list is always reflected with credentials. A `*`
  // opt-in is different — reflect-any-origin WITH credentials is unsafe, so a
  // wildcard forces credentials OFF. The invariant is enforced in code, not just
  // documented in the config.
  const wildcard = CORS_ORIGIN === "*";
  await app.register(cors, {
    origin: wildcard ? true : CORS_ORIGIN.split(","),
    credentials: !wildcard,
  });
  app.get("/health", async () => ({ ok: true }));

  const libs: LibsConfig = libsConfig();
  const userLibs: UserLibsConfig = userLibsConfig();

  // The editor PUTs item bodies as text/plain (a kicad_symbol_lib s-expr).
  app.addContentTypeParser(
    "text/plain",
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );

  const s = initServer();
  const router = s.router(contract, {
    listProjects: async ({ params }) => ({
      status: 200,
      body: [await project(params.scope)],
    }),
    getProject: async ({ params }) => {
      if (params.project !== SLUG) {
        return { status: 404 as const, body: { message: "project not found" } };
      }
      return {
        status: 200 as const,
        body: {
          project: await project(params.scope),
          files: await walk(PROJECT_DIR),
          // No auth here: every caller may write (explicit contract conformance).
          access: "write" as const,
        },
      };
    },
    listFiles: async ({ params }) => {
      if (params.project !== SLUG) {
        return { status: 404 as const, body: { message: "project not found" } };
      }
      return { status: 200 as const, body: await walk(PROJECT_DIR) };
    },
    // No members model on the example backend — mention autocomplete falls
    // back to the presence roster + comment authors (contract-sanctioned 404).
    listCollaborators: async () => ({
      status: 404 as const,
      body: { message: "no members model on this backend" },
    }),
    listLibs: async ({ headers, query }) => {
      const owner = userOf(headers);
      // Origins filtered by item kind (?kind); user libs are kind-agnostic
      // containers → always listed.
      const [origins, user] = await Promise.all([
        listLibs(libs, query.kind),
        listUserLibs(userLibs, owner),
      ]);
      return { status: 200 as const, body: [...origins, ...user] };
    },
    listLibItems: async ({ params, headers }) => {
      // User libs win over origins on an id clash (the editor's writable lib).
      const user = await listUserItems(userLibs, userOf(headers), params.lib);
      const items = user ?? (await listLibItems(libs, params.lib));
      if (items === null) {
        return { status: 404 as const, body: { message: "library not found" } };
      }
      return { status: 200 as const, body: items };
    },
    createLib: async ({ body, headers }) => {
      try {
        const lib = await createUserLib(userLibs, userOf(headers), body.name);
        return { status: 201 as const, body: lib };
      } catch (e) {
        if (e instanceof UserLibError && e.status === 409) {
          return { status: 409 as const, body: { message: e.message } };
        }
        return {
          status: 400 as const,
          body: { message: e instanceof Error ? e.message : "bad request" },
        };
      }
    },
    // The reference backend has no drift store; collaboration here is tab-only
    // (BroadcastChannel). Accept-and-ignore: the editor reports drift best-effort
    // and ignores failures, so a 404 is harmless and needs no storage.
    reportDrift: async () => ({
      status: 404 as const,
      body: { message: "drift reporting not supported by the reference backend" },
    }),
  });
  await app.register(s.plugin(router));

  // Streamed item-body fetch (text; intentionally not a ts-rest endpoint).
  // User libs are resolved first (owner-scoped), then read-only origins.
  app.get<{ Params: { scope: string; lib: string; kind: string; name: string } }>(
    "/api/scopes/:scope/libs/:lib/items/:kind/:name",
    async (req, reply) => {
      const { lib, kind, name } = req.params;
      const userPath = userItemBodyPath(userLibs, userOf(req.headers), lib, kind, name);
      const userExists =
        userPath && (await fs.stat(userPath).then((st) => st.isFile()).catch(() => false));
      const abs = userExists ? userPath! : itemBodyPath(libs, lib, kind, name);
      if (!abs) return reply.code(400).send({ message: "invalid item" });
      const st = await fs.stat(abs).catch(() => null);
      if (!st?.isFile()) {
        return reply.code(404).send({ message: "item not found" });
      }
      reply.header("Content-Type", "text/plain; charset=utf-8");
      reply.header("Content-Length", st.size);
      return reply.send(createReadStream(abs));
    },
  );

  // Item-body WRITE (text; the mirror of the GET above). Owner from OWNER_HEADER.
  app.put<{ Params: { scope: string; lib: string; kind: string; name: string } }>(
    "/api/scopes/:scope/libs/:lib/items/:kind/:name",
    async (req, reply) => {
      const { lib, kind, name } = req.params;
      const body = typeof req.body === "string" ? req.body : "";
      if (!body) return reply.code(400).send({ message: "empty body" });
      try {
        const item = await writeUserItem(
          userLibs,
          userOf(req.headers),
          lib,
          kind,
          name,
          body,
        );
        return reply.code(200).send(item);
      } catch (e) {
        const status = e instanceof UserLibError ? e.status : 400;
        return reply
          .code(status)
          .send({ message: e instanceof Error ? e.message : "write failed" });
      }
    },
  );

  // Streamed file-byte download (binary; intentionally not a ts-rest endpoint).
  app.get<{ Params: { scope: string; project: string; "*": string } }>(
    "/api/scopes/:scope/projects/:project/files/*",
    async (req, reply) => {
      if (req.params.project !== SLUG) {
        return reply.code(404).send({ message: "project not found" });
      }
      let abs: string;
      try {
        abs = safeJoin(req.params["*"]);
      } catch {
        return reply.code(400).send({ message: "invalid path" });
      }
      const st = await fs.stat(abs).catch(() => null);
      if (!st?.isFile()) {
        return reply.code(404).send({ message: "file not found" });
      }
      reply.header("Content-Type", guessContentType(req.params["*"]));
      reply.header("Content-Length", st.size);
      return reply.send(createReadStream(abs));
    },
  );

  return app;
}

async function main(): Promise<void> {
  const app = await buildApp();
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`serving project "${SLUG}" from ${PROJECT_DIR} on ${HOST}:${PORT}`);
}

// Only self-start when run directly (not when imported by a test).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
