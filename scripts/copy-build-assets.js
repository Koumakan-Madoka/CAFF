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
copyFile(path.join(ROOT_DIR, 'scripts', 'chat-schema-backup.mjs'), path.join(BUILD_DIR, 'scripts', 'chat-schema-backup.mjs'));
copyFile(path.join(ROOT_DIR, 'lib', 'pi-sdk-host.mjs'), path.join(BUILD_DIR, 'lib', 'pi-sdk-host.mjs'));
copyFile(path.join(ROOT_DIR, 'lib', 'pi-model-config-validator.mjs'), path.join(BUILD_DIR, 'lib', 'pi-model-config-validator.mjs'));
copyFile(path.join(ROOT_DIR, 'lib', 'pi-model-catalog-host.mjs'), path.join(BUILD_DIR, 'lib', 'pi-model-catalog-host.mjs'));
copyFile(path.join(ROOT_DIR, 'lib', 'pi-heartbeat-extension.mjs'), path.join(BUILD_DIR, 'lib', 'pi-heartbeat-extension.mjs'));
copyDir(path.join(ROOT_DIR, 'lib', 'pi-extensions'), path.join(BUILD_DIR, 'lib', 'pi-extensions'));
