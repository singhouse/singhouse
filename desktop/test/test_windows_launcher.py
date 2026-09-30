# SPDX-License-Identifier: AGPL-3.0-only
"""Synthetic PE/ZIP fixtures only; these tests do not execute Windows binaries."""
import base64
import csv
import io
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).parents[1] / 'build'))
import windows_launcher as launcher

OLD = r'C:\temporary build\python\python.exe'
ENTRY = 'example.cli:main'


def resource_blob(resources, rva=8192, timestamp=0):
    """Build a minimal independent standard three-level resource tree."""
    tree = {}
    for (kind, name, language), data in resources.items():
        tree.setdefault(kind, {}).setdefault(name, {})[language] = data
    result = bytearray()

    def allocate(size):
        offset = len(result)
        result.extend(b'\0' * size)
        return offset

    def directory(items):
        keys = sorted(items, key=lambda key: (isinstance(key, int), key))
        offset = allocate(16 + len(keys) * 8)
        named = sum(isinstance(key, str) for key in keys)
        struct.pack_into('<IIHHHH', result, offset, 0, timestamp, 0, 0, named, len(keys) - named)
        for index, key in enumerate(keys):
            encoded = key
            if isinstance(key, str):
                name = key.encode('utf-16le')
                encoded = allocate(len(name) + 2)
                struct.pack_into('<H', result, encoded, len(key))
                result[encoded + 2:encoded + 2 + len(name)] = name
                encoded |= 0x80000000
            value = items[key]
            if isinstance(value, dict):
                child = directory(value) | 0x80000000
            else:
                child = allocate(16)
                data_offset = allocate(len(value))
                result[data_offset:data_offset + len(value)] = value
                struct.pack_into('<IIII', result, child, rva + data_offset, len(value), 1252, 0)
            struct.pack_into('<II', result, offset + 16 + index * 8, encoded, child)
        return offset
    assert directory(tree) == 0
    return bytes(result)


def pe_fixture(resources, timestamp=0):
    blob = resource_blob(resources, timestamp=timestamp)
    size = (len(blob) + 511) // 512 * 512
    data = bytearray(1024 + size)
    data[:2] = b'MZ'
    struct.pack_into('<I', data, 60, 128)
    data[128:132] = b'PE\0\0'
    struct.pack_into('<HHIIIHH', data, 132, 0x8664, 2, timestamp, 0, 0, 240, 0x22)
    opt = 152
    struct.pack_into('<H', data, opt, 0x20b)
    struct.pack_into('<I', data, opt + 8, size)
    struct.pack_into('<I', data, opt + 16, 4096)
    struct.pack_into('<Q', data, opt + 24, 0x140000000)
    struct.pack_into('<II', data, opt + 32, 4096, 512)
    struct.pack_into('<II', data, opt + 56, 12288, 512)
    struct.pack_into('<H', data, opt + 68, 3)
    struct.pack_into('<I', data, opt + 108, 16)
    struct.pack_into('<II', data, opt + 128, 8192, len(blob))
    struct.pack_into('<8sIIIIIIHHI', data, 392, b'.text', 512, 4096, 512, 512, 0, 0, 0, 0, 0x60000020)
    struct.pack_into('<8sIIIIIIHHI', data, 432, b'.rsrc', len(blob), 8192, size, 1024, 0, 0, 0, 0, 0x40000040)
    data[512:1024] = b'C' * 512
    data[1024:1024 + len(blob)] = blob
    return bytes(data)


class WindowsLauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.base_resources = {(24, 1, 1033): b'<assembly>fixture only</assembly>'}
        self.base = pe_fixture(self.base_resources)
        self.resources = dict(self.base_resources)
        self.resources.update({(10, 'UV_TRAMPOLINE_KIND', 0): b'\x01',
                               (10, 'UV_PYTHON_PATH', 0): OLD.encode(),
                               (10, 'UV_SCRIPT_DATA', 0): launcher.script_zip(b'#!' + OLD.encode() + b'\n' + launcher.expected_body(ENTRY))})
        self.source = pe_fixture(self.resources)
        # Only test fixtures override the production SHA pin; public API has no
        # configurable trust override.
        self.pin = patch.object(launcher, 'BASE_SHA256', launcher.digest(self.base))
        self.pin.start()
        self.addCleanup(self.pin.stop)

    def prepare(self, source=None):
        return launcher.prepare_resources(self.source if source is None else source, self.base, OLD, ENTRY)

    def test_normalization_changes_only_first_script_line_and_resource_target(self):
        result = self.prepare()
        self.assertEqual(result['UV_PYTHON_PATH'], launcher.RELATIVE_PYTHON.encode())
        script = launcher.read_script(result['UV_SCRIPT_DATA'])
        self.assertEqual(script.split(b'\n', 1)[1], launcher.expected_body(ENTRY))
        self.assertNotIn(OLD.encode(), script)

    def test_different_build_prefixes_produce_identical_resource_bytes(self):
        result = self.prepare()
        old2 = r'D:\other user\host-toolchain-other\python.exe'
        resources = dict(self.resources)
        resources[(10, 'UV_PYTHON_PATH', 0)] = old2.encode()
        resources[(10, 'UV_SCRIPT_DATA', 0)] = launcher.script_zip(b'#!' + old2.encode() + b'\n' + launcher.expected_body(ENTRY))
        self.assertEqual(result, launcher.prepare_resources(pe_fixture(resources), self.base, old2, ENTRY))

    def test_normalized_resources_are_idempotent(self):
        result = self.prepare()
        resources = dict(self.base_resources)
        resources.update({(10, key, 0): value for key, value in result.items()})
        self.assertEqual(self.prepare(pe_fixture(resources)), result)

    def test_pinned_code_mutation_is_rejected(self):
        data = bytearray(self.source)
        data[512] ^= 1
        with self.assertRaisesRegex(ValueError, 'code/header'):
            self.prepare(bytes(data))

    def test_base_checksum_cannot_be_substituted(self):
        with self.assertRaisesRegex(ValueError, 'checksum'):
            launcher.validate_base(self.base + b'changed')

    def test_non_x64_and_nonconsole_and_signed_inputs_rejected(self):
        for offset, fmt, value in ((132, '<H', 0x14c), (220, '<H', 2), (296, '<I', 512)):
            data = bytearray(self.source)
            struct.pack_into(fmt, data, offset, value)
            with self.assertRaises(ValueError):
                self.prepare(bytes(data))

    def test_truncation_and_overlay_rejected(self):
        for data in (self.source[:30], self.source[:-1], self.source + b'junk'):
            with self.assertRaises(ValueError):
                launcher.PE(data)

    def test_out_of_bounds_pe_and_overlapping_sections_rejected(self):
        for offset, value in ((60, 0xfffffff0), (432 + 20, 512), (432 + 12, 4096)):
            data = bytearray(self.source)
            struct.pack_into('<I', data, offset, value)
            with self.assertRaises(ValueError):
                launcher.PE(data)

    def test_resource_cycle_rejected(self):
        data = bytearray(self.source)
        struct.pack_into('<I', data, 1024 + 20, 0x80000000)
        with self.assertRaisesRegex(ValueError, 'Cyclic'):
            launcher.PE(data)

    def test_resource_data_bounds_rejected(self):
        data = bytearray(self.source)
        struct.pack_into('<I', data, 152 + 132, 0xfffffff0)
        with self.assertRaisesRegex(ValueError, 'range'):
            launcher.PE(data)

    def test_invalid_image_size_and_resource_permissions_rejected_on_input(self):
        for offset, value in ((152 + 56, 0), (152 + 56, 12287),
                              (152 + 56, 16384), (432 + 36, 0), (432 + 36, 0x60000040)):
            data = bytearray(self.source)
            struct.pack_into('<I', data, offset, value)
            with self.assertRaises(ValueError):
                self.prepare(bytes(data))

    def test_unknown_or_duplicate_schema_resources_rejected(self):
        for key, value in (((10, 'UNKNOWN', 0), b'x'), ((10, 'UV_TRAMPOLINE_KIND', 0), b'\x02'),
                           ((10, 'UV_PYTHON_PATH', 1033), b'x')):
            resources = dict(self.resources)
            resources[key] = value
            with self.assertRaises(ValueError):
                self.prepare(pe_fixture(resources))

    def test_wrong_interpreter_or_callable_body_rejected(self):
        for key, value in (((10, 'UV_PYTHON_PATH', 0), b'C:\\other.exe'),
                           ((10, 'UV_SCRIPT_DATA', 0), launcher.script_zip(b'#!' + OLD.encode() + b'\nprint("extra")\n'))):
            resources = dict(self.resources)
            resources[key] = value
            with self.assertRaises(ValueError):
                self.prepare(pe_fixture(resources))

    def test_zip_rejects_multiple_entries_compression_and_trailing_data(self):
        for kwargs in ({'extra': True}, {'compression': zipfile.ZIP_DEFLATED}, {'trailing': True}):
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, 'w', compression=kwargs.get('compression', zipfile.ZIP_STORED)) as archive:
                archive.writestr('__main__.py', b'body')
                if kwargs.get('extra'):
                    archive.writestr('unexpected.py', b'body')
            data = stream.getvalue() + (b'junk' if kwargs.get('trailing') else b'')
            with self.assertRaises(ValueError):
                launcher.read_script(data)

    def test_zip_fixed_metadata_and_crc_validation(self):
        data = launcher.script_zip(b'body')
        self.assertEqual(data, launcher.script_zip(b'body'))
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entry = archive.infolist()[0]
            self.assertEqual(entry.date_time, (1980, 1, 1, 0, 0, 0))
            self.assertEqual(entry.compress_type, zipfile.ZIP_STORED)
        damaged = bytearray(data)
        damaged[41] ^= 1
        with self.assertRaises(zipfile.BadZipFile):
            launcher.read_script(bytes(damaged))

    def test_documented_timestamp_normalization_preserves_code(self):
        data = pe_fixture(self.resources, timestamp=123456)
        result = launcher.normalize_pe_metadata(data)
        self.assertEqual(result, self.source)
        self.assertEqual(launcher.PE(result).code_identity(), launcher.PE(data).code_identity())

    def owned_fixture(self):
        site = self.root / 'site-packages'
        (site / 'bin').mkdir(parents=True)
        source = site / 'bin/example.exe'
        source.write_bytes(self.source)
        dist = site / 'example-1.dist-info'
        dist.mkdir()
        entry = dist / 'entry_points.txt'
        entry.write_text('[console_scripts]\nexample = ' + ENTRY + '\n')
        rows = []
        for path in (source, entry):
            data = path.read_bytes()
            checksum = base64.urlsafe_b64encode(bytes.fromhex(launcher.digest(data))).rstrip(b'=').decode()
            rows.append([path.relative_to(site).as_posix(), 'sha256=' + checksum, str(len(data))])
        rows.append(['example-1.dist-info/RECORD', '', ''])
        with (dist / 'RECORD').open('w', newline='') as stream:
            csv.writer(stream, lineterminator='\n').writerows(rows)
        return site, source, dist

    def test_exact_record_owned_declared_entrypoint(self):
        site, source, dist = self.owned_fixture()
        result = launcher.owned_entrypoint(site, 'example.exe')
        self.assertEqual(result, (source, self.source, ENTRY, dist / 'RECORD'))

    def test_ownership_duplicate_owner_or_modified_metadata_rejected(self):
        site, _, dist = self.owned_fixture()
        duplicate = site / 'other-1.dist-info'
        duplicate.mkdir()
        (duplicate / 'RECORD').write_bytes((dist / 'RECORD').read_bytes())
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            launcher.owned_entrypoint(site, 'example.exe')
        (duplicate / 'RECORD').unlink()
        (dist / 'entry_points.txt').write_text('[console_scripts]\nexample=wrong:main\n')
        with self.assertRaisesRegex(ValueError, 'entrypoints.*RECORD'):
            launcher.owned_entrypoint(site, 'example.exe')

    def test_ownership_missing_or_changed_launcher_rejected(self):
        site, source, dist = self.owned_fixture()
        source.write_bytes(self.source + b'changed')
        with self.assertRaisesRegex(ValueError, 'ownership hash'):
            launcher.owned_entrypoint(site, 'example.exe')
        (dist / 'RECORD').unlink()
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            launcher.owned_entrypoint(site, 'example.exe')

    def test_update_failure_discards_resource_handle(self):
        events = []
        class API:
            def begin(self, path):
                events.append('begin')
                return 123
            def put(self, handle, name, data):
                self_handle = handle
                events.append(('put', self_handle))
                raise OSError('update failed')
            def end(self, handle, discard):
                events.append(('end', handle, discard))
        with self.assertRaisesRegex(OSError, 'update failed'):
            launcher.write_resources(self.root / 'fixture', {'name': b'data'}, API())
        self.assertEqual(events, ['begin', ('put', 123), ('end', 123, True)])

    def test_end_failure_does_not_reuse_consumed_handle(self):
        events = []
        class API:
            def begin(self, path): return 123
            def put(self, handle, name, data): pass
            def end(self, handle, discard):
                events.append((handle, discard))
                raise OSError('end failed')
        with self.assertRaisesRegex(OSError, 'end failed'):
            launcher.write_resources(self.root / 'fixture', {'name': b'data'}, API())
        self.assertEqual(events, [(123, False)])

    def test_separate_atomic_output_and_revalidation(self):
        site, source, _ = self.owned_fixture()
        base_path = self.root / 'base.exe'
        base_path.write_bytes(self.base)
        output = self.root / 'result.exe'
        resources = self.base_resources
        class FixtureAPI:
            def begin(self, path):
                self.path, self.resources = path, dict(resources)
                return 123
            def put(self, handle, name, data): self.resources[(10, name, 0)] = data
            def end(self, handle, discard):
                if not discard:
                    self.path.write_bytes(pe_fixture(self.resources, timestamp=9999))
        with patch.object(launcher, 'WindowsResourceAPI', FixtureAPI):
            evidence = launcher.relocate_launcher(site_packages=site, name='example.exe', installing_python=OLD,
                                                 base_path=base_path, output=output)
            self.assertEqual(source.read_bytes(), self.source)
            self.assertEqual(evidence['outputSha256'], launcher.digest(output.read_bytes()))
            self.assertNotIn(OLD.encode(), output.read_bytes())
            with self.assertRaisesRegex(ValueError, 'new separate'):
                launcher.relocate_launcher(site_packages=site, name='example.exe', installing_python=OLD,
                                          base_path=base_path, output=output)
        self.assertFalse(list(self.root.glob('.uv-launcher-*')))

    def test_api_failure_leaves_no_published_output_or_temp(self):
        site, source, _ = self.owned_fixture()
        base_path = self.root / 'base.exe'
        base_path.write_bytes(self.base)
        output = self.root / 'result.exe'
        class FailureAPI:
            def begin(self, path): raise OSError('begin failed')
        with patch.object(launcher, 'WindowsResourceAPI', FailureAPI):
            with self.assertRaisesRegex(OSError, 'begin failed'):
                launcher.relocate_launcher(site_packages=site, name='example.exe', installing_python=OLD,
                                          base_path=base_path, output=output)
        self.assertFalse(output.exists())
        self.assertFalse(list(self.root.glob('.uv-launcher-*')))
        self.assertEqual(source.read_bytes(), self.source)

    def test_invalid_updater_image_size_or_resource_flags_never_publish(self):
        site, source, _ = self.owned_fixture()
        base_path = self.root / 'base.exe'
        base_path.write_bytes(self.base)
        resources = self.base_resources
        for index, (offset, value) in enumerate(((152 + 56, 0), (432 + 36, 0))):
            output = self.root / f'rejected-{index}.exe'
            class InvalidAPI:
                def begin(self, path):
                    self.path, self.resources = path, dict(resources)
                    return 123
                def put(self, handle, name, data): self.resources[(10, name, 0)] = data
                def end(self, handle, discard):
                    if not discard:
                        data = bytearray(pe_fixture(self.resources))
                        struct.pack_into('<I', data, offset, value)
                        self.path.write_bytes(data)
            with patch.object(launcher, 'WindowsResourceAPI', InvalidAPI):
                with self.assertRaises(ValueError):
                    launcher.relocate_launcher(site_packages=site, name='example.exe', installing_python=OLD,
                                              base_path=base_path, output=output)
            self.assertFalse(output.exists())
            self.assertFalse(list(self.root.glob('.uv-launcher-*')))
        self.assertEqual(source.read_bytes(), self.source)


if __name__ == '__main__':
    unittest.main()
