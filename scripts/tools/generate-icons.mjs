// The SVG is the source of truth for every PRboard application icon.
// Run: node scripts/tools/generate-icons.mjs
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

const root = new URL("../../", import.meta.url);
const svg = await readFile(new URL("src/app/icon.svg", root), "utf8");
const render = (source, size) => sharp(Buffer.from(source)).resize(size, size).png().toBuffer();

for (const size of [192, 512]) {
  await writeFile(new URL(`public/icons/icon-${size}.png`, root), await render(svg, size));
}

// Launchers apply their own masks. Keep the mark in the central safe zone.
const fullBleed = svg.replaceAll('rx="112"', 'rx="0"').replace(
  /  <rect x="9"[^\n]+\n/,
  "",
);
await writeFile(new URL("public/icons/icon-512-maskable.png", root), await render(fullBleed, 512));
await writeFile(new URL("src/app/apple-icon.png", root), await render(fullBleed, 180));

// ICO supports PNG payloads; include native small sizes to avoid browser scaling.
const sizes = [16, 32, 48];
const images = await Promise.all(sizes.map((size) => render(svg, size)));
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
images.forEach((image, index) => {
  const entry = 6 + index * 16;
  header[entry] = sizes[index];
  header[entry + 1] = sizes[index];
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(image.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += image.length;
});
await writeFile(new URL("src/app/favicon.ico", root), Buffer.concat([header, ...images]));
console.log("Generated PWA, Apple, and favicon assets from src/app/icon.svg.");
