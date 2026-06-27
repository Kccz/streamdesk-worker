const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const resourcesDir = path.join(root, 'resources');
const trayDir = path.join(resourcesDir, 'tray');
const iconsetDir = path.join(resourcesDir, 'icon.iconset');
const sourceLogo = path.join(resourcesDir, 'admin-logo.webp');
const iconPng = path.join(resourcesDir, 'icon.png');
const iconIcns = path.join(resourcesDir, 'icon.icns');

const iconSizes = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

function sips(args) {
  execFileSync('sips', args, { stdio: 'ignore' });
}

function main() {
  if (!fs.existsSync(sourceLogo)) {
    throw new Error(`Missing source logo: ${sourceLogo}`);
  }

  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.mkdirSync(trayDir, { recursive: true });
  fs.rmSync(iconsetDir, { recursive: true, force: true });
  fs.mkdirSync(iconsetDir, { recursive: true });

  sips(['-s', 'format', 'png', '-z', '1024', '1024', sourceLogo, '--out', iconPng]);
  for (const [name, size] of iconSizes) {
    sips(['-s', 'format', 'png', '-z', String(size), String(size), iconPng, '--out', path.join(iconsetDir, name)]);
  }

  fs.rmSync(iconIcns, { force: true });
  execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', iconIcns], { stdio: 'inherit' });
  fs.rmSync(iconsetDir, { recursive: true, force: true });

  sips(['-s', 'format', 'png', '-z', '16', '16', sourceLogo, '--out', path.join(trayDir, 'iconTemplate.png')]);
  sips(['-s', 'format', 'png', '-z', '32', '32', sourceLogo, '--out', path.join(trayDir, 'iconTemplate@2x.png')]);
}

main();
