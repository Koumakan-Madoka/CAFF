"""Real Windows/NTFS primitive tests; exclusively self-created temporary trees."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
source = Path(__file__).resolve().parents[2] / 'helpers' / 'badcase-capture' / 'windows_read.py'
spec = importlib.util.spec_from_file_location('windows_read', source)
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)


@unittest.skipUnless(os.name == 'nt', 'real Windows NTFS required')
class WindowsRead(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='caff-winread-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'authorized'
        self.root.mkdir()
        (self.root / 'sub').mkdir()
        self.bytes = b'original\x00\xff\r\n'
        (self.root / 'sub' / 'sample.bin').write_bytes(self.bytes)
        self.outside = self.base / 'unauthorized'
        self.outside.mkdir()
        (self.outside / 'sample.bin').write_bytes(b'OUTSIDE_SENTINEL')

    def test_git_input_fixed_binary_files_without_walk_or_pointer_expansion(self):
        request = {**self.session_request(), 'op': 'gitInput', 'path': 'index'}
        data = b'DIRC\x00\xff\r\n'
        (self.root / 'index').write_bytes(data)
        (self.root / 'commondir').write_bytes(b'../../unauthorized\n')
        opened = []
        original = w._relative
        def observe(stack, parent, name, directory):
            opened.append(name)
            return original(stack, parent, name, directory)
        for name, expected in [('index', data), ('commondir', b'../../unauthorized\n')]:
            with self.subTest(name=name), patch.object(w.Root, 'walk', side_effect=AssertionError('no walk')), patch.object(w, '_relative', observe):
                opened.clear()
                out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request({**request, 'path': name})), out)
                header, body = out.getvalue().split(b'\n', 1)
                self.assertTrue(json.loads(header)['ok'], header)
                self.assertEqual(body, expected)
                self.assertEqual(opened, list(self.root.parts[1:]) + [name] * 2)
        for name in ['config', 'gitdir', 'config.worktree', 'info/exclude']:
            target = self.root / name
            target.parent.mkdir(exist_ok=True)
            target.write_bytes(b'fixed\r\n')
            out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request({**request, 'path': name})), out)
            header, body = out.getvalue().split(b'\n', 1)
            self.assertTrue(json.loads(header)['ok'], header)
            self.assertEqual(body, b'fixed\r\n')

    def test_git_input_schema_pin_and_alias_rejected_before_content(self):
        request = {**self.session_request(), 'op': 'gitInput', 'path': 'index'}
        (self.root / 'index').write_bytes(b'DIRC')
        for delta in [{'path': 'INDEX'}, {'path': '../config'}, {'path': 'objects/private'}, {'path': 'worktrees/w/index'},
                      {'path': 'turn.jsonl'}, {'paths': ['index']}, {'excluded': []}, {'_canonical': False}]:
            with self.subTest(delta=delta), patch.object(w, 'Root') as unopened:
                out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request({**request, **delta})), out)
                self.assertEqual(json.loads(out.getvalue()), {'version': 1, 'ok': False, 'code': 'request_invalid'})
            self.assertEqual(unopened.call_count, 0)
        (self.root / 'index').rename(self.root / 'Index')
        with patch.object(w.kernel, 'ReadFile', wraps=w.kernel.ReadFile) as reads:
            out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request(request)), out)
            self.assertEqual(json.loads(out.getvalue())['code'], 'path_not_in_manifest')
        self.assertEqual(reads.call_count, 0)
        with patch.object(w.Root, 'read', wraps=w.Root.read) as reads:
            out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request({**request, 'expected': {**request['expected'], 'fileId': '0' * 32}})), out)
            self.assertEqual(json.loads(out.getvalue())['code'], 'root_identity_mismatch')
        self.assertEqual(reads.call_count, 0)

    def test_git_input_junction_drift_and_limit_no_partial_body(self):
        request = {**self.session_request(), 'op': 'gitInput', 'path': 'info/exclude'}
        (self.outside / 'exclude').write_bytes(b'OUTSIDE_SENTINEL')
        linked = self.root / 'info'
        subprocess.run(['cmd', '/d', '/c', 'mklink', '/J', str(linked), str(self.outside)], check=True, capture_output=True)
        try:
            out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request(request)), out)
            self.assertFalse(json.loads(out.getvalue())['ok']); self.assertNotIn(b'OUTSIDE_SENTINEL', out.getvalue())
        finally:
            linked.rmdir()
        (self.root / 'index').write_bytes(b'FIRST')
        request['path'] = 'index'
        original = w.Root.read
        for field in ['sha256', 'identity']:
            count = 0
            def changed(root, relative, *args, **kwargs):
                nonlocal count
                result = original(root, relative, *args, **kwargs); count += 1
                if count == 2:
                    result[field] = '0' * 64 if field == 'sha256' else {**result[field], 'fileId': '0' * 32}
                return result
            with self.subTest(field=field), patch.object(w.Root, 'read', changed):
                out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request(request)), out)
                header, body = out.getvalue().split(b'\n', 1)
                self.assertEqual(json.loads(header), {'version': 1, 'ok': False, 'code': 'snapshot_changed'})
                self.assertEqual(body, b'')
            self.assertEqual(count, 2)
        with patch.object(w, 'FILE_LIMIT', 4):
            out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request(request)), out)
            header, body = out.getvalue().split(b'\n', 1)
            self.assertEqual(json.loads(header), {'version': 1, 'ok': False, 'code': 'too_large'})
            self.assertEqual(body, b'')

    def session_request(self, relative='sub/turn.jsonl'):
        return {**{k: v for k, v in self.snapshot_request().items() if k != 'excluded'},
                'op': 'sessionInput', 'path': relative}

    def test_session_input_reads_only_exact_file_without_tree_walk(self):
        data = b'{"type":"session","version":3}\n'
        (self.root / 'sub' / 'turn.jsonl').write_bytes(data)
        # Unrelated malformed/reparse subtrees must never be traversed.
        unrelated = self.root / 'unrelated'
        subprocess.run(['cmd', '/d', '/c', 'mklink', '/J', str(unrelated), str(self.outside)], check=True, capture_output=True)
        self.addCleanup(lambda: unrelated.rmdir() if unrelated.exists() else None)
        request = self.session_request()
        listed, opened = [], []
        listing, opening = w._directory_names, w._relative
        def observe_list(handle, limit):
            listed.append(handle)
            return listing(handle, limit)
        def observe_open(stack, handle, name, directory):
            opened.append(name)
            return opening(stack, handle, name, directory)
        with patch.object(w.Root, 'walk', side_effect=AssertionError('no tree walk')), \
                patch.object(w, '_directory_names', observe_list), patch.object(w, '_relative', observe_open):
            out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request(request)), out)
        header, body = out.getvalue().split(b'\n', 1)
        value = json.loads(header)
        self.assertTrue(value['ok'], value)
        self.assertEqual(set(value), {'version', 'ok', 'identity', 'file'})
        self.assertEqual(value['file']['path'], 'sub/turn.jsonl')
        self.assertEqual(value['file']['sha256'], hashlib.sha256(data).hexdigest())
        self.assertEqual(body, data)
        self.assertEqual(opened, list(self.root.parts[1:]) + ['sub', 'turn.jsonl'] * 2)
        self.assertEqual(len(listed), 4, 'only each path ancestor, twice')
        (self.root / 'sub' / 'empty.jsonl').write_bytes(b'')
        out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request(self.session_request('sub/empty.jsonl'))), out)
        self.assertTrue(json.loads(out.getvalue().split(b'\n', 1)[0])['ok'])
        self.assertEqual(out.getvalue().split(b'\n', 1)[1], b'')

    def test_session_input_schema_pin_and_canonical_names_fail_before_reads(self):
        (self.root / 'sub' / 'turn.jsonl').write_bytes(b'{}\n')
        request = self.session_request()
        for delta in [{'path': '../outside.jsonl'}, {'path': 'sub/turn.txt'}, {'path': 'sub//turn.jsonl'},
                      {'paths': ['sub/turn.jsonl']}, {'excluded': []}, {'_canonical': False}]:
            with self.subTest(delta=delta), patch.object(w, 'Root') as unopened:
                out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request({**request, **delta})), out)
                self.assertEqual(json.loads(out.getvalue()), {'version': 1, 'ok': False, 'code': 'request_invalid'})
            self.assertEqual(unopened.call_count, 0, 'syntax rejection before root open')
        for relative in ['SUB/turn.jsonl', 'sub/TURN.jsonl', 'sub/missing.jsonl']:
            with self.subTest(relative=relative), patch.object(w.kernel, 'ReadFile', wraps=w.kernel.ReadFile) as reads:
                out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request(self.session_request(relative))), out)
                self.assertEqual(json.loads(out.getvalue().split(b'\n', 1)[0]),
                                 {'version': 1, 'ok': False, 'code': 'path_not_in_manifest'})
            self.assertEqual(reads.call_count, 0, 'canonical preflight before ReadFile')
        bad_pin = {**request['expected'], 'fileId': '0' * 32}
        with patch.object(w, '_relative', wraps=w._relative) as opens:
            out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request({**request, 'expected': bad_pin})), out)
            self.assertEqual(json.loads(out.getvalue().split(b'\n', 1)[0]),
                             {'version': 1, 'ok': False, 'code': 'root_identity_mismatch'})
        self.assertEqual([call.args[2] for call in opens.call_args_list], list(self.root.parts[1:]),
                         'only root ancestors opened; no session descendant')

    def test_session_input_junction_drift_and_bounds_never_return_partial_body(self):
        (self.root / 'sub' / 'turn.jsonl').write_bytes(b'FIRST')
        linked = self.root / 'linked'
        subprocess.run(['cmd', '/d', '/c', 'mklink', '/J', str(linked), str(self.outside)], check=True, capture_output=True)
        self.addCleanup(lambda: linked.rmdir() if linked.exists() else None)
        (self.outside / 'turn.jsonl').write_bytes(b'OUTSIDE_SENTINEL')
        out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request(self.session_request('linked/turn.jsonl'))), out)
        self.assertFalse(json.loads(out.getvalue())['ok']); self.assertNotIn(b'OUTSIDE_SENTINEL', out.getvalue())
        original = w.Root.read
        for kind in ['bytes', 'identity']:
            count = 0
            def changed(root, relative, *args, **kwargs):
                nonlocal count
                value = original(root, relative, *args, **kwargs); count += 1
                if count == 2:
                    if kind == 'bytes':
                        value = {**value, 'content': b'OTHER', 'sha256': hashlib.sha256(b'OTHER').hexdigest()}
                    else: value = {**value, 'identity': {**value['identity'], 'fileId': '0' * 32}}
                return value
            with self.subTest(kind=kind), patch.object(w.Root, 'read', changed):
                out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request(self.session_request())), out)
                header, body = out.getvalue().split(b'\n', 1)
                self.assertEqual(json.loads(header), {'version': 1, 'ok': False, 'code': 'snapshot_changed'})
                self.assertEqual(body, b'')
                self.assertEqual(count, 2)
        with patch.object(w, 'FILE_LIMIT', 4):
            out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request(self.session_request())), out)
            header, body = out.getvalue().split(b'\n', 1)
            self.assertEqual(json.loads(header), {'version': 1, 'ok': False, 'code': 'too_large'})
            self.assertEqual(body, b'')

    def test_estimate_protocol_never_reads_and_prunes_before_open(self):
        names = ['.PI', '.Pi-Sandbox', '.SSH', '.aws', '.azure', '.gnupg', '.git',
                 '.env', '.ENV.local', 'auth.json', 'credentials.json']
        for parent in [self.root, self.root / 'sub']:
            for name in names:
                (parent / name).mkdir()
                (parent / name / 'private').write_bytes(b'PRIVATE_SENTINEL')
        with w.Root(str(self.root)) as root:
            pin = root.identity
        request = {'version': 1, 'op': 'estimate', 'root': str(self.root), 'expected': pin, 'excluded': []}
        original = w._relative
        opened = []
        def observe(stack, handle, name, directory):
            opened.append(name)
            return original(stack, handle, name, directory)
        with patch.object(w.Root, 'read', side_effect=AssertionError('must not read')), patch.object(w, '_relative', observe):
            output = io.BytesIO()
            w.serve(io.BytesIO(json.dumps(request).encode()), output)
        header = json.loads(output.getvalue())
        self.assertTrue(header['ok'], header)
        self.assertEqual(header['files'], [])
        self.assertEqual([e['path'] for e in header['entries']], ['sub', 'sub/sample.bin'])
        self.assertFalse(set(names) & set(opened), 'pruning precedes child open')
        with patch.object(w, 'Root', side_effect=AssertionError('must not open target')) as unopened:
            for changed in [{**request, 'paths': []}, {**request, 'expected': None}]:
                output = io.BytesIO()
                w.serve(io.BytesIO(json.dumps(changed).encode()), output)
                self.assertFalse(json.loads(output.getvalue())['ok'])
            private = {**request, 'root': str(self.root / '.SSH')}
            output = io.BytesIO(); w.serve(io.BytesIO(json.dumps(private).encode()), output)
            self.assertEqual(json.loads(output.getvalue())['code'], 'estimate_scope_rejected')
            self.assertEqual(unopened.call_count, 0, 'observe outside production catch')

    def test_git_metadata_reads_only_fixed_sources_never_hooks_objects_or_external_gitdir(self):
        git = self.root / '.git'
        git.mkdir(); (git / 'info').mkdir(); (git / 'objects').mkdir(); (git / 'hooks').mkdir()
        (git / 'index').write_bytes(b'index-fixture')
        (git / 'config').write_bytes(b'[core]\nignorecase = false\n')
        (git / 'info' / 'exclude').write_bytes(b'*.local\n')
        (git / 'objects' / 'private').write_bytes(b'PRIVATE_SENTINEL')
        (git / 'hooks' / 'post-checkout').write_bytes(b'PRIVATE_SENTINEL')
        (self.root / '.gitignore').write_bytes(b'ignored\n')
        request = {**self.snapshot_request(), 'op': 'gitMetadata'}
        reads, opened = [], []
        original_read, original_relative = w.Root.read, w._relative
        def read(root, relative, *args, **kwargs):
            reads.append(relative)
            return original_read(root, relative, *args, **kwargs)
        def observe(stack, handle, name, directory):
            opened.append(name)
            return original_relative(stack, handle, name, directory)
        with patch.object(w.Root, 'read', read), patch.object(w, '_relative', observe):
            out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request(request)), out)
        header, body = out.getvalue().split(b'\n', 1); header = json.loads(header)
        self.assertTrue(header['ok'], header)
        expected = ['.git/config', '.git/index', '.git/info/exclude', '.gitignore']
        self.assertEqual(reads, expected * 2)
        self.assertEqual([f['path'] for f in header['files']], expected)
        self.assertNotIn('hooks', opened); self.assertNotIn('objects', opened)
        self.assertNotIn(b'PRIVATE_SENTINEL', body)
        (git / 'index').unlink(); (git / 'index').mkdir()
        reads.clear()
        with patch.object(w.Root, 'read', read):
            out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request(request)), out)
        self.assertEqual(json.loads(out.getvalue())['code'], 'git_metadata_unsupported')
        self.assertEqual(reads, [], 'all fixed-source types checked before any read')
        # Gitfile is returned as data only, never interpreted as authority.
        import shutil
        shutil.rmtree(git)
        git.write_bytes(('gitdir: ' + str(self.outside)).encode())
        with patch.object(w, '_relative', observe):
            opened.clear(); out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request(request)), out)
        self.assertTrue(json.loads(out.getvalue().split(b'\n', 1)[0])['ok'])
        self.assertNotIn('unauthorized', opened)
        self.assertNotIn('sub/sample.bin', reads)

    def test_git_metadata_rejects_nested_and_case_git_before_any_content_read(self):
        # E101 P3: real guard reachable before serve's first content read.
        # Count outside production catch: an assertion thrown inside Root.read
        # could otherwise be swallowed as helper_failed and fake this evidence.
        import shutil
        for relative in ['sub/.git', '.GIT']:
            for kind in ['file', 'directory']:
                target = self.root / relative
                if kind == 'directory':
                    target.mkdir()
                    (target / 'config').write_bytes(b'PRIVATE_SENTINEL')
                else:
                    target.write_bytes(b'gitdir: OUTSIDE_SENTINEL')
                reads = []
                original = w.Root.read
                def observe(root, name, *args, **kwargs):
                    reads.append(name)
                    return original(root, name, *args, **kwargs)
                with patch.object(w.Root, 'read', observe):
                    out = io.BytesIO()
                    w.serve(io.BytesIO(self.wire_request({**self.snapshot_request(), 'op': 'gitMetadata'})), out)
                self.assertEqual(json.loads(out.getvalue()),
                                 {'version': 1, 'ok': False, 'code': 'git_metadata_unsupported'})
                self.assertEqual(reads, [], 'nested/case Git fails before all metadata/content reads')
                if kind == 'directory':
                    shutil.rmtree(target)
                else:
                    target.unlink()

    def test_selected_snapshot_preflights_all_paths_and_never_reads_unselected_ignored_content(self):
        (self.root / 'ignored').write_bytes(b'PRIVATE_SENTINEL')
        request = {**self.snapshot_request(), 'op': 'selectedSnapshot', 'paths': ['sub/sample.bin']}
        original = w.Root.read
        reads = []
        def read(root, relative, *args, **kwargs):
            reads.append(relative); return original(root, relative, *args, **kwargs)
        with patch.object(w.Root, 'read', read):
            out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request(request)), out)
        header, body = out.getvalue().split(b'\n', 1)
        self.assertTrue(json.loads(header)['ok'], header)
        self.assertEqual(reads, ['sub/sample.bin'] * 2)
        self.assertEqual(body, self.bytes)
        for paths in [['SUB/sample.bin'], ['sub/sample.bin', 'missing'], ['sub'], ['.git/index']]:
            reads.clear()
            with patch.object(w.Root, 'read', read):
                out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request({**request, 'paths': paths})), out)
            self.assertEqual(json.loads(out.getvalue())['code'], 'path_not_in_manifest')
            self.assertEqual(reads, [], 'all selectors must pass before first content read')
        # Empty selection is valid, without falling back to all-file snapshot.
        reads.clear()
        with patch.object(w.Root, 'read', read):
            out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request({**request, 'paths': []})), out)
        self.assertTrue(json.loads(out.getvalue())['ok']); self.assertEqual(reads, [])

    def snapshot_request(self):
        with w.Root(str(self.root)) as root:
            pin = root.identity.copy()
        return {'version': 1, 'op': 'snapshot', 'root': str(self.root), 'expected': pin, 'excluded': []}

    def test_snapshot_two_full_reads_pruning_and_exact_body(self):
        (self.root / 'empty').touch()
        (self.root / '中文😀').write_bytes(b'unicode')
        (self.root / '.env').mkdir()
        (self.root / '.env' / 'never-read').write_bytes(b'PRIVATE_SENTINEL')
        request = self.snapshot_request()
        private = {**request, 'root': str(self.root / '.env')}
        out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request(private)), out)
        self.assertEqual(json.loads(out.getvalue())['code'], 'estimate_scope_rejected')
        reads, opened = [], []
        original_read, original_relative = w.Root.read, w._relative
        def observe_read(root, relative, *args, **kwargs):
            reads.append(relative)
            return original_read(root, relative, *args, **kwargs)
        def observe_open(stack, handle, name, directory):
            opened.append(name)
            return original_relative(stack, handle, name, directory)
        with patch.object(w.Root, 'read', observe_read), patch.object(w, '_relative', observe_open):
            out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request(request)), out)
        header, body = out.getvalue().split(b'\n', 1)
        header = json.loads(header)
        self.assertTrue(header['ok'], header)
        self.assertEqual([e['path'] for e in header['files']], ['empty', 'sub/sample.bin', '中文😀'])
        self.assertEqual(body, self.bytes + b'unicode')
        self.assertEqual(reads, ['empty', 'sub/sample.bin', '中文😀'] * 2)
        self.assertNotIn('.env', opened, 'sensitive subtree never opened')
        self.assertNotIn(b'PRIVATE_SENTINEL', out.getvalue())
        with patch.object(w, 'BODY_LIMIT', len(body) - 1):
            out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request(request)), out)
            self.assertEqual(json.loads(out.getvalue())['code'], 'too_large')
        # Request does not expose a path selector, hook, or budget override.
        with patch.object(w, 'Root', side_effect=AssertionError('opened')) as unopened:
            for delta in [{'paths': []}, {'expected': None}, {'_after_scan': True}]:
                out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request({**request, **delta})), out)
                self.assertEqual(json.loads(out.getvalue())['code'], 'request_invalid')
            self.assertEqual(unopened.call_count, 0)

    def test_snapshot_detects_hash_manifest_and_identity_changes_without_partial_body(self):
        request = self.snapshot_request()
        original_read = w.Root.read
        for mode in ['hash', 'added', 'deleted', 'replaced', 'late_metadata']:
            with self.subTest(mode=mode):
                calls = 0
                def read(root, relative, *args, **kwargs):
                    nonlocal calls
                    calls += 1
                    result = original_read(root, relative, *args, **kwargs)
                    if mode == 'hash' and calls == 2:
                        # Simulate a between-read same-size ABA hidden from
                        # metadata: MUST compare the independently read hash.
                        return {**result, 'sha256': '0' * 64}
                    if calls == 1 and mode in ['added', 'deleted', 'replaced']:
                        if mode == 'added': (self.root / 'new').write_bytes(b'new')
                        elif mode == 'deleted': (self.root / 'sub' / 'sample.bin').unlink()
                        else:
                            old = self.root / 'sub' / 'sample.bin'
                            old.unlink(); old.write_bytes(self.bytes)
                    if calls == 2 and mode == 'late_metadata':
                        (self.root / 'sub' / 'sample.bin').write_bytes(self.bytes + b'!')
                    return result
                try:
                    with patch.object(w.Root, 'read', read):
                        out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request(request)), out)
                    self.assertEqual(json.loads(out.getvalue()),
                                     {'version': 1, 'ok': False, 'code': 'snapshot_changed'})
                finally:
                    (self.root / 'sub' / 'sample.bin').write_bytes(self.bytes)
                    if (self.root / 'new').exists(): (self.root / 'new').unlink()
        # Full file count checked before any content read (small injected cap).
        with patch.object(w, 'SNAPSHOT_FILE_LIMIT', 0), patch.object(w.Root, 'read', wraps=original_read) as unread:
            out = io.BytesIO(); w.serve(io.BytesIO(self.wire_request(request)), out)
            self.assertEqual(json.loads(out.getvalue())['code'], 'entry_limit')
            self.assertEqual(unread.call_count, 0)

    def test_exact_bytes_and_identity_roundtrip(self):
        (self.root / 'empty').touch()
        (self.root / '中文😀').write_bytes(b'unicode')
        with w.Root(str(self.root)) as root:
            pin = root.identity.copy()
            value = root.read('sub/sample.bin')
            self.assertEqual(value['content'], self.bytes)
            self.assertEqual(value['sha256'], hashlib.sha256(self.bytes).hexdigest())
            self.assertEqual(value['size'], len(self.bytes))
            self.assertEqual(root.read('sub/sample.bin', len(self.bytes))['content'], self.bytes)
            self.assertEqual(root.read('empty', 0)['content'], b'')
            self.assertEqual(root.read('中文😀')['content'], b'unicode')
            self.assertEqual(set(pin), {'volumeSerial', 'fileId', 'creationTime'})
            self.assertTrue(all(isinstance(v, str) for v in pin.values()))
            self.assertEqual(len(pin['fileId']), 32)
        with w.Root(str(self.root), pin) as root:
            self.assertEqual(root.read('sub/sample.bin')['content'], self.bytes)
        with self.assertRaisesRegex(w.Refused, '^root_closed$'):
            root.read('sub/sample.bin')

    def test_path_aliases_and_escape_rejected(self):
        invalid = ['', '.', '..', '../unauthorized/sample.bin', 'sub/../../unauthorized/sample.bin',
                   '/sample.bin', '//host/share', 'C:/sample.bin', r'sub\sample.bin',
                   'sub//sample.bin', 'sub/./sample.bin', 'sub/../sample.bin', 'sub/sample.bin:ads',
                   'sub/sample.bin.', 'sub/sample.bin ', 'NUL', 'nul.txt', 'COM1.txt', 'LPT¹',
                   'x\x00y', 'x\ny', 'x*', 'x?', 'x|', 'x<', 'x>', 'x"', '\ud800', 'x' * 256]
        with w.Root(str(self.root)) as root:
            for name in invalid:
                with self.subTest(name=ascii(name)), self.assertRaisesRegex(w.Refused, '^path_invalid$'):
                    root.read(name)
        for name in [r'\\?\C:\windows', r'\\server\share', r'\??\C:\windows',
                     'C:relative', 'relative', str(self.root) + '/..']:
            with self.subTest(root=name), self.assertRaises(w.Refused):
                with w.Root(name):
                    self.fail('invalid root accepted')

    def test_wrong_identity_and_replaced_root(self):
        with w.Root(str(self.root)) as root:
            pin = root.identity.copy()
        for key in pin:
            wrong = {**pin, key: pin[key] + '1'}
            with self.subTest(key=key), self.assertRaisesRegex(w.Refused, '^root_identity_mismatch$'):
                with w.Root(str(self.root), wrong):
                    self.fail('incorrect identity accepted')
        moved = self.base / 'old-authorized'
        self.root.rename(moved)
        self.root.mkdir()
        (self.root / 'sample.bin').write_bytes(b'REPLACEMENT')
        with self.assertRaisesRegex(w.Refused, '^root_identity_mismatch$'):
            with w.Root(str(self.root), pin):
                self.fail('replacement accepted')

    def test_junction_at_leaf_intermediate_and_root_rejected(self):
        link = self.root / 'junction'
        # Junction creation needs neither admin nor Windows Developer Mode.
        p = subprocess.run(['cmd.exe', '/d', '/c', 'mklink', '/J', str(link), str(self.outside)],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        self.assertEqual(p.returncode, 0, 'temporary junction creation failed')
        try:
            with w.Root(str(self.root)) as root:
                for name in ['junction', 'junction/sample.bin']:
                    with self.subTest(name=name), self.assertRaises(w.Refused):
                        root.read(name)
            with self.assertRaises(w.Refused):
                with w.Root(str(link)):
                    self.fail('junction root accepted')
            with self.assertRaises(w.Refused):
                with w.Root(str(link / 'nested')):
                    self.fail('junction ancestor accepted')
        finally:
            os.rmdir(link)  # remove junction only; never recurse into its target
        self.assertEqual((self.outside / 'sample.bin').read_bytes(), b'OUTSIDE_SENTINEL')

    def test_held_ancestors_and_leaf_cannot_be_renamed(self):
        with w.Root(str(self.root)) as root:
            with self.assertRaises(PermissionError):
                self.root.rename(self.base / 'swapped')
            def attempt_replacements():
                with self.assertRaises(PermissionError):
                    (self.root / 'sub').rename(self.root / 'old-sub')
                with self.assertRaises(PermissionError):
                    (self.root / 'sub' / 'sample.bin').rename(self.root / 'sub' / 'old.bin')
            self.assertEqual(root.read('sub/sample.bin', _after_open=attempt_replacements)['content'], self.bytes)
        # Handles must be released after read/context exit (not merely process exit).
        (self.root / 'sub' / 'sample.bin').rename(self.root / 'sub' / 'renamed.bin')
        (self.root / 'sub').rename(self.root / 'renamed-sub')
        self.root.rename(self.base / 'released')

    def test_mutation_not_returned_as_stable_and_limits(self):
        with w.Root(str(self.root)) as root:
            for limit in [-1, True, 0.5, 64 * 1024 * 1024 + 1]:
                with self.subTest(limit=limit), self.assertRaisesRegex(w.Refused, '^limit_invalid$'):
                    root.read('sub/sample.bin', limit)
            with self.assertRaisesRegex(w.Refused, '^too_large$'):
                root.read('sub/sample.bin', len(self.bytes) - 1)
            with self.assertRaises(w.Refused):
                root.read('sub')
            with self.assertRaises(w.Refused):
                root.read('missing')
            def mutate():
                file = self.root / 'sub' / 'sample.bin'
                file.write_bytes(b'changed!!xxx')
                os.utime(file, ns=(1700000000000000000, 1700000000000000000))
            with self.assertRaisesRegex(w.Refused, '^changed_during_read$'):
                root.read('sub/sample.bin', _after_open=mutate)

    def test_walk_exact_tree_without_pathname_enumeration(self):
        (self.root / 'empty-dir').mkdir()
        (self.root / '中文😀').write_bytes(b'unicode')
        (self.root / 'sub' / 'empty').touch()
        with w.Root(str(self.root)) as root:
            # No pathname enumeration fallback, even for an ordinary directory.
            with patch.object(os, 'scandir', side_effect=AssertionError('pathname scan')):
                entries = root.walk()
            self.assertEqual([e['path'] for e in entries],
                             ['empty-dir', 'sub', 'sub/empty', 'sub/sample.bin', '中文😀'])
            self.assertEqual([e['type'] for e in entries], ['directory', 'directory', 'file', 'file', 'file'])
            self.assertEqual(entries[3]['size'], len(self.bytes))
            self.assertEqual(entries[2]['size'], 0)
            self.assertTrue(all(set(e) == {'path', 'type', 'size', 'identity', 'lastWriteTime', 'changeTime'} for e in entries))
            self.assertTrue(all(isinstance(e['lastWriteTime'], str) and isinstance(e['changeTime'], str) for e in entries))
            self.assertEqual(root.walk(), entries)  # restart enumeration, not stale handle cursor
        with self.assertRaisesRegex(w.Refused, '^root_closed$'):
            root.walk()
        with w.Root(str(self.outside)) as root:
            self.assertEqual([e['path'] for e in root.walk()], ['sample.bin'])

    def test_walk_entry_depth_and_argument_bounds(self):
        (self.root / 'sub' / 'nested').mkdir()
        (self.root / 'sub' / 'nested' / 'leaf').touch()
        with w.Root(str(self.root)) as root:
            self.assertEqual(len(root.walk(max_entries=4, max_depth=3)), 4)
            for args, reason in [({'max_entries': 3}, 'entry_limit'), ({'max_depth': 2}, 'depth_limit'),
                                 ({'max_entries': True}, 'limit_invalid'), ({'max_entries': 0}, 'limit_invalid'),
                                 ({'max_entries': 100001}, 'limit_invalid'), ({'max_depth': 0}, 'limit_invalid'),
                                 ({'max_depth': 65}, 'limit_invalid'), ({'max_depth': 1.5}, 'limit_invalid')]:
                with self.subTest(args=args), self.assertRaisesRegex(w.Refused, '^' + reason + '$'):
                    root.walk(**args)
        with w.Root(str(self.base)) as root:
            with self.assertRaisesRegex(w.Refused, '^entry_limit$'):
                root.walk(max_entries=1)

    def test_walk_multiple_native_buffers_and_empty_root(self):
        empty = self.base / 'empty'
        empty.mkdir()
        with w.Root(str(empty)) as root:
            self.assertEqual(root.walk(), [])
        # Long names force >64 KiB of FILE_NAMES_INFORMATION, exercising native
        # continuation, final STATUS_NO_MORE_FILES, and restart across two walks.
        for i in range(400):
            (empty / (str(i).zfill(4) + 'x' * 170)).touch()
        with w.Root(str(empty)) as root:
            entries = root.walk(max_entries=400, max_depth=1)
            self.assertEqual(len(entries), 400)
            self.assertEqual(root.walk(max_entries=400, max_depth=1), entries)
            with self.assertRaisesRegex(w.Refused, '^entry_limit$'):
                root.walk(max_entries=399)
            with self.assertRaisesRegex(w.Refused, '^entry_limit$'):
                w._directory_names(root.handle, 399)  # native-buffer cap independent of walk cap

    def test_walk_reparse_refused_without_outside_enumeration(self):
        link = self.root / 'junction'
        p = subprocess.run(['cmd.exe', '/d', '/c', 'mklink', '/J', str(link), str(self.outside)],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        self.assertEqual(p.returncode, 0, 'temporary junction creation failed')
        try:
            with w.Root(str(self.outside)) as outside:
                outside_id = outside.identity.copy()
            seen = []
            original_names = w._directory_names
            def observe(handle, limit):
                ident = w.identity(handle)
                self.assertNotEqual(ident, outside_id, 'enumerated outside object')
                seen.append(ident)
                return original_names(handle, limit)
            with w.Root(str(self.root)) as root, patch.object(w, '_directory_names', side_effect=observe):
                with self.assertRaises(w.Refused):
                    root.walk()
            self.assertTrue(seen)
        finally:
            os.rmdir(link)
        self.assertEqual((self.outside / 'sample.bin').read_bytes(), b'OUTSIDE_SENTINEL')

    def test_walk_mutation_and_handles_on_failure(self):
        with w.Root(str(self.root)) as root:
            def mutate(relative):
                if relative == 'sub':
                    with self.assertRaises(PermissionError):
                        (self.root / 'sub').rename(self.root / 'old-sub')
                    (self.root / 'sub' / 'new').touch()
                    os.utime(self.root / 'sub', ns=(1700000000000000000, 1700000000000000000))
            with self.assertRaisesRegex(w.Refused, '^directory_changed$'):
                root.walk(_after_list=mutate)
            def fail_below_root(relative):
                if relative == 'sub':
                    raise RuntimeError('walk-test')
            for _ in range(20):
                with self.assertRaisesRegex(RuntimeError, '^walk-test$'):
                    root.walk(_after_list=fail_below_root)
                (self.root / 'sub').rename(self.root / 'released-sub')
                (self.root / 'released-sub').rename(self.root / 'sub')
        # Held directory handles on all exceptional paths have been returned.
        (self.root / 'sub').rename(self.root / 'released-sub')
        self.root.rename(self.base / 'released-root')

    def test_case_sensitive_directories_fail_closed(self):
        # Environment rejection is API injection, not a claim of creating a
        # real case-sensitive directory (which may require elevated rights).
        original_query = w._query
        def query(handle, info_type, struct_type):
            if info_type == 23:
                value = struct_type()
                value.Flags = 1
                return value
            return original_query(handle, info_type, struct_type)
        with patch.object(w, '_query', side_effect=query):
            with self.assertRaisesRegex(w.Refused, '^case_sensitive_unsupported$'):
                with w.Root(str(self.root)):
                    self.fail('case-sensitive directory accepted')
        with w.Root(str(self.root)) as root, patch.object(w, '_query', side_effect=query):
            with self.assertRaisesRegex(w.Refused, '^case_sensitive_unsupported$'):
                root.walk()
            with self.assertRaisesRegex(w.Refused, '^case_sensitive_unsupported$'):
                root.read('sub/sample.bin')
        def unavailable(handle, info_type, struct_type):
            if info_type == 23:
                raise w.Refused('metadata_unavailable')
            return original_query(handle, info_type, struct_type)
        with patch.object(w, '_query', side_effect=unavailable):
            with self.assertRaisesRegex(w.Refused, '^metadata_unavailable$'):
                with w.Root(str(self.root)):
                    self.fail('unverified case semantics accepted')

    def test_directory_buffer_parser_rejects_malformed_records(self):
        import struct
        def record(name, next_offset=0):
            text = name.encode('utf-16-le')
            return struct.pack('<III', next_offset, 0, len(text)) + text
        self.assertEqual(w._parse_names(record('中文😀')), ['中文😀'])
        self.assertEqual(w._parse_names(record('.', 16) + b'\x00\x00' + record('..')), [])
        for value in [b'', b'x' * 11, struct.pack('<III', 0, 0, 1) + b'x',
                      struct.pack('<III', 0, 0, 100) + b'x' * 2,
                      struct.pack('<III', 0, 0, 2) + b'\x00\xd8', record('../escape'),
                      record('a', 4), record('a', 15), record('a', 15) + b'\x00' + record('b'),
                      record('a', 4096), record('')]:
            with self.subTest(value=value), self.assertRaises(w.Refused):
                w._parse_names(value)
        with w.Root(str(self.root)) as root:
            for status in [-1, 259, -2147483643]:  # failure, pending, buffer overflow
                with patch.object(w.nt, 'NtQueryDirectoryFile', return_value=status):
                    with self.assertRaisesRegex(w.Refused, '^enumeration_failed$'):
                        root.walk()
            with patch.object(w.nt, 'NtQueryDirectoryFile', return_value=0):
                with self.assertRaisesRegex(w.Refused, '^enumeration_invalid$'):
                    root.walk()  # successful status without valid IO bytes is not empty
            with patch.object(w, '_parse_names', return_value=['duplicate', 'duplicate']):
                with self.assertRaisesRegex(w.Refused, '^directory_changed$'):
                    root.walk()

    def test_exclusions_prune_before_open_and_sort_interleaved_names(self):
        (self.root / 'a').mkdir()
        (self.root / 'a' / 'z').touch()
        (self.root / 'a.b').touch()
        (self.root / 'Private').mkdir()
        (self.root / 'Private' / 'secret').write_bytes(b'PRIVATE_SENTINEL')
        (self.root / 'Private-other').touch()
        (self.root / 'sub' / 'nested').mkdir()
        (self.root / 'sub' / 'nested' / 'hidden').touch()
        link = self.root / 'SkipLink'
        p = subprocess.run(['cmd.exe', '/d', '/c', 'mklink', '/J', str(link), str(self.outside)],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        self.assertEqual(p.returncode, 0)
        original = w._relative
        def observe(stack, parent, name, directory):
            self.assertNotIn(name, ['Private', 'SkipLink', 'nested'], 'opened excluded object')
            return original(stack, parent, name, directory)
        try:
            with w.Root(str(self.root)) as root, patch.object(w, '_relative', side_effect=observe):
                entries = root.walk(excluded=['private', 'skiplink', 'SUB/nested'])
            self.assertEqual([e['path'] for e in entries],
                             ['Private-other', 'a', 'a.b', 'a/z', 'sub', 'sub/sample.bin'])
            with w.Root(str(self.root)) as root:
                for value in ['private', [True], ['../private'], ['private/**'], ['x'] * 257]:
                    with self.subTest(value=value), self.assertRaises(w.Refused):
                        root.walk(excluded=value)
        finally:
            os.rmdir(link)

    def wire_request(self, value):
        return json.dumps(value, ensure_ascii=True, separators=(',', ':')).encode('utf-8')

    def run_wire(self, data):
        run = subprocess.run([sys.executable, '-I', '-B', str(source)], input=data,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        self.assertEqual(run.returncode, 0)
        self.assertEqual(run.stderr, b'')
        self.assertIn(b'\n', run.stdout)
        head, content = run.stdout.split(b'\n', 1)
        return json.loads(head), content

    def test_wire_native_roundtrip_and_identity_mismatch(self):
        request = {'version': 1, 'op': 'identity', 'root': str(self.root)}
        pin_response, body = self.run_wire(self.wire_request(request))
        self.assertEqual(set(pin_response), {'version', 'ok', 'identity'})
        self.assertTrue(pin_response['ok'])
        self.assertEqual(body, b'')
        pin = pin_response['identity']
        (self.root / 'empty').touch()
        request = {'version': 1, 'op': 'capture', 'root': str(self.root), 'expected': pin,
                   'excluded': [], 'paths': ['sub/sample.bin', 'empty']}
        response, body = self.run_wire(self.wire_request(request))
        self.assertEqual(set(response), {'version', 'ok', 'identity', 'entries', 'files'})
        self.assertTrue(response['ok'])
        self.assertEqual(response['identity'], pin)
        self.assertEqual([e['path'] for e in response['entries']], ['empty', 'sub', 'sub/sample.bin'])
        self.assertEqual([e['size'] for e in response['entries']], ['0', '0', str(len(self.bytes))])
        self.assertEqual([e['path'] for e in response['files']], request['paths'])
        self.assertEqual(body, self.bytes)
        self.assertEqual(response['files'][0]['sha256'], hashlib.sha256(self.bytes).hexdigest())
        for key in pin:
            wrong = {**pin, key: ('1' if key != 'fileId' else '1' * 32)}
            if wrong[key] == pin[key]:
                wrong[key] = '2' if key != 'fileId' else '2' * 32
            bad, content = self.run_wire(self.wire_request({**request, 'expected': wrong}))
            self.assertEqual(bad, {'version': 1, 'ok': False, 'code': 'root_identity_mismatch'})
            self.assertEqual(content, b'')
        self.root.rename(self.base / 'old')
        self.root.mkdir()
        bad, body = self.run_wire(self.wire_request(request))
        self.assertEqual(bad['code'], 'root_identity_mismatch')
        self.assertEqual(body, b'')

    def test_wire_exclusions_and_canonical_manifest_gate_all_content(self):
        with w.Root(str(self.root)) as root:
            pin = root.identity.copy()
        (self.root / 'Private').mkdir()
        (self.root / 'Private' / 'secret').write_bytes(b'PRIVATE_SENTINEL')
        request = {'version': 1, 'op': 'capture', 'root': str(self.root), 'expected': pin,
                   'excluded': ['private'], 'paths': []}
        good, body = self.run_wire(self.wire_request(request))
        self.assertTrue(good['ok'])
        self.assertEqual([e['path'] for e in good['entries']], ['sub', 'sub/sample.bin'])
        self.assertEqual(body, b'')
        for name in ['Private/secret', 'PRIVATE/secret', 'sub/SAMPLE.bin', 'SUB/sample.bin', 'sub']:
            bad, body = self.run_wire(self.wire_request({**request, 'paths': ['sub/sample.bin', name]}))
            self.assertEqual(bad, {'version': 1, 'ok': False, 'code': 'path_not_in_manifest'})
            self.assertEqual(body, b'', 'must not leak a successful partial read')
        # NTFS short-name aliases cannot pass membership even if this volume
        # happens to enable 8.3 generation. No guessed alias is opened at all.
        with patch.object(w.Root, 'read', side_effect=AssertionError('content opened')):
            out = io.BytesIO()
            w.serve(io.BytesIO(self.wire_request({**request, 'paths': ['PRIVAT~1/secret']})), out)
            self.assertEqual(json.loads(out.getvalue())['code'], 'path_not_in_manifest')
        # Budget arithmetic exercised with small injected limits, not 128 MiB
        # real files. Per-file native size enforcement remains the same code.
        (self.root / 'sub' / 'second').write_bytes(self.bytes)
        budget_request = {**request, 'paths': ['sub/sample.bin', 'sub/second']}
        with patch.object(w, 'BODY_LIMIT', len(self.bytes) * 2):
            out = io.BytesIO()
            w.serve(io.BytesIO(self.wire_request(budget_request)), out)
            self.assertTrue(json.loads(out.getvalue().split(b'\n', 1)[0])['ok'])
        with patch.object(w, 'BODY_LIMIT', len(self.bytes) * 2 - 1):
            out = io.BytesIO()
            w.serve(io.BytesIO(self.wire_request(budget_request)), out)
            self.assertEqual(json.loads(out.getvalue())['code'], 'too_large')
        with patch.object(w, 'HEADER_LIMIT', 1):
            out = io.BytesIO()
            w.serve(io.BytesIO(self.wire_request(request)), out)
            self.assertEqual(json.loads(out.getvalue())['code'], 'output_limit')
        original_read = w.Root.read
        def change_after_walk(open_root, relative, *args, **kwargs):
            (self.root / 'sub' / 'sample.bin').write_bytes(self.bytes + b'!')
            return original_read(open_root, relative, *args, **kwargs)
        try:
            with patch.object(w.Root, 'read', autospec=True, side_effect=change_after_walk):
                out = io.BytesIO()
                w.serve(io.BytesIO(self.wire_request({**request, 'paths': ['sub/sample.bin']})), out)
                self.assertEqual(json.loads(out.getvalue())['code'], 'changed_during_read')
        finally:
            (self.root / 'sub' / 'sample.bin').write_bytes(self.bytes)
        with w.Root(str(self.root)) as root:
            entry = root.walk()[2]  # sub directory; explicit wrong file pin below
            self.assertEqual(entry['path'], 'sub')
            with self.assertRaisesRegex(w.Refused, '^file_identity_mismatch$'):
                root.read('sub/sample.bin', expected_identity=pin)

    def test_wire_invalid_input_rejected_before_root_open(self):
        pin = {'volumeSerial': '1', 'fileId': '0' * 32, 'creationTime': '1'}
        request = {'version': 1, 'op': 'capture', 'root': str(self.root), 'expected': pin,
                   'excluded': [], 'paths': []}
        duplicate = self.wire_request(request)[:-1] + b',"version":1}'
        over_limit = self.wire_request(request).ljust(1024 * 1024 + 1, b' ')
        invalid = [b'', b'\xff', b'{} {}', duplicate, b'{"x":NaN}',
                   over_limit, self.wire_request({**request, 'extra': True})]
        for changes in [{'version': True}, {'op': 'read'}, {'expected': None},
                        {'expected': {**pin, 'volumeSerial': '18446744073709551616'}},
                        {'expected': {**pin, 'creationTime': '9223372036854775808'}},
                        {'expected': {**pin, 'fileId': 'F' * 32}},
                        {'expected': {**pin, 'volumeSerial': '01'}},
                        {'excluded': 'private'}, {'excluded': ['../private']},
                        {'excluded': ['private/**']}, {'paths': ['sub//x']},
                        {'paths': ['same', 'same']}, {'paths': ['x'] * 2049},
                        {'_after_open': 'untrusted'}, {'root': r'\\server\share'}]:
            invalid.append(self.wire_request({**request, **changes}))
        with patch.object(w, 'Root', side_effect=AssertionError('opened target')):
            for data in invalid:
                out = io.BytesIO()
                w.serve(io.BytesIO(data), out)
                self.assertEqual(json.loads(out.getvalue()),
                                 {'version': 1, 'ok': False, 'code': 'request_invalid'})
        # Exact request limit is accepted, one byte above was rejected above.
        exact = self.wire_request({'version': 1, 'op': 'identity', 'root': str(self.root)}).ljust(1024 * 1024, b' ')
        result, body = self.run_wire(exact)
        self.assertTrue(result['ok'])
        self.assertEqual(body, b'')
        # Internal exception text is never serialized or printed.
        with patch.object(w, 'Root', side_effect=RuntimeError('PRIVATE_SENTINEL')):
            out = io.BytesIO()
            w.serve(io.BytesIO(self.wire_request(request)), out)
            self.assertEqual(json.loads(out.getvalue()),
                             {'version': 1, 'ok': False, 'code': 'helper_failed'})

    def test_exception_paths_release_handles(self):
        # Unsupported environment errors are injected (no access to a real
        # network/removable volume). Ordinary positive opens above are native.
        for drive_type in [0, 1, 2, 4, 5, 6]:
            with patch.object(w.kernel, 'GetDriveTypeW', return_value=drive_type):
                with self.assertRaisesRegex(w.Refused, '^drive_unsupported$'):
                    with w.Root(str(self.root)):
                        self.fail('unsupported drive accepted')
        def refs(*args):
            args[6].value = 'ReFS'
            return 1
        for implementation in [lambda *args: 0, refs]:
            with patch.object(w.kernel, 'GetVolumeInformationByHandleW', side_effect=implementation):
                with self.assertRaisesRegex(w.Refused, '^filesystem_unsupported$'):
                    with w.Root(str(self.root)):
                        self.fail('unsupported filesystem accepted')
        import ctypes as C
        kernel = w.kernel
        kernel.GetCurrentProcess.restype = w.HANDLE
        kernel.GetProcessHandleCount.argtypes = [w.HANDLE, C.POINTER(w.U32)]
        kernel.GetProcessHandleCount.restype = C.c_int
        def count():
            n = w.U32()
            self.assertTrue(kernel.GetProcessHandleCount(kernel.GetCurrentProcess(), C.byref(n)))
            return n.value
        with w.Root(str(self.root)) as root:
            baseline = count()
            for _ in range(50):
                with self.assertRaises(w.Refused):
                    root.read('sub/missing')
                with self.assertRaises(w.Refused):
                    with w.Root(str(self.root), {}):
                        self.fail('bad identity accepted')
                with self.assertRaisesRegex(RuntimeError, '^test$'):
                    root.read('sub/sample.bin', _after_open=lambda: (_ for _ in ()).throw(RuntimeError('test')))
            self.assertEqual(count(), baseline)
        self.root.rename(self.base / 'no-leak')


if __name__ == '__main__':
    unittest.main(verbosity=2)
