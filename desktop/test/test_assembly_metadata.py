# SPDX-License-Identifier: AGPL-3.0-only
import base64
import csv
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).parents[1] / 'build'))
from assembly_metadata import WHEEL_EPOCH, normalize_installation, relocatable_script, upstream_record_omissions
from assemble import assembly_environment


class AssemblyMetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)

    def fixture(self, name='first', windows=False):
        output = self.base / name
        destination = output / ('python/Lib/site-packages' if windows else 'python/lib/python3.12/site-packages')
        dist = destination / 'example-1.dist-info'
        dist.mkdir(parents=True)
        wheel = self.base / (name + '.whl')
        with zipfile.ZipFile(wheel, 'w') as archive:
            archive.writestr(zipfile.ZipInfo('example-1.dist-info/METADATA', (1980, 1, 1, 0, 0, 0)), 'Name: example\nVersion: 1\n')
        host = self.base / ('deleted host ' + name) / 'python3'
        (dist / 'METADATA').write_text('Name: example\nVersion: 1\n')
        (dist / 'direct_url.json').write_text(json.dumps({'url': wheel.as_uri(), 'archive_info': {}}))
        (dist / 'uv_cache.json').write_text(json.dumps({'timestamp': name}))
        scripts = destination / 'bin'
        scripts.mkdir()
        script = scripts / ('example.exe' if windows else 'example')
        script.write_bytes(b'MZbinary-fixture' if windows else
                           ('#!' + str(host) + '\nimport sys\nprint(sys.argv[1])\n').encode())
        script.chmod(0o755)
        record = dist / 'RECORD'
        record.touch()
        rows = []
        for path in sorted(destination.rglob('*')):
            if path.is_file():
                data = path.read_bytes()
                checksum = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode()
                rows.append([path.relative_to(destination).as_posix(), '' if path == record else 'sha256=' + checksum,
                             '' if path == record else str(len(data))])
        with record.open('w', newline='') as stream:
            csv.writer(stream, lineterminator='\n').writerows(rows)
        return output, destination, dist, wheel, host, script

    def normalize(self, fixture, target='linux-x64'):
        output, destination, _, wheel, host, _ = fixture
        return normalize_installation(output, destination, host, target, [wheel])

    def verify_record(self, destination, dist):
        for name, checksum, size in csv.reader(io.StringIO((dist / 'RECORD').read_text())):
            path = destination / name
            self.assertTrue(path.is_file())
            if path.name == 'RECORD':
                self.assertEqual((checksum, size), ('', ''))
            else:
                data = path.read_bytes()
                self.assertEqual(checksum, 'sha256=' + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode())
                self.assertEqual(int(size), len(data))

    def test_different_build_paths_normalize_to_same_bytes_and_valid_records(self):
        first, second = self.fixture('one'), self.fixture('two')
        for fixture in (first, second):
            self.normalize(fixture)
            self.verify_record(fixture[1], fixture[2])
            self.assertFalse((fixture[2] / 'direct_url.json').exists())
            self.assertFalse((fixture[2] / 'uv_cache.json').exists())
        inventory = lambda root: {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob('*') if p.is_file()}
        self.assertEqual(inventory(first[0]), inventory(second[0]))
        self.assertEqual(first[3].read_bytes(), second[3].read_bytes())

    @unittest.skipIf(sys.platform == 'win32', 'POSIX launcher execution')
    def test_console_script_runs_after_relocation_with_spaces_and_untrusted_path(self):
        fixture = self.fixture('original with spaces')
        self.normalize(fixture)
        interpreter = fixture[0] / 'python/bin/python3'
        interpreter.parent.mkdir(parents=True)
        interpreter.symlink_to(sys.executable)
        relocated = self.base / 'moved with spaces'
        fixture[0].rename(relocated)
        command = relocated / fixture[5].relative_to(fixture[0])
        # The shell wrapper uses builtins only; no interpreter/helper from PATH.
        result = subprocess.run([str(command), 'argument with spaces'], env={'PATH': '/nonexistent'},
                                check=True, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.stdout, 'argument with spaces\n')
        direct = subprocess.run([sys.executable, str(command), 'direct'], check=True,
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(direct.stdout, 'direct\n')

    def test_windows_binary_launcher_is_preserved(self):
        fixture = self.fixture(windows=True)
        before = fixture[5].read_bytes()
        result = self.normalize(fixture, 'win32-x64')
        self.assertEqual(fixture[5].read_bytes(), before)
        self.assertEqual(result['consoleLaunchers'], 'unchanged-windows')
        self.verify_record(fixture[1], fixture[2])

    @unittest.skipIf(sys.platform == 'win32', 'POSIX launcher execution')
    def test_basename_invocation_from_script_directory_with_empty_path(self):
        fixture = self.fixture()
        self.normalize(fixture)
        interpreter = fixture[0] / 'python/bin/python3'
        interpreter.parent.mkdir(parents=True)
        interpreter.symlink_to(sys.executable)
        result = subprocess.run([fixture[5].name, 'basename'], cwd=fixture[5].parent,
                                env={'PATH': ''}, check=True, capture_output=True,
                                text=True, timeout=5)
        self.assertEqual(result.stdout, 'basename\n')

    @unittest.skipIf(sys.platform == 'win32', 'POSIX launcher execution')
    def test_directory_resolution_failure_never_executes_absolute_fallback(self):
        fixture = self.fixture()
        sentinel = self.base / 'would-be-host-python'
        marker = self.base / 'host-python-executed'
        sentinel.write_text('#!/bin/sh\nprintf executed > "' + str(marker) + '"\n')
        sentinel.chmod(0o755)
        # If failed resolution becomes an empty string, /<relative_python>
        # addresses this sentinel just as /../../../../bin/python3 reaches host
        # Python. Exercise the actual shell prefix, not a mocked resolver.
        fixture[5].write_bytes(relocatable_script(fixture[5].read_bytes(), fixture[4],
                                                 str(sentinel).lstrip('/')))
        result = subprocess.run(['/bin/sh', '-c', '. "$1"',
                                 str(self.base / 'absent/script'), str(fixture[5])],
                                env={'PATH': ''}, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 127)
        self.assertFalse(marker.exists())
        self.assertEqual(result.stdout, '')

    def test_macos_and_cross_arm_use_relative_target_python_without_execution(self):
        for index, target in enumerate(('darwin-arm64', 'linux-arm64')):
            fixture = self.fixture(str(index))
            self.normalize(fixture, target)
            self.assertIn(b'/../../../../bin/python3', fixture[5].read_bytes())
            self.verify_record(fixture[1], fixture[2])

    def test_unknown_shebang_fails_before_mutating_metadata(self):
        fixture = self.fixture()
        fixture[5].write_bytes(b'#!/usr/bin/other\nbody\n')
        with self.assertRaisesRegex(ValueError, 'Unrecognized'):
            self.normalize(fixture)
        self.assertTrue((fixture[2] / 'uv_cache.json').exists())

    def test_wrong_local_origin_fails_closed(self):
        fixture = self.fixture()
        (fixture[2] / 'direct_url.json').write_text('{"url":"file:///different.whl"}')
        with self.assertRaisesRegex(ValueError, 'origin'):
            self.normalize(fixture)
        self.assertTrue((fixture[2] / 'uv_cache.json').exists())

    def test_missing_record_file_is_not_silently_dropped(self):
        fixture = self.fixture()
        fixture[5].unlink()
        with self.assertRaisesRegex(ValueError, 'Missing'):
            self.normalize(fixture)

    def test_record_escape_rejected(self):
        fixture = self.fixture()
        with (fixture[2] / 'RECORD').open('a') as stream:
            stream.write('../../../../../../outside,,\n')
        with self.assertRaisesRegex(ValueError, 'escaping'):
            self.normalize(fixture)

    def test_uv_shell_trampoline_retains_body(self):
        host = Path('/temporary host/python3')
        for quoted in ("'/temporary host/python3'", '"/temporary host/python3"'):
            data = ("#!/bin/sh\n'''exec' " + quoted + ' "$0" "$@"\n' + "' '''\nprint('body')\n").encode()
            actual = relocatable_script(data, host, '../../../../bin/python3')
            self.assertTrue(actual.endswith(b"print('body')\n"))
            self.assertNotIn(b'temporary host', actual)

    def test_build_environment_overrides_ambient_epoch_and_random_hash_seed(self):
        with patch.dict('os.environ', {'SOURCE_DATE_EPOCH': '1790000000', 'PYTHONHASHSEED': 'random'}):
            env = assembly_environment(self.base)
        self.assertEqual(env['SOURCE_DATE_EPOCH'], str(WHEEL_EPOCH))
        self.assertEqual(WHEEL_EPOCH, 315532800)
        self.assertEqual(env['PYTHONHASHSEED'], '0')
        self.assertEqual(env['UV_PYTHON_DOWNLOADS'], 'never')

    def test_record_link_rejected_before_rewrite(self):
        fixture = self.fixture()
        fixture[5].unlink()
        fixture[5].symlink_to(fixture[2] / 'METADATA')
        with self.assertRaisesRegex(ValueError, 'escaping'):
            self.normalize(fixture)
        self.assertTrue((fixture[2] / 'uv_cache.json').exists())

    def add_stripped_bytecode_record(self, fixture):
        destination, dist = fixture[1:3]
        source = destination / 'example/module.py'
        source.parent.mkdir()
        source.write_bytes(b'value = 1\n')
        absent = 'example/__pycache__/module.cpython-312.pyc'
        with (dist / 'RECORD').open('a') as stream:
            stream.write('example/module.py,,\n' + absent + ',,\n')
        return absent

    def test_only_snapshotted_upstream_stripped_bytecode_rows_are_removed(self):
        fixture = self.fixture()
        absent = self.add_stripped_bytecode_record(fixture)
        snapshot = upstream_record_omissions(fixture[1])
        original_hash = hashlib.sha256((fixture[2] / 'RECORD').read_bytes()).hexdigest()
        result = normalize_installation(fixture[0], fixture[1], fixture[4], 'linux-x64', [fixture[3]], snapshot)
        self.assertNotIn(absent, (fixture[2] / 'RECORD').read_text())
        self.verify_record(fixture[1], fixture[2])
        evidence = result['upstreamOmittedBytecode']['example-1.dist-info/RECORD']
        self.assertEqual(evidence, {'recordSha256': original_hash, 'absentBytecode': [absent]})

    def test_missing_bytecode_without_upstream_snapshot_is_rejected(self):
        fixture = self.fixture()
        self.add_stripped_bytecode_record(fixture)
        with self.assertRaisesRegex(ValueError, 'Missing'):
            self.normalize(fixture)

    def test_modified_record_after_snapshot_is_rejected(self):
        fixture = self.fixture()
        self.add_stripped_bytecode_record(fixture)
        snapshot = upstream_record_omissions(fixture[1])
        with (fixture[2] / 'RECORD').open('a') as stream:
            stream.write('example/__pycache__/new.cpython-312.pyc,,\n')
        with self.assertRaisesRegex(ValueError, 'changed after'):
            normalize_installation(fixture[0], fixture[1], fixture[4], 'linux-x64', [fixture[3]], snapshot)

    def test_upstream_snapshot_rejects_missing_hashed_or_nonbytecode_files(self):
        for index, row in enumerate(('missing.py,,', 'example/__pycache__/module.cpython-312.pyc,sha256=abc,1')):
            fixture = self.fixture(str(index))
            with (fixture[2] / 'RECORD').open('a') as stream:
                stream.write(row + '\n')
            with self.assertRaisesRegex(ValueError, 'Unexpected missing'):
                upstream_record_omissions(fixture[1])

    def test_file_lost_after_snapshot_still_fails(self):
        fixture = self.fixture()
        self.add_stripped_bytecode_record(fixture)
        snapshot = upstream_record_omissions(fixture[1])
        fixture[5].unlink()
        with self.assertRaisesRegex(ValueError, 'Missing'):
            normalize_installation(fixture[0], fixture[1], fixture[4], 'linux-x64', [fixture[3]], snapshot)

    def test_dangling_bytecode_link_before_snapshot_is_rejected(self):
        fixture = self.fixture()
        absent = self.add_stripped_bytecode_record(fixture)
        path = fixture[1] / absent
        path.parent.mkdir()
        path.symlink_to(self.base / 'missing-bytecode')
        with self.assertRaisesRegex(ValueError, 'Linked omitted-bytecode'):
            upstream_record_omissions(fixture[1])

    def test_dangling_bytecode_link_after_snapshot_is_rejected(self):
        fixture = self.fixture()
        absent = self.add_stripped_bytecode_record(fixture)
        snapshot = upstream_record_omissions(fixture[1])
        path = fixture[1] / absent
        path.parent.mkdir()
        path.symlink_to(self.base / 'missing-bytecode')
        with self.assertRaisesRegex(ValueError, 'Linked omitted-bytecode'):
            normalize_installation(fixture[0], fixture[1], fixture[4], 'linux-x64', [fixture[3]], snapshot)
        self.assertIn(absent, (fixture[2] / 'RECORD').read_text())

    def test_linked_bytecode_parent_after_snapshot_is_rejected(self):
        for index, existing in enumerate((False, True)):
            fixture = self.fixture(str(index))
            absent = self.add_stripped_bytecode_record(fixture)
            snapshot = upstream_record_omissions(fixture[1])
            target = self.base / ('redirect-' + str(index))
            if existing:
                target.mkdir()
            (fixture[1] / absent).parent.symlink_to(target, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'Linked omitted-bytecode'):
                normalize_installation(fixture[0], fixture[1], fixture[4], 'linux-x64', [fixture[3]], snapshot)
            self.assertIn(absent, (fixture[2] / 'RECORD').read_text())

    def test_linked_bytecode_parent_before_snapshot_is_rejected(self):
        fixture = self.fixture()
        absent = self.add_stripped_bytecode_record(fixture)
        (fixture[1] / absent).parent.symlink_to(self.base / 'missing-directory', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'Linked omitted-bytecode'):
            upstream_record_omissions(fixture[1])


if __name__ == '__main__':
    unittest.main()
