const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const KEEP_LOCALES = new Set(['en.lproj', 'en_GB.lproj', 'zh_CN.lproj', 'zh_TW.lproj']);

function pruneLocales(resourcesDir) {
  if (!fs.existsSync(resourcesDir)) return;

  for (const entry of fs.readdirSync(resourcesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.lproj')) continue;
    if (KEEP_LOCALES.has(entry.name)) continue;
    fs.rmSync(path.join(resourcesDir, entry.name), { recursive: true, force: true });
  }
}

module.exports = async function adhocSignMac(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  pruneLocales(path.join(appPath, 'Contents', 'Resources'));
  pruneLocales(path.join(appPath, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Resources'));

  execFileSync('codesign', [
    '--force',
    '--deep',
    '--sign',
    '-',
    appPath,
  ], { stdio: 'inherit' });

  execFileSync('codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    appPath,
  ], { stdio: 'inherit' });
};
