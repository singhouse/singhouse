# SPDX-License-Identifier: AGPL-3.0-only
"""Relocate known uv 0.12.8 x64 console launchers before inventory/signing.

Project-authored adapter, not a replacement trampoline implementation. Machine
code is retained from the caller-supplied, SHA-pinned upstream binary. Format:
https://github.com/astral-sh/uv/tree/68209e5c61ce4b76c2e685bea7913876bc929dc9/crates/uv-trampoline-builder
PE structures: https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
Resource writes use documented Begin/Update/EndUpdateResourceW, never execution.
Only unsigned Windows x64 console scripts are supported; other formats fail.
"""
from __future__ import annotations

import base64
import configparser
import csv
import ctypes
import hashlib
import io
import os
from pathlib import Path
import re
import struct
import tempfile
import zipfile

UV_COMMIT = '68209e5c61ce4b76c2e685bea7913876bc929dc9'
BASE_SHA256 = '0447a4febf43fdd958e4236129d6050b1dad64c124c43355d557542b3229cae8'
RELATIVE_PYTHON = r'..\..\..\python.exe'
RESOURCE_NAMES = ('UV_PYTHON_PATH', 'UV_SCRIPT_DATA', 'UV_TRAMPOLINE_KIND')
MAX_IMAGE = 2 * 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


