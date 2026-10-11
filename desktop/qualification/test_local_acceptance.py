# SPDX-License-Identifier: AGPL-3.0-only
import unittest
import hashlib
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
import urllib.error
import urllib.request
from local_acceptance import NoRedirect, browser_handoff, job_counts, origin_checked, verify_native, run, processing_readiness


class LocalAcceptanceTests(unittest.TestCase):
    def test_processing_readiness_requires_exact_ready_selection(self):
        value = {name: {'ready': True} for name in ('playback', 'transcription', 'separation')}
        value.update(runtime={'id': 'a' * 64, 'accelerator': 'cpu',
                              'capabilities': ['separation', 'transcription'], 'privatePath': 'excluded'},
                     heart_model={'privatePath': 'excluded'})
        result = processing_readiness(value, 'a' * 64, 'cpu')
        self.assertNotIn('privatePath', json.dumps(result))
        self.assertNotIn('heart_model', result)
        for identifier, accelerator in [('b' * 64, 'cpu'), ('a' * 64, 'cuda')]:
            with self.assertRaises(ValueError):
                processing_readiness(value, identifier, accelerator)
        for name in ('playback', 'transcription', 'separation'):
            value[name]['ready'] = False
            with self.assertRaises(ValueError):
                processing_readiness(value, 'a' * 64, 'cpu')
            value[name]['ready'] = True
        value['runtime']['capabilities'] = ['separation']
        with self.assertRaises(ValueError):
            processing_readiness(value, 'a' * 64, 'cpu')

    def test_native_inventory_blocks_tampering_before_launch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            interpreter = root / ('python/python.exe' if os.name == 'nt' else 'python/bin/python3.12')
            interpreter.parent.mkdir(parents=True)
            interpreter.write_bytes(b'fixture interpreter')
            if os.name != 'nt':
                (interpreter.parent / 'python3').symlink_to('python3.12')
            (root / 'backend.py').write_text('fixture backend')
            (root / 'provenance.json').write_text('{}')
            scoped_notice = root / 'notices/frontend/@babel_helper-string-parser/LICENSE'
            scoped_notice.parent.mkdir(parents=True)
            scoped_notice.write_text('fixture notice')
            files = {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                     for p in (interpreter, root / 'backend.py', root / 'provenance.json', scoped_notice)}
            inventory = json.dumps(files).encode()
            (root / 'files.json').write_bytes(inventory)
            (root / 'manifest.json').write_text(json.dumps({'runtimeId': hashlib.sha256(inventory).hexdigest()}))
            verify_native(root)
            (root / 'backend.py').write_text('tampered')
            probe = root / 'probe.json'
            probe.write_text('{}')
            with patch('local_acceptance.subprocess.Popen') as launch:
                with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                    run(SimpleNamespace(native=root, processing_probe=probe))
                launch.assert_not_called()
            (root / 'files.json').write_text('{}')
            with self.assertRaisesRegex(ValueError, 'identity mismatch'):
                verify_native(root)

    def test_rejects_nonlocal_or_credential_origins(self):
        self.assertEqual(origin_checked('http://127.0.0.1:1234'), 'http://127.0.0.1:1234')
        for value in ('https://127.0.0.1:1234', 'http://localhost:1234',
                      'http://127.0.0.1:1234/path', 'http://user@127.0.0.1:1234',
                      'http://127.0.0.1:1234?token=secret'):
            with self.assertRaises(ValueError):
                origin_checked(value)

    def test_only_aggregate_counts_survive(self):
        self.assertEqual(job_counts({'jobs': {'queued': 1, 'running': 0, 'nonterminal': 1,
                                             'privateFilename': 'never-export'}}),
                         {'queued': 1, 'running': 0, 'nonterminal': 1})
        for value in (-1, True, '1', None):
            with self.assertRaises(ValueError):
                job_counts({'jobs': {'queued': value, 'running': 0, 'nonterminal': 0}})

    def test_handoff_is_once_only_and_rejects_foreign_origin(self):
        server, url = browser_handoff('http://127.0.0.1:1234', ['test_cookie=value; HttpOnly; Path=/; SameSite=lax'])
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        try:
            with self.assertRaises(urllib.error.HTTPError) as denied:
                opener.open(urllib.request.Request(url, headers={'Origin': 'https://elsewhere.invalid'}))
            self.assertEqual(denied.exception.code, 404)
            denied.exception.close()
            # NoRedirect prevents transmitting the cookie to the target test port.
            with self.assertRaisesRegex(RuntimeError, 'Unexpected backend redirect'):
                opener.open(url)
            self.assertTrue(server.used)
            with self.assertRaises(urllib.error.HTTPError) as replay:
                opener.open(url)
            self.assertEqual(replay.exception.code, 404)
            replay.exception.close()
        finally:
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    unittest.main()
