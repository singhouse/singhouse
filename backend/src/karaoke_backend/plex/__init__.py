# SPDX-License-Identifier: AGPL-3.0-only
"""Plex media-server library source — read-only import from the operator's own server.

Core, not a catalog provider: nothing here searches a catalog, and nothing here
acquires anything. It reads a music library the operator already runs on their
own network and copies a file they already own into this install so it can be
separated like any other upload.
"""
