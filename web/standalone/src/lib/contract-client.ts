import { contract, problemReportContract, USER_HEADER } from "@pcbjam/shared";
import { initClient } from "@ts-rest/core";
import { API_BASE_URL, userSlug } from "./config";

/**
 * ts-rest client over the shared contract (the REST backend). Shared by the
 * remote project source (lib/project-source.ts) and the lib/drift endpoints
 * (lib/api.ts). Kept in its own module so project-source and api don't import
 * each other (avoids a cycle). The scope is a PATH param (per call); the user is
 * a header (the thin pre-auth identity, used for per-user lib pins).
 */
export const client = initClient(contract, {
  baseUrl: API_BASE_URL,
  baseHeaders: { [USER_HEADER]: userSlug() },
  // Send the backend's session cookie (same-site, different origin): backends
  // with real auth resolve the user from it and ignore the thin header. On a
  // cookie-less setup this changes nothing.
  credentials: "include",
});

/** "Report a problem" (problem-reports 0001): its own router on the shared
 *  side, so its own client; same base URL, identity header and cookie. */
export const problemReportClient = initClient(problemReportContract, {
  baseUrl: API_BASE_URL,
  baseHeaders: { [USER_HEADER]: userSlug() },
  credentials: "include",
});
