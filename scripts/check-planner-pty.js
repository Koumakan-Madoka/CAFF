// CI/local native toolchain check. Does not start a terminal or real Claude.
const fs = require('node:fs');
const path = require('node:path');
const root = path.dirname(require.resolve('node-pty/package.json'));
function requireFile(file) {
  if (!fs.statSync(file).isFile()) throw new Error('Missing node-pty build artifact');
  fs.accessSync(file, fs.constants.R_OK);
}
if (process.platform === 'win32') {
  const utilsPath = require.resolve('node-pty/lib/utils');
  const native = require(utilsPath).loadNativeModule('conpty');
  for (const name of ['conpty.dll', 'OpenConsole.exe']) {
    requireFile(path.resolve(path.dirname(utilsPath), native.dir, 'conpty', name));
    // The pinned 1.1.0 distribution must include both Windows architectures.
    for (const arch of ['x64', 'arm64']) requireFile(path.join(root, 'prebuilds', 'win32-' + arch, 'conpty', name));
  }
} else if (process.platform === 'linux') requireFile(path.join(root, 'build/Release/pty.node'));
require('node-pty');
console.info('node-pty native artifacts available for ' + process.platform + '-' + process.arch);