class PE:
    """Bounded PE32+ resource reader; intentionally narrower than general PE."""
    def __init__(self, data):
        self.data = data
        if not 64 <= len(data) <= MAX_IMAGE or data[:2] != b'MZ':
            raise ValueError('Invalid or oversized PE image')
        self.pe = self.unpack('<I', 0x3c)[0]
        if self.pe < 64 or self.take(self.pe, 4) != b'PE\0\0':
            raise ValueError('Invalid PE signature')
        machine, count, _, symbols, symbol_count, size, flags = self.unpack('<HHIIIHH', self.pe + 4)
        self.optional = self.pe + 24
        if machine != 0x8664 or not 1 <= count <= 96 or size != 240 or symbols or symbol_count or flags != 0x22:
            raise ValueError('Unsupported x64 console PE header')
        self.take(self.optional, size)
        if self.unpack('<H', self.optional)[0] != 0x20b or self.unpack('<H', self.optional + 68)[0] != 3:
            raise ValueError('Expected PE32+ console subsystem')
        if self.unpack('<I', self.optional + 108)[0] != 16:
            raise ValueError('Unsupported PE data directory count')
        self.directories = [self.unpack('<II', self.optional + 112 + 8 * i) for i in range(16)]
        if self.directories[4] != (0, 0):
            raise ValueError('Signed launchers must not be rewritten')
        self.sections = {}
        header_size = self.unpack('<I', self.optional + 60)[0]
        section_alignment, file_alignment = self.unpack('<II', self.optional + 32)
        if (section_alignment, file_alignment) != (4096, 512):
            raise ValueError('Unsupported PE image alignment')
        table = self.optional + size
        self.take(table, count * 40)
        if header_size < table + count * 40 or header_size > len(data):
            raise ValueError('Invalid PE header size')
        raw_ranges, virtual_ranges = [], []
        for index in range(count):
            offset = table + index * 40
            name, vs, va, raw_size, raw, reloc, lines, reloc_count, line_count, characteristics = self.unpack('<8sIIIIIIHHI', offset)
            name = name.rstrip(b'\0')
            if not name or name in self.sections or reloc or lines or reloc_count or line_count:
                raise ValueError('Invalid or duplicate PE section')
            if raw < header_size or not raw_size or not vs or raw % 512 or raw_size % 512 or va % 4096:
                raise ValueError('Invalid PE section alignment or size')
            self.take(raw, raw_size)
            raw_ranges.append((raw, raw + raw_size))
            virtual_ranges.append((va, va + max(vs, raw_size)))
            self.sections[name] = (vs, va, raw_size, raw, characteristics, offset)
        for ranges in (raw_ranges, virtual_ranges):
            ordered = sorted(ranges)
            if any(a[1] > b[0] for a, b in zip(ordered, ordered[1:])):
                raise ValueError('Overlapping PE sections')
        image_size = self.unpack('<I', self.optional + 56)[0]
        required_size = (max(header_size, *(end for _, end in virtual_ranges)) + section_alignment - 1) // section_alignment * section_alignment
        if image_size != required_size or image_size >= 1 << 32:
            raise ValueError('PE SizeOfImage does not match aligned section extents')
        if max(end for _, end in raw_ranges) != len(data):
            raise ValueError('Unexpected PE overlay or truncated section')
        if b'.rsrc' not in self.sections:
            raise ValueError('Missing PE resource section')
        self.resources, self.resource_timestamps = self.read_resources()

    def take(self, offset, size):
        if offset < 0 or size < 0 or offset > len(self.data) - size:
            raise ValueError('PE structure outside file bounds')
        return self.data[offset:offset + size]

    def unpack(self, fmt, offset):
        return struct.unpack(fmt, self.take(offset, struct.calcsize(fmt)))

    def rva(self, value, size):
        matches = [raw + value - va for _, va, raw_size, raw, _, _ in self.sections.values()
                   if va <= value and value + size <= va + raw_size]
        if len(matches) != 1:
            raise ValueError('PE RVA is not uniquely backed by section bytes')
        self.take(matches[0], size)
        return matches[0]

    def read_resources(self):
        resource_rva, length = self.directories[2]
        vs, va, raw_size, raw, _, _ = self.sections[b'.rsrc']
        if resource_rva != va or not 16 <= length <= min(vs, raw_size):
            raise ValueError('Invalid resource directory range')
        result, timestamps, visited = {}, [], set()

        def at(offset, size):
            if offset < 0 or size < 0 or offset > length - size:
                raise ValueError('Resource structure outside directory bounds')
            return self.take(raw + offset, size)

        def walk(offset, keys):
            if len(keys) > 2 or offset in visited:
                raise ValueError('Cyclic or overdeep PE resources')
            visited.add(offset)
            characteristics, _, major, minor, named, ids = struct.unpack('<IIHHHH', at(offset, 16))
            # Upstream base uses version 0; native UpdateResource produces 4.
            if characteristics or major not in (0, 4) or minor or named + ids > 64:
                raise ValueError('Unexpected resource directory schema')
            timestamps.append(raw + offset + 4)
            entries = at(offset + 16, 8 * (named + ids))
            names = set()
            for index in range(named + ids):
                name, child = struct.unpack_from('<II', entries, index * 8)
                if bool(name & 0x80000000) != (index < named):
                    raise ValueError('Resource name/ID ordering mismatch')
                if name & 0x80000000:
                    pointer = name & 0x7fffffff
                    chars = struct.unpack('<H', at(pointer, 2))[0]
                    name = at(pointer + 2, chars * 2).decode('utf-16le')
                    if not name or '\0' in name:
                        raise ValueError('Invalid resource name')
                if name in names:
                    raise ValueError('Duplicate resource name')
                names.add(name)
                chain = (*keys, name)
                if len(chain) < 3:
                    if not child & 0x80000000:
                        raise ValueError('Premature resource leaf')
                    walk(child & 0x7fffffff, chain)
                else:
                    if child & 0x80000000 or not isinstance(name, int):
                        raise ValueError('Invalid resource language leaf')
                    address, size, codepage, reserved = struct.unpack('<IIII', at(child, 16))
                    if reserved or not size or codepage not in (0, 1252):
                        raise ValueError('Unexpected resource data schema')
                    payload_offset = address - va
                    result[chain] = at(payload_offset, size)
        walk(0, ())
        return result, timestamps

    def immutable_header(self):
        """Ignore only documented resource-update layout fields and timestamps."""
        end = self.optional + 240
        data = bytearray(self.data[:end])
        for offset in (self.pe + 8, self.optional + 8, self.optional + 56, self.optional + 64):
            data[offset:offset + 4] = b'\0' * 4
        data[self.optional + 128:self.optional + 136] = b'\0' * 8  # resource directory
        return bytes(data)

    def code_identity(self):
        return {name: (vs, va, raw_size, flags, self.take(raw, raw_size))
                for name, (vs, va, raw_size, raw, flags, _) in self.sections.items() if name != b'.rsrc'}

    def matches_base(self, pinned):
        return (self.immutable_header() == pinned.immutable_header() and
                self.code_identity() == pinned.code_identity() and
                self.sections[b'.rsrc'][4] == pinned.sections[b'.rsrc'][4])


