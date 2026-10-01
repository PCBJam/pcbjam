/**
 * A test double of the Emscripten filesystem's lookup rules (libfs.js /
 * libmemfs.js), enough for the placeholder folders: a name cache per parent,
 * and per-NODE `node_ops` whose `readdir` lists a directory and whose
 * `lookup` is asked only for a name the cache does not hold.
 */
export interface FakeNode {
  name: string;
  parent: FakeNode | null;
  children: Map<string, FakeNode> | null;
  bytes: Uint8Array | null;
  node_ops: {
    readdir(node: FakeNode): string[];
    lookup(parent: FakeNode, name: string): FakeNode;
    [op: string]: unknown;
  };
}

export function fakeMemfs() {
  const dirOps: FakeNode["node_ops"] = {
    readdir: (node) => [".", "..", ...node.children!.keys()],
    lookup: () => {
      throw new Error("ENOENT");
    },
  };
  const make = (name: string, parent: FakeNode | null, dir: boolean): FakeNode => ({
    name,
    parent,
    children: dir ? new Map() : null,
    bytes: dir ? null : new Uint8Array(),
    node_ops: dirOps,
  });
  const root = make("", null, true);
  const lookupNode = (parent: FakeNode, name: string): FakeNode =>
    parent.children?.get(name) ?? parent.node_ops.lookup(parent, name);
  const walk = (path: string): FakeNode => {
    let node = root;
    for (const seg of path.split("/").filter(Boolean)) node = lookupNode(node, seg);
    return node;
  };
  const fs = {
    mkdirTree(path: string): void {
      let node = root;
      for (const seg of path.split("/").filter(Boolean)) {
        let next = node.children!.get(seg);
        if (!next) node.children!.set(seg, (next = make(seg, node, true)));
        node = next;
      }
    },
    writeFile(path: string, data: Uint8Array | string): void {
      const i = path.lastIndexOf("/");
      const parent = walk(path.slice(0, i));
      const name = path.slice(i + 1);
      let node: FakeNode;
      try {
        node = lookupNode(parent, name);
      } catch {
        node = make(name, parent, false);
        parent.children!.set(name, node);
      }
      node.bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    },
    readFile: (path: string): Uint8Array => walk(path).bytes!,
    readdir: (path: string): string[] => {
      const node = walk(path);
      return node.node_ops.readdir(node).filter((n) => n !== "." && n !== "..");
    },
    analyzePath: (path: string): { exists: boolean } => {
      try {
        walk(path);
        return { exists: true };
      } catch {
        return { exists: false };
      }
    },
    unlink(path: string): void {
      const i = path.lastIndexOf("/");
      walk(path.slice(0, i)).children!.delete(path.slice(i + 1));
    },
    lookupPath: (path: string): { node: FakeNode } => ({ node: walk(path) }),
    lookupNode,
  };
  return fs;
}
