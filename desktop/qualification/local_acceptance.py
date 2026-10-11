# SPDX-License-Identifier: AGPL-3.0-only
"""Supervise an explicitly supplied private-test candidate; never qualify hardware."""
import argparse
import hashlib
import http.cookiejar
import http.server
import json
import os
from pathlib import Path
import queue
import re
import stat
import secrets
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser

MARKER = {'mode': 'private-test', 'qualified': False, 'recommendationsEnabled': False}


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify_native(native):
    """Verify the native content identity before executing its interpreter/code."""
    native = native.resolve(strict=True)

    def regular(path):
        relative = path.relative_to(native)
        current = native
        for part in relative.parts:
            current = current / part
            if current.is_symlink():
                raise ValueError('Native inventory path contains a link')
        if not stat.S_ISREG(path.lstat().st_mode):
            raise ValueError('Native inventory path is not a regular file')
        return path

    identity = json.loads(regular(native / 'manifest.json').read_text())
    inventory_path = regular(native / 'files.json')
    if digest(inventory_path) != identity.get('runtimeId'):
        raise ValueError('Native inventory identity mismatch')
    files = json.loads(inventory_path.read_text())
    if not isinstance(files, dict) or not files:
        raise ValueError('Invalid native inventory')
    for name, expected in files.items():
        if (not isinstance(name, str) or not name or len(name) >= 512
                or any(not re.fullmatch(r'[A-Za-z0-9._+() -]+', part)
                       or part != part.strip() or part in ('.', '..')
                       for part in name.split('/'))
                or not isinstance(expected, str) or not re.fullmatch(r'[a-f0-9]{64}', expected)):
            raise ValueError('Unsafe native inventory record')
        if digest(regular(native.joinpath(*name.split('/')))) != expected:
            raise ValueError('Native payload hash mismatch')
    for required in ('backend.py', 'provenance.json'):
        if required not in files:
            raise ValueError('Required native code or provenance is not inventoried')
    # Python distributions intentionally contain aliases excluded from files.json.
    # Accept those only when they resolve inside this exact verified tree.
    for directory, directories, names in os.walk(native, followlinks=False):
        for name in directories + names:
            path = Path(directory) / name
            relative = path.relative_to(native).as_posix()
            if path.is_symlink():
                target = path.resolve(strict=True)
                try:
                    target_name = target.relative_to(native).as_posix()
                except ValueError:
                    raise ValueError('Native alias escapes verified payload') from None
                if not target.is_dir() and target_name not in files:
                    raise ValueError('Native alias target is not inventoried')
            elif path.is_file() and relative not in files and relative not in {'manifest.json', 'files.json', 'assembly.json'}:
                raise ValueError('Uninventoried native payload file')
            elif not path.is_file() and not path.is_dir():
                raise ValueError('Unsupported native payload entry')
    interpreter = native / ('python/python.exe' if os.name == 'nt' else 'python/bin/python3')
    target = interpreter.resolve(strict=True)
    if target.relative_to(native).as_posix() not in files:
        raise ValueError('Native interpreter target is not inventoried')
    return identity


def origin_checked(value):
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or not parsed.port
            or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment):
        raise ValueError('Invalid loopback launch origin')
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError('Unexpected backend redirect')


def job_counts(value):
    jobs = value.get('jobs', {})
    result = {name: jobs.get(name) for name in ('queued', 'running', 'nonterminal')}
    if any(type(v) is not int or v < 0 for v in result.values()):
        raise ValueError('Invalid aggregate job counts')
    return result


def browser_handoff(origin, cookies):
    """One-use same-host cookie handoff; credentials never enter stdout/evidence."""
    token = '/' + secrets.token_urlsafe(32)

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            expected = f'127.0.0.1:{self.server.server_port}'
            if (self.headers.get('Host') != expected or self.headers.get('Origin') is not None
                    or not secrets.compare_digest(self.path, token) or self.server.used):
                self.send_error(404)
                return
            self.server.used = True
            self.send_response(302)
            for cookie in cookies:
                self.send_header('Set-Cookie', cookie)
            self.send_header('Location', origin)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.end_headers()

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.used = False
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f'http://127.0.0.1:{server.server_port}{token}'


