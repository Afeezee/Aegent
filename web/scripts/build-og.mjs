// Rasterizes the OG + icon SVGs into PNGs.
//
// Why: og:image needs a raster format for Twitter/X, Facebook, LinkedIn
// (they reject SVG). We keep the SVG as the editable source and commit
// both the SVG and its rendered PNG so a fresh clone works without
// running this script.
//
// Usage: `node scripts/build-og.mjs` (from web/).
//
// The pixel outputs go straight into public/ so Vite copies them into
// the deployed bundle at the same URL they're referenced from.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(HERE, "../public");

async function renderSvg(inFile, outFile, opts) {
  const svg = await readFile(resolve(PUBLIC, inFile), "utf8");
  const resvg = new Resvg(svg, {
    fitTo: opts.width ? { mode: "width", value: opts.width } : { mode: "original" },
    background: opts.background,
    font: {
      // Resvg needs a font available on-system for text nodes. Use whatever
      // Inter-ish sans is present; if nothing loads, resvg falls back to a
      // generic sans.
      loadSystemFonts: true,
      defaultFontFamily: "Inter",
    },
  });
  const png = resvg.render().asPng();
  await writeFile(resolve(PUBLIC, outFile), png);
  console.log(`  ${inFile}  →  ${outFile}  (${png.byteLength.toLocaleString()} bytes)`);
}

console.log("Rendering OG + icon PNGs…");
await renderSvg("og.svg", "og.png", { width: 1200 });
await renderSvg("favicon.svg", "apple-touch-icon.png", { width: 180 });
await renderSvg("favicon.svg", "favicon-32.png", { width: 32 });
console.log("Done.");
