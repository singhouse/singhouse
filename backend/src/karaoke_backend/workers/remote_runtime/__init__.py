# SPDX-License-Identifier: AGPL-3.0-only
# Marks remote_runtime as a regular subpackage so setuptools' packages.find
# ships it in the wheel. The mac_* modules inside are standalone scripts run
# on the remote worker host — nothing here is imported by the backend itself.
