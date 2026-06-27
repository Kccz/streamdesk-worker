const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const KEEP_LOCALES = new Set(['en.lproj', 'en_GB.lproj', 'zh_CN.lproj', 'zh_TW.lproj']);
const DEFAULT_BUNDLE_ID = 'cc.streamdesk.worker';

function pruneLocales(resourcesDir) {
  if (!fs.existsSync(resourcesDir)) return;

  for (const entry of fs.readdirSync(resourcesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.lproj')) continue;
    if (KEEP_LOCALES.has(entry.name)) continue;
    fs.rmSync(path.join(resourcesDir, entry.name), { recursive: true, force: true });
  }
}

function sign(target, extraArgs = []) {
  execFileSync('codesign', [
    '--force',
    ...extraArgs,
    '--sign',
    '-',
    target,
  ], { stdio: 'inherit' });
}

function signNestedCode(appPath) {
  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');
  if (!fs.existsSync(frameworksDir)) return;

  for (const entry of fs.readdirSync(frameworksDir)) {
    if (!entry.endsWith('.app') && !entry.endsWith('.framework')) continue;
    sign(path.join(frameworksDir, entry), ['--deep']);
  }
}

module.exports = async function adhocSignMac(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const bundleId = context.packager.appInfo.id || DEFAULT_BUNDLE_ID;

  pruneLocales(path.join(appPath, 'Contents', 'Resources'));
  pruneLocales(path.join(appPath, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Resources'));

  signNestedCode(appPath);
  sign(appPath, ['--requirements', `=designated => identifier "${bundleId}"`]);

  execFileSync('codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    appPath,
  ], { stdio: 'inherit' });
};
