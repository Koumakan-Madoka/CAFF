// Explicit Linux offline Docker save experiment. NO load, image deletion, model, SDK or container.
// Only reads a caller-pinned trusted local image and writes/cleans this invocation's temp directory.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { archiveImage, verifyImageArchive } = require('./image-archive.cjs');
// Read-only metadata probe over OUR trusted daemon export, not a general tar importer.
// No extract calls. Member count and JSON reads bounded; nothing from the tar is executed.
const PROBE = `
import hashlib,json,sys,tarfile
with tarfile.open(sys.argv[1],mode='r:') as t:
 entries={}
 for m in t:
  assert len(entries)<16384 and m.name not in entries
  entries[m.name]=m
 def read(name):
  m=entries[name]
  assert m.isfile() and 0<m.size<=1048576
  return t.extractfile(m).read(1048577)
 manifest=json.loads(read('manifest.json'))
 assert isinstance(manifest,list) and len(manifest)==1
 item=manifest[0]
 config=read(item['Config'])
 assert 'sha256:'+hashlib.sha256(config).hexdigest()==sys.argv[2]
 data=json.loads(config)
 assert data['architecture']==sys.argv[3] and data['os']=='linux'
 assert isinstance(item['Layers'],list) and len(item['Layers'])>0
 for name in item['Layers']:
  assert name in entries and entries[name].isfile()
 print(json.dumps({'configHashMatches':True,'architecture':data['architecture'],'os':data['os'],
  'manifestKeys':sorted(item.keys()),'repoTags':item.get('RepoTags'),
  'repositoryDigestInManifest':sys.argv[4] in json.dumps(manifest),
  'members':len(entries),'layers':len(item['Layers'])}))
`;
async function main() {
  if (process.platform !== 'linux') throw Error('linux');
  const args = process.argv.slice(2);
  const arg = name => { const i = args.indexOf('--' + name); if (i < 0 || !args[i + 1]) throw Error('args'); return args[i + 1]; };
  const image = { imageId: arg('image-id'), repositoryDigest: arg('repository-digest'), architecture: arg('architecture'), nodeVersion: arg('node-version'), pythonVersion: arg('python-version') };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-image-export-'));
  try {
    const start = performance.now(), ref = await archiveImage(image, path.join(root, 'image'));
    const exportMs = performance.now() - start, readStart = performance.now(), verified = verifyImageArchive(ref);
    const verifyMs = performance.now() - readStart;
    const metadata = JSON.parse(execFileSync('/usr/bin/python3', ['-c', PROBE, path.join(ref.directory, 'image.tar'), image.imageId, image.architecture, image.repositoryDigest],
      { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 60000, maxBuffer: 65536 }));
    assert.equal(metadata.configHashMatches, true);
    assert.throws(() => verifyImageArchive({ ...ref, archiveHash: '0'.repeat(64) }), { code: 'image_archive_invalid' });
    const file = path.join(ref.directory, 'image.tar'), fd = fs.openSync(file, 'r+'), byte = Buffer.alloc(1);
    try { fs.readSync(fd, byte, 0, 1, 0); byte[0] ^= 1; fs.writeSync(fd, byte, 0, 1, 0); } finally { fs.closeSync(fd); }
    assert.throws(() => verifyImageArchive(ref), { code: 'image_archive_invalid' });
    console.log(JSON.stringify({ ok: true, ...verified, metadataHash: ref.metadataHash, metadataBytes: ref.metadataBytes,
      exportMs: +exportMs.toFixed(3), verifyMs: +verifyMs.toFixed(3), archiveMetadataProbe: metadata,
      corruptedBytesRejected: true, imageLoaded: false, imageRemoved: false, containersCreated: 0, modelInvocations: 0,
      hostSchedulerArchived: false, persistentArchiveRetained: false, acceptance: false }, null, 2));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
if (require.main === module) main().catch(() => { console.error('image_archive_verification_failed'); process.exitCode = 1; });