def validate_base(base):
    if digest(base) != BASE_SHA256:
        raise ValueError('Pinned uv x64 console base checksum mismatch')
    return PE(base)


def expected_body(entrypoint):
    if not re.fullmatch(r'[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*', entrypoint, flags=re.ASCII):
        raise ValueError('Unsupported declared console entrypoint')
    module, function = entrypoint.split(':')
    return ('# -*- coding: utf-8 -*-\nimport sys\nfrom ' + module + ' import ' + function.split('.')[0] + '\n'
            'if __name__ == "__main__":\n'
            '    if sys.argv[0].endswith("-script.pyw"):\n'
            '        sys.argv[0] = sys.argv[0][:-11]\n'
            '    elif sys.argv[0].endswith(".exe"):\n'
            '        sys.argv[0] = sys.argv[0][:-4]\n'
            '    sys.exit(' + function + '())\n').encode()


def read_script(payload):
    if len(payload) > 128 * 1024 or not payload.startswith(b'PK\x03\x04'):
        raise ValueError('Invalid launcher ZIP size/header')
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        entries = archive.infolist()
        if len(entries) != 1 or archive.comment:
            raise ValueError('Expected one uncommented launcher ZIP entry')
        entry = entries[0]
        if (entry.filename != '__main__.py' or entry.header_offset != 0 or
                entry.compress_type != zipfile.ZIP_STORED or entry.file_size > 65536 or
                entry.compress_size != entry.file_size or entry.extra or entry.comment or entry.flag_bits & ~0x800):
            raise ValueError('Unexpected launcher ZIP entry metadata')
        if len(payload) < 30:
            raise ValueError('Truncated launcher ZIP local header')
        _, local_flags, compression, _, _, crc, compressed, size_local, name_size, extra_size = struct.unpack_from('<HHHHHIIIHH', payload, 4)
        if (local_flags != entry.flag_bits or compression != zipfile.ZIP_STORED or
                crc != entry.CRC or compressed != entry.file_size or size_local != entry.file_size or
                name_size != 11 or extra_size or payload[30:41] != b'__main__.py'):
            raise ValueError('Unexpected launcher ZIP local header')
        # No trailing junk, multivolume or ZIP64 fields: exact EOCD + one entry.
        if len(payload) < 22 or payload[-22:-18] != b'PK\x05\x06':
            raise ValueError('Unexpected ZIP trailer')
        disk, directory_disk, count_disk, count, size, offset, comment = struct.unpack('<HHHHIIH', payload[-18:])
        if ((disk, directory_disk, count_disk, count, comment) != (0, 0, 1, 1, 0) or
                offset != 41 + entry.file_size or size != 57 or offset + size != len(payload) - 22):
            raise ValueError('Invalid launcher ZIP directory')
        return archive.read(entry)


def script_zip(script):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_STORED) as archive:
        info = zipfile.ZipInfo('__main__.py', (1980, 1, 1, 0, 0, 0))
        info.create_system = 0
        info.external_attr = 0o644 << 16
        archive.writestr(info, script)
    return stream.getvalue()


