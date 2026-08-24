const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

module.exports = async function verifyMacApp(context) {
  if (process.platform !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const packedFramework = path.join(
    context.appOutDir,
    appName,
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Versions',
    'A',
    'Electron Framework'
  );
  const sourceFramework = path.join(
    context.packager.projectDir,
    'node_modules',
    'electron',
    'dist',
    'Electron.app',
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Versions',
    'A',
    'Electron Framework'
  );

  await Promise.all([fsp.access(sourceFramework), fsp.access(packedFramework)]);
  const [sourceHash, packedHash] = await Promise.all([sha256(sourceFramework), sha256(packedFramework)]);
  if (sourceHash !== packedHash) {
    throw new Error(
      `[mac-package] Electron Framework changed during packaging: source=${sourceHash} packed=${packedHash}`
    );
  }
  console.log(`[mac-package] Electron Framework integrity PASS sha256=${packedHash}`);
};
