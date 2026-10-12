import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { brandHtml } from "./brand-html";

// The editor's real index.html, plus the CSS link Vite injects into it at build time.
const INDEX = readFileSync(path.resolve(__dirname, "../../index.html"), "utf8").replace(
  "</head>",
  '  <link rel="stylesheet" crossorigin href="/assets/index-abc123.css">\n  </head>',
);

describe("brandHtml", () => {
  it("leaves the page untouched without a brand base", () => {
    expect(brandHtml(INDEX, undefined)).toBe(INDEX);
    expect(brandHtml(INDEX, "")).toBe(INDEX);
    expect(brandHtml(INDEX, "  ")).toBe(INDEX);
  });

  it("links the brand: preconnect first, icons and social image from it, stylesheet last", () => {
    const html = brandHtml(INDEX, "https://app.pcbjam.com/brand/");
    const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
    expect(head.indexOf('<link rel="preconnect" href="https://app.pcbjam.com" crossorigin />')).toBeLessThan(
      head.indexOf("<meta"),
    );
    expect(head).toContain('href="https://app.pcbjam.com/brand/favicon.ico"');
    expect(head).toContain('href="https://app.pcbjam.com/brand/favicon.svg"');
    expect(head).toContain('href="https://app.pcbjam.com/brand/apple-touch-icon.png"');
    expect(head).not.toMatch(/href="\/(favicon|apple-touch-icon)/);
    expect(head).toContain('content="https://app.pcbjam.com/brand/og-demo.png"');
    expect(head).not.toContain("demo.pcbjam.com/og/");
    const links = [...head.matchAll(/<link rel="stylesheet"[^>]*>/g)].map(([l]) => l);
    expect(links.at(-1)).toBe('<link rel="stylesheet" href="https://app.pcbjam.com/brand/app.css" />');
    expect(links.length).toBe(2);
  });

  it("gives the airlock page the brand's icons and nothing else", () => {
    const recover = readFileSync(path.resolve(__dirname, "../../recover.html"), "utf8");
    expect(brandHtml(recover, undefined, "airlock")).toBe(recover);
    const html = brandHtml(recover, "https://app.pcbjam.com/brand", "airlock");
    expect(html).toContain('href="https://app.pcbjam.com/brand/favicon.ico"');
    expect(html).toContain('href="https://app.pcbjam.com/brand/favicon.svg"');
    expect(html).not.toMatch(/href="\/(favicon|apple-touch-icon)/);
    expect(html).not.toContain("preconnect");
    expect(html).not.toContain('rel="stylesheet"');
    // Only the icon hrefs changed.
    expect(html.replace(/https:\/\/app\.pcbjam\.com\/brand\//g, "/")).toBe(recover);
  });
});