def prepare_resources(source, base, installing_python, entrypoint):
    pinned = validate_base(base)
    parsed = PE(source)
    if not parsed.matches_base(pinned):
        raise ValueError('Launcher code/header differs from pinned uv base')
    expected = set(pinned.resources) | {(10, name, 0) for name in RESOURCE_NAMES}
    if set(parsed.resources) != expected or any(parsed.resources[key] != value for key, value in pinned.resources.items()):
        raise ValueError('Unexpected launcher resource ownership/schema')
    resources = parsed.resources
    if resources[(10, 'UV_TRAMPOLINE_KIND', 0)] != b'\x01':
        raise ValueError('Expected uv script trampoline')
    if not installing_python or any(char in installing_python for char in '\0\r\n'):
        raise ValueError('Invalid installing interpreter path')
    interpreter = resources[(10, 'UV_PYTHON_PATH', 0)]
    if interpreter not in (installing_python.encode(), RELATIVE_PYTHON.encode()):
        raise ValueError('Launcher does not belong to the installing interpreter')
    script = read_script(resources[(10, 'UV_SCRIPT_DATA', 0)])
    first, separator, body = script.partition(b'\n')
    if not separator or first != b'#!' + interpreter or body != expected_body(entrypoint):
        raise ValueError('Unexpected launcher shebang/callable body')
    return {'UV_TRAMPOLINE_KIND': b'\x01', 'UV_PYTHON_PATH': RELATIVE_PYTHON.encode(),
            'UV_SCRIPT_DATA': script_zip(b'#!' + RELATIVE_PYTHON.encode() + b'\n' + body)}


def regular(path):
    path = Path(path)
    if path.is_symlink() or Path(os.path.abspath(path)) != path.resolve() or not path.is_file():
        raise ValueError('Launcher metadata/input must be an unlinked regular file')
    return path


def owned_entrypoint(site_packages, name):
    """Require one RECORD owner and its exact declared console callable."""
    if not re.fullmatch(r'[A-Za-z0-9_-]+\.exe', name):
        raise ValueError('Unsupported generated launcher name')
    root = Path(site_packages)
    source = regular(root / 'bin' / name)
    data = source.read_bytes()
    owned = []
    for record in sorted(root.glob('*.dist-info/RECORD')):
        rows = list(csv.reader(io.StringIO(regular(record).read_text())))
        if any(len(row) != 3 for row in rows) or len({row[0].casefold() for row in rows}) != len(rows):
            raise ValueError('Malformed/duplicate ownership RECORD')
        for path, checksum, size in rows:
            if path.casefold() == ('bin/' + name).casefold():
                expected = 'sha256=' + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode()
                if path != 'bin/' + name or checksum != expected or size != str(len(data)):
                    raise ValueError('Launcher ownership hash/size/path mismatch')
                owned.append((record, rows))
    if len(owned) != 1:
        raise ValueError('Launcher must have exactly one RECORD owner')
    record, rows = owned[0]
    entry_file = regular(record.parent / 'entry_points.txt')
    entry_bytes = entry_file.read_bytes()
    entry_name = entry_file.relative_to(root).as_posix()
    entry_hash = 'sha256=' + base64.urlsafe_b64encode(hashlib.sha256(entry_bytes).digest()).rstrip(b'=').decode()
    if [entry_name, entry_hash, str(len(entry_bytes))] not in rows:
        raise ValueError('Declared entrypoints do not match their RECORD')
    config = configparser.ConfigParser(interpolation=None, strict=True)
    config.optionxform = str
    config.read_string(entry_bytes.decode())
    entry = name[:-4]
    if not config.has_option('console_scripts', entry) or config.has_option('gui_scripts', entry):
        raise ValueError('Expected an unambiguous declared console entrypoint')
    value = config.get('console_scripts', entry).strip()
    expected_body(value)
    return source, data, value, record


