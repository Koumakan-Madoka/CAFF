// Trusted host scanner. Known values enter the child only over anonymous stdin;
// blob bytes are streamed in memory, never saved, returned or logged. No pattern
// scan: the user explicitly permits pattern-only strings in preserved history.
const cp = require('node:child_process'), crypto = require('node:crypto');
const fail = () => Object.assign(Error('evaluation_repository_history_scan_failed'), { code: 'evaluation_repository_history_scan_failed' });
function gitArgs(root, args) {
  return ['--no-replace-objects', '-C', root, '-c', 'protocol.allow=never', '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), ...args];
}
function scanGitHistory(recipe, knownValues) {
  try {
    const env = require('./replay-git.cjs').gitEnvironment();
    const output = cp.execFileSync(process.execPath, [__filename], { env, input: JSON.stringify({ ...recipe, knownValues }),
      timeout: 180000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const result = JSON.parse(output);
    if (!Number.isSafeInteger(result.objectBytes) || result.objectBytes < 0 || !Number.isSafeInteger(result.objectCount) || result.objectCount < 1
      || !Number.isSafeInteger(result.commitCount) || result.commitCount < 1 || result.scan?.kind !== 'known-values-blobs-v1'
      || !Number.isSafeInteger(result.scan.blobCount) || result.scan.blobCount < 0 || !Number.isSafeInteger(result.scan.matchCount) || result.scan.matchCount < 0
      || !Array.isArray(result.scan.matchedBlobHashes) || result.scan.matchedBlobHashes.some(s => !new RegExp('^[a-f0-9]{' + recipe.head.length + '}$').test(s))) throw Error();
    return result;
  } catch { throw fail(); }
}
async function scan(input) {
  const { sourceRoot, head, knownValues } = input || {};
  if (typeof sourceRoot !== 'string' || !require('node:path').isAbsolute(sourceRoot) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)
    || !Array.isArray(knownValues) || knownValues.some(v => typeof v !== 'string')) throw Error();
  const env = require('./replay-git.cjs').gitEnvironment();
  const git = (args, options = {}) => cp.execFileSync('git', gitArgs(sourceRoot, args), { env, windowsHide: true, timeout: 120000,
    maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  if (git(['rev-parse', '--is-shallow-repository']).toString().trim() !== 'false') throw Error();
  const names = git(['rev-list', '--objects', '--no-object-names', head]).toString().trim().split('\n');
  const oidPattern = new RegExp('^[a-f0-9]{' + head.length + '}$');
  if (!names.length || new Set(names).size !== names.length || names.some(s => !oidPattern.test(s))) throw Error();
  const listing = git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: names.join('\n') + '\n' }).toString().trim().split('\n');
  if (listing.length !== names.length) throw Error();
  const blobs = []; let objectBytes = 0, commitCount = 0;
  listing.forEach((line, i) => {
    const m = /^([a-f0-9]+) (blob|tree|commit|tag) (\d+)$/.exec(line);
    if (!m || m[1] !== names[i] || !Number.isSafeInteger(Number(m[3]))) throw Error();
    const [, oid, type, size] = m; objectBytes += Number(size);
    if (type === 'blob') blobs.push({ oid, size: Number(size) });
    if (type === 'commit') commitCount++;
  });
  if (!Number.isSafeInteger(objectBytes) || commitCount < 1) throw Error();
  const needles = [...new Set(knownValues)].filter(Boolean).map(v => Buffer.from(v)), overlap = Math.max(0, ...needles.map(b => b.length - 1));
  const matches = [], state = { index: 0, header: Buffer.alloc(0), current: null, separator: false, matchCount: 0 };
  const consume = data => {
    let at = 0;
    while (at < data.length) {
      if (state.separator) { if (data[at++] !== 10) throw Error(); state.separator = false; continue; }
      if (!state.current) {
        const end = data.indexOf(10, at);
        if (end < 0) { state.header = Buffer.concat([state.header, data.subarray(at)]); if (state.header.length > 256) throw Error(); break; }
        const header = Buffer.concat([state.header, data.subarray(at, end)]).toString('ascii'), blob = blobs[state.index++];
        if (!blob || header !== blob.oid + ' blob ' + blob.size) throw Error();
        state.header = Buffer.alloc(0); at = end + 1;
        state.current = { ...blob, remaining: blob.size, hash: crypto.createHash(head.length === 40 ? 'sha1' : 'sha256').update('blob ' + blob.size + '\0'), tail: Buffer.alloc(0), hits: 0 };
      }
      const current = state.current, length = Math.min(current.remaining, data.length - at), bytes = data.subarray(at, at + length);
      current.hash.update(bytes); current.remaining -= length; at += length;
      const probe = current.tail.length ? Buffer.concat([current.tail, bytes]) : bytes;
      for (const needle of needles) {
        for (let p = probe.indexOf(needle); p !== -1; p = probe.indexOf(needle, p + 1)) {
          if (p + needle.length > current.tail.length) current.hits++;
        }
      }
      // Copy only the small boundary tail; do not retain a whole backing chunk.
      current.tail = Buffer.from(probe.subarray(Math.max(0, probe.length - overlap)));
      if (!current.remaining) {
        if (current.hash.digest('hex') !== current.oid) throw Error();
        if (current.hits) { matches.push(current.oid); state.matchCount += current.hits; }
        state.current = null; state.separator = true;
      }
    }
  };
  if (blobs.length) {
    const child = cp.spawn('git', gitArgs(sourceRoot, ['cat-file', '--batch']), { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const ended = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    void ended.catch(() => {}); child.stderr.resume(); child.stdin.on('error', () => {});
    child.stdin.end(blobs.map(b => b.oid).join('\n') + '\n');
    try { for await (const bytes of child.stdout) consume(bytes); if (await ended !== 0) throw Error(); }
    finally { if (child.exitCode === null) child.kill('SIGKILL'); }
  }
  if (state.current || state.header.length || state.separator || state.index !== blobs.length) throw Error();
  return { objectBytes, objectCount: names.length, commitCount, scan: { kind: 'known-values-blobs-v1', blobCount: blobs.length,
    matchCount: state.matchCount, matchedBlobHashes: matches.sort() } };
}
if (require.main === module) {
  const chunks = []; process.stdin.on('data', b => chunks.push(b));
  process.stdin.on('end', () => { let input; try { input = JSON.parse(Buffer.concat(chunks)); } catch { process.exitCode = 1; return; }
    scan(input).then(result => process.stdout.write(JSON.stringify(result))).catch(() => { process.exitCode = 1; }); });
}
module.exports = { scanGitHistory };
