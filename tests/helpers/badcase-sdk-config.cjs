// Execute the production resolver byte-for-byte with explicit source-platform
// path semantics. No SDK, source-tree reads, DB or child process execution.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
module.exports = function sdkConfig(platform, provider, model, options) {
  const mod = { exports: {} }, sourcePath = path.resolve(__dirname, '../../build/lib/pi-runtime.js');
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), {
    module: mod, exports: mod.exports, __dirname: path.dirname(sourcePath), Buffer,
    process: { env: {}, cwd: () => platform === 'win32' ? 'C:\\source\\project' : '/source/project' },
    require: name => {
      if (name === 'node:path') return platform === 'win32' ? path.win32 : path.posix;
      if (['./sqlite-store', './stream-diagnostics'].includes(name)) return {};
      if (['node:fs', 'node:events', 'node:child_process'].includes(name)) return require(name);
      throw Error('unexpected_resolver_import');
    },
  }, { timeout: 1000 });
  return JSON.parse(JSON.stringify(mod.exports.resolveSdkStartConfig(provider, model, options)));
};
