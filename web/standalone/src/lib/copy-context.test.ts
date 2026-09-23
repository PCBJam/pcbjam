import { afterEach, describe, expect, it } from "vitest";
import {
  copyLabel,
  copySegment,
  fileCacheProjectKey,
  projectSyncNamespace,
  sessionCopyId,
  setCopyContext,
  withCopyParam,
} from "./copy-context";

const DEFAULT = { id: "aaaaaaaa-0000-4000-8000-000000000001", label: "main", kind: "default" as const, generation: 1, isDefault: true };
const BRANCH = { id: "bbbbbbbb-0000-4000-8000-000000000002", label: "branch-b", kind: "branch" as const, generation: 3, isDefault: false };

afterEach(() => setCopyContext(null));

describe("copy context (git-integration 0004)", () => {
  it("is the default copy (no segment, no param) on a copy-less backend", () => {
    setCopyContext(null);
    expect(copySegment()).toBeNull();
    expect(sessionCopyId()).toBeNull();
    expect(withCopyParam("http://api/x/files/a")).toBe("http://api/x/files/a");
    expect(fileCacheProjectKey("p")).toBe("p");
    expect(projectSyncNamespace("s", "p", null)).toBe("project:s:p");
  });

  it("binds to the boot copy: the default copy keeps the legacy identity but still names itself on requests", () => {
    setCopyContext({ copy: DEFAULT, copies: [DEFAULT, BRANCH] });
    expect(copySegment()).toBeNull();
    expect(sessionCopyId()).toBe(DEFAULT.id);
    expect(withCopyParam("http://api/x/files/a?b=1")).toBe(`http://api/x/files/a?b=1&copy=${DEFAULT.id}`);
    expect(fileCacheProjectKey("p")).toBe("p");
  });

  it("a non-default copy segments rooms, caches and the sync namespace", () => {
    setCopyContext({ copy: BRANCH, copies: [DEFAULT, BRANCH] });
    expect(copySegment()).toBe(BRANCH.id);
    expect(fileCacheProjectKey("p")).toBe(`p:${BRANCH.id}`);
    expect(projectSyncNamespace("s", "p", copySegment())).toBe(`project:s:p:${BRANCH.id}`);
    expect(withCopyParam(`/rel/files/a?copy=${BRANCH.id}`)).toBe(`/rel/files/a?copy=${BRANCH.id}`);
    expect(copyLabel(DEFAULT.id)).toBe("main");
    expect(copyLabel("cccccccc-0000-4000-8000-000000000003")).toBe("cccccccc");
  });
});
