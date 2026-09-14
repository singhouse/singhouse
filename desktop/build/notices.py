# SPDX-License-Identifier: AGPL-3.0-only
"""Collect the exact frontend dependency license texts into native artifacts."""
import json
from pathlib import Path
import shutil

# These build dependencies contribute code to the shipped frontend. Tailwind's
# generated stylesheet includes its Preflight reset and utility declarations.
SHIPPED_BUILD_PACKAGES = {"node_modules/tailwindcss"}


def collect(frontend: Path, output: Path):
    lock = json.loads((frontend / "package-lock.json").read_text())
    destination = output / "notices/frontend"
    destination.mkdir(parents=True, exist_ok=True)
    inventory = []
    for relative, package in lock["packages"].items():
        if not relative or (package.get("dev") and relative not in SHIPPED_BUILD_PACKAGES):
            continue
        root = frontend / relative
        metadata = json.loads((root / "package.json").read_text())
        name = metadata["name"]
        target = destination / name.replace("/", "_")
        texts = [p for p in root.iterdir() if p.is_file()
                 and p.name.lower().startswith(("license", "licence", "copying", "notice"))]
        if name == "@vue/devtools-api" and metadata["version"] == "6.6.4" and not texts:
            texts = [Path(__file__).resolve().parents[1] / "licenses/vue-devtools-api-LICENSE"]
        if not texts:
            raise RuntimeError(f"No license text found for bundled frontend package {name}")
        target.mkdir(exist_ok=True)
        for text in texts:
            shutil.copyfile(text, target / text.name)
        inventory.append({"name": name, "version": metadata["version"],
                          "license": metadata.get("license"),
                          "texts": [p.name for p in texts]})
    (destination / "inventory.json").write_text(json.dumps(inventory, indent=2) + "\n")
    shutil.copyfile(frontend / "node_modules/@fontsource-variable/space-grotesk/LICENSE",
                    output / "static/assets/SpaceGrotesk-LICENSE.txt")
