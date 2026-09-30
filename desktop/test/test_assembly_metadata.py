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
from assemble import assembly_environment, validate_assembly_target, copy_launcher_notices


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

    def test_launcher_notices_match_lock_and_fail_closed_on_changed_text(self):
        import assemble
        inputs = json.loads((assemble.LOCKS / 'native.json').read_text())['targets']['win32-x64']
        notices = self.base / 'notices'
        notices.mkdir()
        copy_launcher_notices(inputs, notices)
        for name, record in inputs['consoleLauncher']['notices'].items():
            self.assertEqual(hashlib.sha256((notices / name).read_bytes()).hexdigest(), record['sha256'])
        inputs['consoleLauncher']['notices']['uv-LICENSE-MIT']['sha256'] = '0' * 64
        for file in notices.iterdir():
            file.unlink()
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            copy_launcher_notices(inputs, notices)
        self.assertEqual(list(notices.iterdir()), [])
        copy_launcher_notices({}, notices)
        self.assertEqual(list(notices.iterdir()), [])

    def test_cross_windows_main_fails_before_source_or_process_or_filesystem_work(self):
        import assemble
        with patch.object(sys, 'argv', ['assemble.py', '--target', 'win32-x64']), \
             patch.object(assemble, 'host_target', return_value='linux-x64'), \
             patch.object(assemble, 'source_provenance') as source, \
             patch.object(assemble.subprocess, 'check_output') as process, \
             patch.object(assemble, 'fetch') as fetch:
            with self.assertRaisesRegex(SystemExit, 'native Windows'):
                assemble.main()
        source.assert_not_called()
        process.assert_not_called()
        fetch.assert_not_called()

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

    def windows_fixture(self, name):
        import windows_launcher as launcher
        from test_windows_launcher import pe_fixture
        fixture = self.fixture(name, windows=True)
        output, destination, dist, wheel, host, script = fixture
        manifest = {(24, 1, 1033): b'<assembly>fixture only</assembly>'}
        base = self.base / 'console-base.exe'
        base.write_bytes(pe_fixture(manifest))
        resources = dict(manifest)
        resources.update({(10, 'UV_TRAMPOLINE_KIND', 0): b'\x01',
                          (10, 'UV_PYTHON_PATH', 0): str(host).encode(),
                          (10, 'UV_SCRIPT_DATA', 0): launcher.script_zip(
                              b'#!' + str(host).encode() + b'\n' + launcher.expected_body('example.cli:main'))})
        script.write_bytes(pe_fixture(resources))
        (dist / 'entry_points.txt').write_text('[console_scripts]\nexample = example.cli:main\n')
        record = dist / 'RECORD'
        with record.open('w', newline='') as stream:
            writer = csv.writer(stream, lineterminator='\n')
            for path in sorted(destination.rglob('*')):
                if path.is_file():
                    data = path.read_bytes()
                    writer.writerow([path.relative_to(destination).as_posix(),
                                     '' if path == record else 'sha256=' + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode(),
                                     '' if path == record else len(data)])
        return fixture, base, manifest

    def test_windows_normalization_real_parser_records_and_deterministic_provenance(self):
        import windows_launcher as launcher
        from test_windows_launcher import pe_fixture
        first, base, manifest = self.windows_fixture('one')
        second, _, _ = self.windows_fixture('two')
        def update(path, resources, api):
            path.write_bytes(pe_fixture(manifest | {(10, key, 0): data for key, data in resources.items()}, timestamp=123))
        results = []
        with patch.object(launcher, 'BASE_SHA256', launcher.digest(base.read_bytes())), \
             patch.object(launcher, 'WindowsResourceAPI'), patch.object(launcher, 'write_resources', update):
            for fixture in (first, second):
                results.append(normalize_installation(fixture[0], fixture[1], fixture[4], 'win32-x64',
                                                     [fixture[3]], windows_launcher_base=base))
                self.verify_record(fixture[1], fixture[2])
        self.assertEqual(results[0], results[1])
        self.assertEqual(results[0]['consoleLaunchers']['count'], 1)
        self.assertNotIn('inputSha256', json.dumps(results))
        self.assertEqual(first[5].read_bytes(), second[5].read_bytes())
        self.assertNotIn(str(first[4]).encode(), first[5].read_bytes())

    def test_windows_failure_does_not_apply_metadata_or_launcher_edits(self):
        import windows_launcher as launcher
        fixture, base, _ = self.windows_fixture('failure')
        before = {p: p.read_bytes() for p in fixture[1].rglob('*') if p.is_file()}
        with patch.object(launcher, 'WindowsResourceAPI'), \
             patch.object(launcher, 'relocate_launcher', side_effect=ValueError('invalid launcher')):
            with self.assertRaisesRegex(ValueError, 'invalid launcher'):
                normalize_installation(fixture[0], fixture[1], fixture[4], 'win32-x64',
                                       [fixture[3]], windows_launcher_base=base)
        self.assertEqual(before, {p: p.read_bytes() for p in fixture[1].rglob('*') if p.is_file()})

    def test_windows_target_rejects_cross_host_and_requires_native_api(self):
        with patch('assemble.host_target', return_value='linux-x64'):
            with self.assertRaisesRegex(SystemExit, 'native Windows'):
                validate_assembly_target('win32-x64')
        with patch('assemble.host_target', return_value='win32-x64'), \
             patch('windows_launcher.WindowsResourceAPI', side_effect=RuntimeError('API unavailable')):
            with self.assertRaisesRegex(RuntimeError, 'API unavailable'):
                validate_assembly_target('win32-x64')
        validate_assembly_target('linux-arm64')

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

    def curated_omission_fixture(self, name='curated'):
        fixture = self.fixture(name)
        rows = [['../../Scripts/' + name + '.exe', 'sha256=archived-hash', '108393']
                for name in ('pip', 'pip3.12', 'pip3')]
        record = fixture[2] / 'RECORD'
        with record.open('a', newline='') as stream:
            csv.writer(stream, lineterminator='\n').writerows(rows)
        policy = {'sha256': 'archive-hash', 'recordOmissions': {
            'archiveSha256': 'archive-hash', 'records': {'example-1.dist-info/RECORD': {
                'recordSha256': hashlib.sha256(record.read_bytes()).hexdigest(), 'absentRows': rows}}}}
        return fixture, policy, rows

    def test_exact_curated_hashed_omissions_preserve_original_rows_in_provenance(self):
        fixture, policy, rows = self.curated_omission_fixture()
        snapshot = upstream_record_omissions(fixture[1], policy)
        result = normalize_installation(fixture[0], fixture[1], fixture[4], 'linux-x64', [fixture[3]], snapshot)
        evidence = result['upstreamOmittedFiles']['example-1.dist-info/RECORD']
        self.assertEqual(evidence['absentRows'], sorted(rows))
        self.assertEqual(evidence['archiveSha256'], policy['sha256'])
        self.assertEqual(evidence['recordSha256'], policy['recordOmissions']['records']['example-1.dist-info/RECORD']['recordSha256'])
        self.verify_record(fixture[1], fixture[2])
        for row in rows:
            self.assertNotIn(row[0], (fixture[2] / 'RECORD').read_text())
            self.assertFalse((fixture[1] / row[0]).exists())

    def test_curated_omissions_reject_archive_record_row_and_extra_missing_changes(self):
        for case in ('archive', 'record', 'row', 'extra', 'no-policy'):
            fixture, policy, rows = self.curated_omission_fixture(case)
            record = fixture[2] / 'RECORD'
            expected = policy['recordOmissions']['records']['example-1.dist-info/RECORD']
            if case == 'archive':
                policy['sha256'] = 'another-archive'
            elif case == 'record':
                record.write_text(record.read_text() + 'another-missing,,\n')
            elif case == 'row':
                expected['absentRows'][0][2] = '1'
            elif case == 'extra':
                record.write_text(record.read_text() + 'another-missing,sha256=other,1\n')
                expected['recordSha256'] = hashlib.sha256(record.read_bytes()).hexdigest()
            elif case == 'no-policy':
                policy = None
            with self.assertRaises(ValueError, msg=case):
                upstream_record_omissions(fixture[1], policy)

    def test_curated_omissions_reject_linked_parent_before_and_after_snapshot(self):
        for after in (False, True):
            fixture, policy, rows = self.curated_omission_fixture(str(after))
            snapshot = upstream_record_omissions(fixture[1], policy) if after else None
            path = (fixture[1] / rows[0][0]).resolve()
            path.parent.symlink_to(self.base / 'absent-link-target', target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'Linked omitted'):
                if after:
                    normalize_installation(fixture[0], fixture[1], fixture[4], 'linux-x64', [fixture[3]], snapshot)
                else:
                    upstream_record_omissions(fixture[1], policy)

    def test_curated_omissions_reject_appearing_file_and_changed_record_after_snapshot(self):
        for case in ('appeared', 'record', 'lost-payload'):
            fixture, policy, rows = self.curated_omission_fixture(case)
            snapshot = upstream_record_omissions(fixture[1], policy)
            if case == 'appeared':
                path = (fixture[1] / rows[0][0]).resolve()
                path.parent.mkdir()
                path.write_bytes(b'unexpected')
            elif case == 'record':
                record = fixture[2] / 'RECORD'
                record.write_text(record.read_text().replace('108393', '108394'))
            else:
                fixture[5].unlink()
            with self.assertRaises(ValueError, msg=case):
                normalize_installation(fixture[0], fixture[1], fixture[4], 'linux-x64', [fixture[3]], snapshot)

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
