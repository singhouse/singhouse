# SPDX-License-Identifier: AGPL-3.0-only
"""Print the pinned Heart policy entry; fetch metadata/configs, never weights."""
import hashlib
import json
from urllib.request import urlopen


REPOSITORY = "HeartMuLa/HeartTranscriptor-oss"
REVISION = "918f88917c17489c1f8dbae0165cd1019c4d5cd3"
DIRECTORY = f"huggingface/heart/{REVISION}"
FILES = (
    "added_tokens.json", "config.json", "generation_config.json", "merges.txt",
    "model.safetensors", "normalizer.json", "preprocessor_config.json",
    "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json", "vocab.json",
)
MAX_METADATA_BYTES = 4 * 1024 * 1024


def fetch_small(url):
    with urlopen(url, timeout=60) as response:
        data = response.read(MAX_METADATA_BYTES + 1)
    if len(data) > MAX_METADATA_BYTES:
        raise ValueError("Metadata/config response exceeds size limit")
    return data


def inventory(fetch=fetch_small):
    metadata = json.loads(fetch(
        f"https://huggingface.co/api/models/{REPOSITORY}/revision/{REVISION}?blobs=true"))
    if metadata.get("sha") != REVISION:
        raise ValueError("Upstream revision differs from the pin")
    siblings = {record["rfilename"]: record for record in metadata["siblings"]}
    records = []
    for name in FILES:
        source = siblings[name]
        size = source["size"]
        url = f"https://huggingface.co/{REPOSITORY}/resolve/{REVISION}/{name}"
        if name.endswith(".safetensors"):
            # LFS's content SHA-256 is the digest of the weight bytes, not
            # the Git pointer or an HTTP ETag. Do not download these bytes.
            lfs = source["lfs"]
            sha256 = lfs["sha256"]
            if lfs["size"] != size or len(sha256) != 64 or any(c not in "0123456789abcdef" for c in sha256):
                raise ValueError("Invalid weight metadata")
        else:
            if not isinstance(size, int) or not 0 < size <= MAX_METADATA_BYTES:
                raise ValueError("Config size exceeds limit")
            data = fetch(url)
            if len(data) != size:
                raise ValueError("Config size differs from metadata")
            blob = hashlib.sha1(f"blob {size}\0".encode() + data).hexdigest()
            if blob != source["blobId"]:
                raise ValueError("Config Git blob differs from metadata")
            sha256 = hashlib.sha256(data).hexdigest()
        records.append({"path": f"{DIRECTORY}/{name}", "revision": REVISION,
                        "sha256": sha256, "size": size, "url": url, "executable": False})
    return {"id": "heart-transcriptor", "directory": DIRECTORY, "files": records}


if __name__ == "__main__":
    print(json.dumps(inventory(), indent=2))
