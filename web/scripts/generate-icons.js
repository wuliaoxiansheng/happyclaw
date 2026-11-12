#!/usr/bin/env node
import { readFileSync, existsSync } from 'fs';
import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const publicDir = join(__dirname, '..', 'public', 'icons');

const sizes = [48, 72, 96, 128, 144, 152, 192, 384, 512];
const maskableSizes = [192, 512];
// `--maskable-only` regenerates just the maskable icons.
const maskableOnly = process.argv.includes('--maskable-only');

// Launchers crop maskable icons to any shape that contains the centre 80%
// circle, so the logo square takes 80% and the rest is bleed.
const MASKABLE_LOGO_FRACTION = 0.8;
const WORK_SIZE = 1024;

function isNearWhite(data, i) {
  return data[i] > 250 && data[i + 1] > 250 && data[i + 2] > 250;
}

/**
 * The logo is a rounded square on white whose artwork bleeds off its edges.
 * Repaint the white corners (and their anti-aliased rim) with the colour just
 * inside the rounded edge, then copy the edge pixels outward, so the bleed
 * continues to the mask edge instead of showing white corners or a frame.
 */
async function generateMaskableIcons(sourceBuffer) {
  const { data } = await sharp(sourceBuffer)
    .resize(WORK_SIZE, WORK_SIZE)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Corner radius from the white run along the top-left diagonal:
  // the rounded edge crosses the diagonal at r·(1 − 1/√2).
  let run = 0;
  while (run < WORK_SIZE / 2 && isNearWhite(data, (run * WORK_SIZE + run) * 4))
    run++;
  const radius = run / (1 - Math.SQRT1_2);
  // Sample this far inside the edge so the rim's blend never gets copied.
  const inner = radius - 3;
  const last = WORK_SIZE - 1;
  for (let y = 0; y < WORK_SIZE; y++) {
    for (let x = 0; x < WORK_SIZE; x++) {
      const cx = x < radius ? radius : x > last - radius ? last - radius : x;
      const cy = y < radius ? radius : y > last - radius ? last - radius : y;
      const dist = Math.hypot(x - cx, y - cy);
      if (dist <= inner) continue;
      const sx = Math.round(cx + ((x - cx) * inner) / dist);
      const sy = Math.round(cy + ((y - cy) * inner) / dist);
      const j = (sy * WORK_SIZE + sx) * 4;
      data.copy(data, (y * WORK_SIZE + x) * 4, j, j + 4);
    }
  }

  const pad = Math.round((WORK_SIZE / MASKABLE_LOGO_FRACTION - WORK_SIZE) / 2);
  const bled = await sharp(data, {
    raw: { width: WORK_SIZE, height: WORK_SIZE, channels: 4 },
  })
    .extend({
      top: pad,
      bottom: pad,
      left: pad,
      right: pad,
      extendWith: 'copy',
    })
    .png()
    .toBuffer();

  for (const size of maskableSizes) {
    const maskablePath = join(publicDir, `icon-${size}-maskable.png`);
    console.log(`Generating ${maskablePath}...`);
    await sharp(bled).resize(size, size).png().toFile(maskablePath);
    console.log(`✓ Generated ${maskablePath}`);
  }
}

async function generateIcons() {
  // Try to use high-res source first, fallback to favicon.svg
  const logo1024Path = join(publicDir, 'logo-1024.png');
  const faviconPath = join(__dirname, '..', 'public', 'favicon.svg');
  const sourcePath = existsSync(logo1024Path) ? logo1024Path : faviconPath;

  console.log(`Using source: ${sourcePath}`);
  const sourceBuffer = readFileSync(sourcePath);

  if (maskableOnly) {
    await generateMaskableIcons(sourceBuffer);
    return;
  }

  // Generate standard icons
  for (const size of sizes) {
    const pngPath = join(publicDir, `icon-${size}.png`);
    console.log(`Generating ${pngPath}...`);

    await sharp(sourceBuffer).resize(size, size).png().toFile(pngPath);

    console.log(`✓ Generated ${pngPath}`);
  }

  await generateMaskableIcons(sourceBuffer);

  // Generate Apple Touch Icon (180x180)
  const appleTouchIconPath = join(publicDir, 'apple-touch-icon-180.png');
  console.log(`Generating ${appleTouchIconPath}...`);

  await sharp(sourceBuffer).resize(180, 180).png().toFile(appleTouchIconPath);

  console.log(`✓ Generated ${appleTouchIconPath}`);

  console.log('\n✅ All icons generated successfully!');
}

generateIcons().catch((error) => {
  console.error('❌ Error generating icons:', error);
  process.exit(1);
});
