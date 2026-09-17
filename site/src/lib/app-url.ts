// Where "Go to app" / "Start free" send people: PUBLIC_APP_URL if set, else the
// local @pcbjam/web dev server under `astro dev` and app.pcbjam.com in a build.
export const APP_URL: string =
  import.meta.env.PUBLIC_APP_URL ??
  (import.meta.env.DEV ? 'http://localhost:3047' : 'https://app.pcbjam.com');
