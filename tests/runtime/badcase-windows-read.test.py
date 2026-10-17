"""Real Windows/NTFS primitive tests; exclusively self-created temporary trees."""
import hashlib
import importlib.util
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