class WindowsResourceAPI:
    def __init__(self):
        if os.name != 'nt':
            raise RuntimeError('Windows resource transformation requires native Windows')
        from ctypes import wintypes
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.kernel.BeginUpdateResourceW.argtypes = (wintypes.LPCWSTR, wintypes.BOOL)
        self.kernel.BeginUpdateResourceW.restype = wintypes.HANDLE
        self.kernel.UpdateResourceW.argtypes = (wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p,
                                               wintypes.WORD, ctypes.c_void_p, wintypes.DWORD)
        self.kernel.UpdateResourceW.restype = wintypes.BOOL
        self.kernel.EndUpdateResourceW.argtypes = (wintypes.HANDLE, wintypes.BOOL)
        self.kernel.EndUpdateResourceW.restype = wintypes.BOOL

    def begin(self, path):
        handle = self.kernel.BeginUpdateResourceW(str(path), False)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        return handle

    def put(self, handle, name, data):
        buffer = ctypes.create_string_buffer(data)
        key = ctypes.c_wchar_p(name)
        if not self.kernel.UpdateResourceW(handle, ctypes.c_void_p(10), ctypes.cast(key, ctypes.c_void_p),
                                           0, ctypes.cast(buffer, ctypes.c_void_p), len(data)):
            raise ctypes.WinError(ctypes.get_last_error())

    def end(self, handle, discard):
        if not self.kernel.EndUpdateResourceW(handle, discard):
            raise ctypes.WinError(ctypes.get_last_error())


def write_resources(path, resources, api):
    handle = api.begin(path)
    try:
        for name in sorted(resources):
            api.put(handle, name, resources[name])
    except BaseException:
        api.end(handle, True)
        raise
    # EndUpdateResource consumes the handle; never try to reuse it on failure.
    api.end(handle, False)


def normalize_pe_metadata(data):
    parsed = PE(data)
    result = bytearray(data)
    # Documented IMAGE_FILE_HEADER.TimeDateStamp, OptionalHeader.CheckSum and
    # IMAGE_RESOURCE_DIRECTORY.TimeDateStamp. Debug/code sections stay pinned.
    for offset in (parsed.pe + 8, parsed.optional + 64, *parsed.resource_timestamps):
        result[offset:offset + 4] = b'\0' * 4
    return bytes(result)


def relocate_launcher(*, site_packages, name, installing_python, base_path, output):
    """Create a separate unsigned result atomically; caller later updates RECORD.

    No input mutation and no network. Call before signing. The caller owns
    all-entrypoint coverage, RECORD replacement and final native inventory.
    """
    source, original, entrypoint, record = owned_entrypoint(site_packages, name)
    base = regular(base_path).read_bytes()
    replacements = prepare_resources(original, base, installing_python, entrypoint)
    output = Path(os.path.abspath(output))
    if output == source.resolve() or output.exists() or output.is_symlink():
        raise ValueError('Launcher output must be a new separate path')
    if output.parent != output.parent.resolve() or not output.parent.is_dir():
        raise ValueError('Launcher output parent must be an unlinked directory')
    api = WindowsResourceAPI()
    descriptor, temporary = tempfile.mkstemp(prefix='.uv-launcher-', suffix='.exe', dir=output.parent)
    temporary = Path(temporary)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(base)
        write_resources(temporary, replacements, api)
        result = normalize_pe_metadata(temporary.read_bytes())
        actual = PE(result)
        pinned = validate_base(base)
        expected = dict(pinned.resources)
        expected.update({(10, key, 0): value for key, value in replacements.items()})
        if actual.resources != expected or not actual.matches_base(pinned):
            raise ValueError('Updated launcher changed pinned code or resource contract')
        if prepare_resources(result, base, installing_python, entrypoint) != replacements:
            raise ValueError('Updated launcher is not semantically idempotent')
        if installing_python != RELATIVE_PYTHON and installing_python.encode() in result:
            raise ValueError('Updated launcher retains its temporary interpreter path')
        with temporary.open('wb') as stream:
            stream.write(result)
            stream.flush()
            os.fsync(stream.fileno())
        # Same-directory hard-link publication refuses replacement atomically.
        os.link(temporary, output)
        return {'schema': 1, 'normalizer': 'uv-0.12.8-win64-console-v1', 'uvCommit': UV_COMMIT,
                'baseSha256': BASE_SHA256, 'inputSha256': digest(original), 'outputSha256': digest(result),
                'entrypoint': entrypoint, 'record': record.relative_to(site_packages).as_posix(),
                'python': RELATIVE_PYTHON}
    finally:
        temporary.unlink(missing_ok=True)
