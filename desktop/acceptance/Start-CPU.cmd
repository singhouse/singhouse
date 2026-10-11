@echo off
rem SPDX-License-Identifier: AGPL-3.0-only
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\desktop\acceptance\start-windows.ps1" -Accelerator cpu %*
