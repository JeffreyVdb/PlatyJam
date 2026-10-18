// Derives every app icon from the original artwork in assets-src/. Run: pnpm icons
//
// The 1254 px original stays out of public/ so it is never served or precached.
// All outputs are opaque PNGs (no alpha): iOS renders transparency unpredictably.
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const SOURCE = fileURLToPath(new URL('../assets-src/platyjam-icon.png', import.meta.url));
const OUT = new URL('../public/', import.meta.url);

// The artwork's flat background, sampled from its corners.
const YELLOW = '#feb102';

// Full-body platypus: big enough to read at Home Screen and manifest sizes.
const full = { left: 0, top: 0, width: 1254, height: 1254 };
// Head and bill only: the full body is an unreadable smudge at favicon sizes.
const head = { left: 250, top: 10, width: 700, height: 700 };

/**
 * @param {string} name
 * @param {number} size output edge in px
 * @param {{ left: number, top: number, width: number, height: number }} crop
 * @param {number} scale fraction of the edge the artwork fills; the rest is yellow padding
 */
async function icon(name, size, crop, scale = 1) {
  const inner = Math.round(size * scale);
  const art = await sharp(SOURCE)
    .extract(crop)
    .resize(inner, inner, { kernel: 'lanczos3' })
    .toBuffer();
  const pad = Math.floor((size - inner) / 2);
  await sharp({ create: { width: size, height: size, channels: 3, background: YELLOW } })
    .composite([{ input: art, left: pad, top: pad }])
    .removeAlpha()
    // Quantised to a 256-colour palette: a third of the size, no visible loss at icon sizes.
    .png({ compressionLevel: 9, palette: true, quality: 92, effort: 10 })
    .toFile(fileURLToPath(new URL(name, OUT)));
  console.log(`${name} ${size}x${size}`);
}

await mkdir(OUT, { recursive: true });

// Manifest icons (purpose "any").
await icon('pwa-192x192.png', 192, full);
await icon('pwa-512x512.png', 512, full);
// Maskable: launchers may crop to a circle of 40% radius, so the whole platypus is
// shrunk into that safe zone (tail and guitar head reach the corners otherwise).
await icon('maskable-icon-512x512.png', 512, full, 0.68);
// iPadOS Home Screen icon. iOS rounds the corners; a little padding keeps the tail
// and the guitar head clear of them.
await icon('apple-touch-icon-180x180.png', 180, full, 0.92);
// Small sizes use the head crop.
await icon('pwa-64x64.png', 64, head);
await icon('favicon-32x32.png', 32, head);
await icon('favicon-48x48.png', 48, head);
// HUD brand mark: 36 CSS px at up to 3x.
await icon('brand-mark-108x108.png', 108, head);
