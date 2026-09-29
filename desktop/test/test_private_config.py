# SPDX-License-Identifier: AGPL-3.0-only
"""Private bootstrap transport contracts without cloud or credential access."""
import importlib.util
import json
import os
from pathlib import Path
import threading
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("private_config", Path(__file__).resolve().parents[1] / "private_config.py")
private_config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(private_config)


class PrivateConfigTests(unittest.TestCase):
    def read_bytes(self, data, **kwargs):
        read_fd, write_fd = os.pipe()
        try:
            os.write(write_fd, data)
            os.close(write_fd)
            write_fd = None
            return private_config.read_private_config(read_fd, **kwargs)
        finally:
            os.close(read_fd)
            if write_fd is not None:
                os.close(write_fd)

    def assert_private_error(self, callback):
        with self.assertRaises(RuntimeError) as caught:
            callback()
        self.assertEqual(str(caught.exception), "Private bootstrap configuration could not be read.")
        self.assertTrue(caught.exception.__suppress_context__ or caught.exception.__context__ is None)

    def test_valid_object_and_null(self):
        config = {"tokenId": "test-only-id", "tokenSecret": "test-only-secret", "consent": True}
        self.assertEqual(self.read_bytes(json.dumps({"schema": 1, "modal": config}).encode() + b"\n"), config)
        self.assertIsNone(self.read_bytes(b'{"schema":1,"modal":null}\n'))

    def test_read_consumes_only_the_configuration_line(self):
        read_fd, write_fd = os.pipe()
        try:
            os.write(write_fd, b'{"schema":1,"modal":{}}\nNEXT-LIFELINE-BYTES')
            self.assertEqual(private_config.read_private_config(read_fd), {})
            self.assertEqual(os.read(read_fd, 19), b'NEXT-LIFELINE-BYTES')
        finally:
            os.close(write_fd)
            os.close(read_fd)

    def test_eof_incomplete_oversize_and_boundary(self):
        valid = b'{"schema":1,"modal":null}\n'
        self.assertIsNone(self.read_bytes(valid, max_bytes=len(valid)))
        for data, limit in [(b'', 100), (valid[:-1], 100), (valid, len(valid) - 1), (b'x' * 100, 50)]:
            with self.subTest(data=data, limit=limit):
                self.assert_private_error(lambda: self.read_bytes(data, max_bytes=limit))

    def test_malformed_and_non_strict_envelopes_have_only_generic_errors(self):
        cases = [b'test-only-secret\n', b'\xff\n', b'[]\n', b'null\n', b'{}\n',
                 b'{"schema":true,"modal":null}\n', b'{"schema":1.0,"modal":null}\n',
                 b'{"schema":2,"modal":null}\n', b'{"schema":1,"modal":[]}\n',
                 b'{"schema":1,"modal":"test-only-secret"}\n',
                 b'{"schema":1,"modal":null,"extra":true}\n',
                 b'{"schema":1,"schema":1,"modal":null}\n',
                 b'{"schema":1,"modal":{"tokenId":NaN}}\n',
                 b'{"schema":1,"modal":{"tokenId":"a","tokenId":"b"}}\n']
        for data in cases:
            with self.subTest(data=data):
                self.assert_private_error(lambda: self.read_bytes(data))

    def test_timeout_is_bounded_without_waiting_for_pipe_eof(self):
        read_fd, write_fd = os.pipe()
        reader_finished = threading.Event()
        real_read = os.read
        def tracked_read(fd, size):
            try:
                return real_read(fd, size)
            finally:
                reader_finished.set()
        try:
            with patch.object(private_config.os, 'read', tracked_read):
                start = time.monotonic()
                self.assert_private_error(lambda: private_config.read_private_config(read_fd, timeout=0.03))
                self.assertLess(time.monotonic() - start, 1)
                # Production exits on timeout. Test unblocks the daemon before
                # closing/reusing the read fd, avoiding a descriptor reuse race.
                os.close(write_fd)
                write_fd = None
                self.assertTrue(reader_finished.wait(1))
        finally:
            if write_fd is not None:
                os.close(write_fd)
            os.close(read_fd)

    def test_invalid_arguments_and_descriptor_are_generic(self):
        for kwargs in [{"fd": -1}, {"fd": True}, {"fd": 0, "timeout": 0},
                       {"fd": 0, "timeout": float('inf')}, {"fd": 0, "max_bytes": 0}]:
            self.assert_private_error(lambda: private_config.read_private_config(**kwargs))
        read_fd, write_fd = os.pipe()
        os.close(read_fd)
        os.close(write_fd)
        self.assert_private_error(lambda: private_config.read_private_config(read_fd))


if __name__ == '__main__':
    unittest.main()
