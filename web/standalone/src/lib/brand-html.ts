/**
 * Runtime branding (ui-components 0001, section 4.3). A build given a brand base URL
 * (VITE_BRAND_BASE, from `build-editor.mjs --brand-base`) links the brand from there: a
 * preconnect, the brand's icons and social image, and its stylesheet as the page's last, so the
 * brand's tokens override the editor's neutral ones. Without one the page is left as it is:
 * forks, self-hosted builds and the public e2e stay neutral, with the neutral icons in public/.
 * No editor feature depends on the brand; if the file fails to load, the editor renders its
 * neutral theme.
 *
 * The OOM airlock page (recover.html) takes the icons only: it is kept tiny and styles itself
 * inline, so a stylesheet would only hold its first paint.
 */
export function brandHtml(html: string, brandBase: string | undefined, page: "main" | "airlock" = "main"): string {
  const base = brandBase?.trim().replace(/\/+$/, "");
  if (!base) return html;
  const icons = html.replace(/href="\/(favicon\.ico|favicon\.svg|apple-touch-icon\.png)"/g, `href="${base}/$1"`);
  if (page === "airlock") return icons;
  const origin = new URL(base).origin;
  return (
    icons
      // The brand's fonts load in CORS mode, so the early connection is a CORS one too.
      .replace("<head>", `<head>\n    <link rel="preconnect" href="${origin}" crossorigin />`)
      .replace(/content="https:\/\/demo\.pcbjam\.com\/og\/og-demo\.png"/g, `content="${base}/og-demo.png"`)
      // Last in <head>: after the editor's own CSS, which Vite has injected by now.
      .replace("</head>", `  <link rel="stylesheet" href="${base}/app.css" />\n  </head>`)
  );
}
