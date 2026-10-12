# SPDX-License-Identifier: AGPL-3.0-only
"""Exercise acceptance-profile permissions with native Windows PowerShell 5."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

LAUNCHER = Path(__file__).resolve().parents[1] / 'acceptance' / 'start-windows.ps1'


@unittest.skipUnless(os.name == 'nt', 'Requires Windows NTFS and Windows PowerShell 5')
class WindowsAcceptanceLauncherTests(unittest.TestCase):
    def setUp(self):
        self.powershell = shutil.which('powershell.exe')
        if not self.powershell:
            self.skipTest('Windows PowerShell 5 is unavailable')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bundle = self.root / 'bundle'
        native = self.bundle / 'app' / 'resources' / 'native'
        native.mkdir(parents=True)
        (native / 'manifest.json').write_text(json.dumps({'runtimeId': 'a' * 64}))
        (native / 'models.json').write_text(json.dumps({'models': []}))
        self.script = self.bundle / 'tools' / 'acceptance' / 'windows' / 'start-windows.ps1'
        self.script.parent.mkdir(parents=True)
        self.profile = self.root / 'local' / 'sh-test' / ('cpu-' + 'a' * 12)
        self.env = dict(os.environ, LOCALAPPDATA=str(self.root / 'local'))
        # Reproduce the problematic parent-host path without importing its modules.
        self.env['PSModulePath'] = str(self.root / 'nonexistent-pwsh7-modules')

    def run_script(self, source, stdin='', expect=0):
        self.script.write_text(source, encoding='utf-8')
        result = subprocess.run(
            [self.powershell, '-NoProfile', '-ExecutionPolicy', 'Bypass',
             '-File', str(self.script), '-Accelerator', 'cpu'],
            env=self.env, input=stdin, text=True, capture_output=True, timeout=30,
        )
        self.assertEqual(result.returncode, expect, result.stdout + result.stderr)
        return result.stdout

    def setup_profile(self, expect=0):
        # Execute the launcher's actual preflight, ending before logging/setup.
        source = LAUNCHER.read_text().split("    $Log = Join-Path $Profile 'setup.log'", 1)[0]
        source += "\n    Write-Host 'PROFILE_PREFLIGHT_OK'\n} catch { Write-Host $_; exit 1 } finally { $env:PSModulePath = $PreviousModulePath }\n"
        return self.run_script(source, expect=expect)

    def acl(self):
        command = "$a = Get-Acl -LiteralPath $env:PROFILE_TEST_PATH; $a.Sddl"
        return subprocess.check_output(
            [self.powershell, '-NoProfile', '-Command', command],
            env=dict(os.environ, PROFILE_TEST_PATH=str(self.profile)), text=True,
        ).strip()

    def icacls(self, *args):
        subprocess.run(['icacls.exe', str(self.profile), *args], check=True,
                       capture_output=True, text=True)

    def current_sid(self):
        return subprocess.check_output(
            [self.powershell, '-NoProfile', '-Command',
             '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],
            text=True,
        ).strip()

    def test_fresh_profile_and_existing_private_profile(self):
        self.assertIn('PROFILE_PREFLIGHT_OK', self.setup_profile())
        before = self.acl()
        self.assertIn('PROFILE_PREFLIGHT_OK', self.setup_profile())
        self.assertEqual(self.acl(), before)

    def test_existing_unsafe_acl_is_rejected_without_mutation(self):
        for change in ['extra-reader', 'missing-inheritance', 'limited-system', 'deny', 'inherited', 'wrong-owner']:
            with self.subTest(change=change):
                if self.profile.exists():
                    shutil.rmtree(self.profile)
                self.setup_profile()
                sid = '*' + self.current_sid()
                if change == 'extra-reader':
                    self.icacls('/grant', '*S-1-1-0:(OI)(CI)R')
                elif change == 'missing-inheritance':
                    self.icacls('/grant:r', sid + ':F')
                elif change == 'limited-system':
                    self.icacls('/grant:r', '*S-1-5-18:(OI)(CI)R')
                elif change == 'deny':
                    self.icacls('/deny', '*S-1-1-0:(D)')
                elif change == 'wrong-owner':
                    # The runner needs elevation to set a different owner; native
                    # unelevated runs still cover all other permission failures.
                    result = subprocess.run(['icacls.exe', str(self.profile), '/setowner',
                                             '*S-1-5-32-544'], capture_output=True)
                    if result.returncode:
                        continue
                else:
                    self.icacls('/inheritance:e')
                before = self.acl()
                output = self.setup_profile(expect=1)
                self.assertIn('Unsafe test profile permissions', output)
                self.assertEqual(self.acl(), before)
                # Remove a denial before fixture cleanup (including child access).
                if change == 'deny':
                    self.icacls('/remove:d', '*S-1-1-0')

    def test_declining_consent_explains_cancellation(self):
        output = self.run_script(LAUNCHER.read_text(), stdin='NO\n\n')
        self.assertIn('Cancelled. Nothing was installed or downloaded.', output)
        self.assertIn('Press Enter to close', output)
        self.assertFalse((self.profile / 'windows-acceptance.json').exists())
        self.assertEqual(sorted(p.name for p in self.profile.iterdir()), ['setup.log'])


if __name__ == '__main__':
    unittest.main()