def run(args):
    native = args.native.resolve(strict=True)
    probe = json.loads(args.processing_probe.read_text())
    identity = verify_native(native)
    if json.loads((native.parent / 'release.json').read_text()).get('channel') != 'private-test':
        raise ValueError('Only private-test release policy is permitted')
    args.profile.mkdir(parents=True, exist_ok=True)
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    evidence = {'schema': 1, 'qualification': 'unqualified-private-local-measurement',
                'resourceMeasurement': MARKER, 'identity': identity,
                'processingId': args.processing_id, 'modelsId': args.models_id,
                'candidateHashes': {name: digest(native / name) for name in ('manifest.json', 'files.json', 'provenance.json', 'backend.py')},
                'releasePolicySha256': digest(native.parent / 'release.json'),
                'probeSha256': digest(args.processing_probe), 'samples': [],
                'limits': 'Aggregate job counts and profile free disk only; no per-job success, process/GPU memory peak, audio quality, or hardware qualification.'}

    def save():
        temporary = args.evidence.with_suffix('.partial')
        with temporary.open('w', encoding='utf-8') as stream:
            if os.name != 'nt':
                os.chmod(temporary, 0o600)
            json.dump(evidence, stream, indent=2)
            stream.write('\n')
        temporary.replace(args.evidence)

    python = native / ('python/python.exe' if os.name == 'nt' else 'python/bin/python3')
    command = [str(python), '-I', '-B', str(native / 'backend.py'), '--native', str(native),
               '--runtime', str(args.profile.resolve()), '--processing', str(args.processing.resolve(strict=True)),
               '--processing-id', args.processing_id, '--models', str(args.models.resolve(strict=True)),
               '--models-id', args.models_id, '--processing-probe', json.dumps(probe),
               '--private-test-resource-measurement']
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, text=True, encoding='utf-8')
    messages = queue.Queue()
    threading.Thread(target=lambda: messages.put(child.stdout.readline(65537)), daemon=True).start()
    handoff = None
    try:
        line = messages.get(timeout=args.startup_timeout)
        if len(line) > 65536:
            raise ValueError('Invalid launch protocol')
        launch = json.loads(line)
        origin = origin_checked(launch['origin'])
        if launch.get('identity') != identity or launch.get('resourceMeasurement') != MARKER:
            raise ValueError('Candidate identity or measurement mode mismatch')
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(), urllib.request.HTTPCookieProcessor(jar))

        def request(path, body=None, control=False):
            headers = {'Origin': origin}
            if body is not None:
                headers['Content-Type'] = 'application/json'
            if control:
                headers['X-Singhouse-Desktop-Token'] = launch['controlToken']
            with opener.open(urllib.request.Request(origin + path, data=json.dumps(body).encode() if body is not None else None,
                                                   headers=headers), timeout=5) as response:
                return json.loads(response.read(1024 * 1024)), response.headers.get_all('Set-Cookie', [])

        deadline = time.monotonic() + args.startup_timeout
        while True:
            try:
                ready, _ = request('/desktop-ready')
                break
            except OSError:
                if child.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError('Backend did not become ready') from None
                time.sleep(.25)
        if ready.get('nonce') != launch['nonce'] or ready.get('identity') != identity or ready.get('resourceMeasurement') != MARKER:
            raise ValueError('Readiness identity mismatch')
        _, cookies = request('/api/auth/gate', {'password': launch.pop('password')})
        me, _ = request('/api/auth/me')
        if me.get('id') != 1 or me.get('gate_enabled') is not True or not cookies:
            raise ValueError('Backend gate authentication failed')
        handoff, url = browser_handoff(origin, cookies)
        if args.open_browser:
            if not webbrowser.open(url):
                raise RuntimeError('Could not open authenticated browser handoff')
        else:
            # Never emit the credential-bearing handoff URL to redirected logs.
            if not sys.stdout.isatty():
                raise RuntimeError('Use --open-browser or an interactive terminal for the private browser handoff')
            print(f'One-use private browser URL: {url}', flush=True)
        print('Private measurement running. Ctrl-C closes the backend; evidence remains unqualified.', flush=True)
        evidence['ready'] = True
        while child.poll() is None:
            state, _ = request('/desktop-update-state', control=True)
            evidence['samples'].append({'timeUnix': time.time(), 'jobs': job_counts(state),
                                        'profileFreeBytes': shutil.disk_usage(args.profile).free})
            save()
            time.sleep(args.sample_seconds)
        raise RuntimeError('Backend exited unexpectedly')
    except KeyboardInterrupt:
        evidence['stopReason'] = 'operator-interrupt'
    except Exception as error:
        # Exception messages can include HTTP URLs or content. Keep only class.
        evidence['stopReason'] = type(error).__name__
        raise RuntimeError('Private acceptance failed; inspect the sanitized evidence status') from None
    finally:
        if handoff:
            handoff.shutdown()
            handoff.server_close()
        child.stdin.close()
        try:
            child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        evidence['backendExitCode'] = child.returncode
        save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('native', 'profile', 'processing', 'models', 'processing-probe', 'evidence'):
        parser.add_argument('--' + name, type=Path, required=True)
    for name in ('processing-id', 'models-id'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--open-browser', action='store_true')
    parser.add_argument('--startup-timeout', type=float, default=120)
    parser.add_argument('--sample-seconds', type=float, default=5)
    args = parser.parse_args()
    if args.startup_timeout <= 0 or args.sample_seconds <= 0:
        parser.error('Timeout and sampling interval must be positive')
    run(args)


if __name__ == '__main__':
    main()
