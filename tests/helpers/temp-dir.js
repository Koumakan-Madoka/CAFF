const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function withTempDir(prefix = 'caff-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

module.exports = { withTempDir };

