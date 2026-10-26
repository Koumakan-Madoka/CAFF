const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const BUILD_DIR = path.join(ROOT_DIR, 'build');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyDir(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) {
    return;
  }

  fs.rmSync(targetDir, { recursive: true, force: true });
  ensureDir(path.dirname(targetDir));
  fs.cpSync(sourceDir, targetDir, { recursive: true });
}

function copyFile(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath)) {
    return;
  }

  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
}

copyDir(path.join(ROOT_DIR, 'public'), path.join(BUILD_DIR, 'public'));
copyDir(path.join(ROOT_DIR, 'assets'), path.join(BUILD_DIR, 'assets'));
// Pinned local terminal assets, including notices. Missing packages fail build;
// no CDN, runtime download, source-tree vendor copy or browser bundler.
const terminalAssets = path.join(BUILD_DIR, 'public', 'vendor', 'planner-terminal');
ensureDir(terminalAssets);
for (const [source, target] of [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/xterm/LICENSE', 'xterm-LICENSE'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
  ['@xterm/addon-fit/LICENSE', 'addon-fit-LICENSE'],
]) fs.copyFileSync(path.join(ROOT_DIR, 'node_modules', source), path.join(terminalAssets, target));
copyFile(path.join(ROOT_DIR, 'scripts', 'chat-schema-backup.mjs'), path.join(BUILD_DIR, 'scripts', 'chat-schema-backup.mjs'));
copyFile(path.join(ROOT_DIR, 'lib', 'pi-sdk-host.mjs'), path.join(BUILD_DIR, 'lib', 'pi-sdk-host.mjs'));
copyFile(path.join(ROOT_DIR, 'lib', 'pi-model-config-validator.mjs'), path.join(BUILD_DIR, 'lib', 'pi-model-config-validator.mjs'));
copyFile(path.join(ROOT_DIR, 'lib', 'pi-model-catalog-host.mjs'), path.join(BUILD_DIR, 'lib', 'pi-model-catalog-host.mjs'));
copyFile(path.join(ROOT_DIR, 'lib', 'proxy-routing.mjs'), path.join(BUILD_DIR, 'lib', 'proxy-routing.mjs'));
copyFile(path.join(ROOT_DIR, 'lib', 'pi-heartbeat-extension.mjs'), path.join(BUILD_DIR, 'lib', 'pi-heartbeat-extension.mjs'));
copyDir(path.join(ROOT_DIR, 'lib', 'pi-extensions'), path.join(BUILD_DIR, 'lib', 'pi-extensions'));
