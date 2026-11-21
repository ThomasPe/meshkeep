// Renders every icon the project ships from the three drawings in src/assets/brand/:
//
//   keep-detail.svg   48 px and up
//   keep-small.svg    20 to 47 px: taller merlons, wider gate
//   keep-tiny.svg     below 20 px: the small drawing without the gate, which is only a smudge there
//
// Run `npm run icons` after changing a drawing and commit the result. Outputs:
//   src-tauri/icons/   window, installer and bundle icons (PNG, ICO, ICNS)
//   msix/Assets/       Store package: tiles in five scales and the unplated taskbar sizes
//   site/assets/       website logo, favicon and touch icon
//
// Chromium (the Playwright one the UI tests use) rasterizes the SVG at the exact target size,
// so no image library is needed. ICON_CHROMIUM overrides the browser binary.
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const brand = join(root, 'src/assets/brand');
const drawings = {
  detail: readFileSync(join(brand, 'keep-detail.svg'), 'utf8'),
  small: readFileSync(join(brand, 'keep-small.svg'), 'utf8'),
  tiny: readFileSync(join(brand, 'keep-tiny.svg'), 'utf8'),
};
/** The drawing for an icon whose artwork is `art` pixels wide. */
const drawingFor = (art) => (art < 20 ? 'tiny' : art < 48 ? 'small' : 'detail');

const browser = await chromium.launch({ executablePath: process.env.ICON_CHROMIUM || undefined });
const page = await browser.newPage();

/**
 * One raster image: the artwork `art` pixels wide, centered on a `width` x `height` canvas
 * (transparent unless `background` is set). Returns the PNG and, for the ICNS legacy
 * entries, the raw RGBA pixels.
 */
async function render({ width, height = width, art = width, background = null, raw = false }) {
  const out = await page.evaluate(
    async ({ svg, width, height, art, background, raw }) => {
      const img = new Image();
      img.src = 'data:image/svg+xml;base64,' + btoa(svg);
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (background) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width, height);
      }
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (width - art) / 2, (height - art) / 2, art, art);
      return {
        png: canvas.toDataURL('image/png').split(',')[1],
        rgba: raw ? Array.from(ctx.getImageData(0, 0, width, height).data) : null,
      };
    },
    { svg: drawings[drawingFor(art)], width, height, art, background, raw },
  );
  return { png: Buffer.from(out.png, 'base64'), rgba: out.rgba ? Buffer.from(out.rgba) : null };
}

/** Artwork size for a canvas: `fraction` of the shorter side, with the parity of the canvas so it centers on whole pixels. */
function artSize(width, height, fraction) {
  let art = Math.round(Math.min(width, height) * fraction);
  if ((width - art) % 2 !== 0) art -= 1;
  return art;
}

let written = 0;
function write(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  written += 1;
}
const png = async (path, options) => write(path, (await render(options)).png);

// ---- src-tauri/icons ---------------------------------------------------------------------

const tauri = join(root, 'src-tauri/icons');
for (const [name, size] of [['32x32', 32], ['64x64', 64], ['128x128', 128], ['128x128@2x', 256], ['icon', 512], ['StoreLogo', 50]]) {
  await png(join(tauri, `${name}.png`), { width: size });
}
for (const size of [30, 44, 71, 89, 107, 142, 150, 284, 310]) {
  await png(join(tauri, `Square${size}x${size}Logo.png`), { width: size });
}

// ICO: a directory of PNG images, smallest first (the layout `tauri icon` writes).
{
  const sizes = [16, 24, 32, 48, 64, 256];
  const images = [];
  for (const size of sizes) images.push((await render({ width: size })).png);
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size === 256 ? 0 : size, at); // 0 means 256
    header.writeUInt8(size === 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4); // colour planes
    header.writeUInt16LE(32, at + 6); // bits per pixel
    header.writeUInt32LE(images[i].length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += images[i].length;
  });
  write(join(tauri, 'icon.ico'), Buffer.concat([header, ...images]));
}

// ICNS: PNG entries for 32 px and up at both densities, plus the two legacy pairs (RGB in
// run-length form and an 8-bit mask) macOS still reads for 16 and 32 px.
{
  const entry = (type, data) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  };
  /** One colour channel as literal runs: a count byte n (0..127) followed by n + 1 bytes. */
  const literalRuns = (channel) => {
    const parts = [];
    for (let i = 0; i < channel.length; i += 128) {
      const chunk = channel.subarray(i, i + 128);
      parts.push(Buffer.from([chunk.length - 1]), chunk);
    }
    return Buffer.concat(parts);
  };
  const legacy = async (size, rgbType, maskType) => {
    const { rgba } = await render({ width: size, raw: true });
    const channel = (c) => Buffer.from(rgba.filter((_, i) => i % 4 === c));
    return [entry(rgbType, Buffer.concat([0, 1, 2].map((c) => literalRuns(channel(c))))), entry(maskType, channel(3))];
  };
  const entries = [];
  for (const [type, size] of [['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]]) {
    entries.push(entry(type, (await render({ width: size })).png));
  }
  entries.push(...(await legacy(16, 'is32', 's8mk')), ...(await legacy(32, 'il32', 'l8mk')));
  const body = Buffer.concat(entries);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(body.length + 8, 4);
  write(join(tauri, 'icon.icns'), Buffer.concat([head, body]));
}

// ---- msix/Assets -------------------------------------------------------------------------

// The folder holds nothing but generated files, so it is rebuilt from scratch: an asset
// that is no longer generated must not stay behind in the package.
const msix = join(root, 'msix/Assets');
for (const file of readdirSync(msix)) rmSync(join(msix, file));

// File names carry the qualifiers resources.pri is built from (msix/build-msix.ps1). The
// unqualified name is the 100 % variant.
const scales = [['', 1], ['.scale-125', 1.25], ['.scale-150', 1.5], ['.scale-200', 2], ['.scale-400', 4]];
const tiles = [
  // name, width, height, share of the shorter side the artwork takes
  ['Square44x44Logo', 44, 44, 1],
  ['StoreLogo', 50, 50, 1],
  ['Square71x71Logo', 71, 71, 0.7],
  ['Square150x150Logo', 150, 150, 0.62],
  ['Wide310x150Logo', 310, 150, 0.62],
  ['Square310x310Logo', 310, 310, 0.58],
];
for (const [name, w, h, fraction] of tiles) {
  for (const [qualifier, factor] of scales) {
    const width = Math.round(w * factor);
    const height = Math.round(h * factor);
    await png(join(msix, `${name}${qualifier}.png`), { width, height, art: artSize(width, height, fraction) });
  }
}
// Taskbar, Start, title bar and Alt+Tab ask for exact pixel sizes. "unplated" keeps Windows
// from putting the icon on a coloured plate; the light variant is the same artwork, it only
// has to exist or the light theme falls back to the plated one.
for (const size of [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256]) {
  const { png: data } = await render({ width: size });
  for (const form of ['', '_altform-unplated', '_altform-lightunplated']) {
    write(join(msix, `Square44x44Logo.targetsize-${size}${form}.png`), data);
  }
}

// ---- site/assets -------------------------------------------------------------------------

const site = join(root, 'site/assets');
await png(join(site, 'icon.png'), { width: 512 });
await png(join(site, 'favicon-32.png'), { width: 32 });
// iOS fills transparency with black, so the touch icon gets the site's light background.
await png(join(site, 'apple-touch-icon.png'), { width: 180, art: artSize(180, 180, 0.76), background: '#f4f5f7' });

await browser.close();
console.log(`${written} icon files written`);
