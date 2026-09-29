# SPDX-License-Identifier: AGPL-3.0-only
"""Bounded control-plane inspection; never invokes or qualifies processing."""
import argparse
import asyncio
import contextlib
import importlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path

_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
_FUNCTION = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,127}\Z")
_REFERENCE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
_TOKEN = re.compile(r"[A-Za-z0-9_-]{1,512}\Z")


def result():
    return {"schema": 1, "accessChecked": False, "compatible": False,
            "qualified": False, "ready": False,
            "stages": {"access": "unchecked", "tags": "unchecked", "functions": "unchecked"}}


def valid_config(config):
    return (isinstance(config, dict)
            and set(config) == {"app", "environment", "version", "tokenId", "tokenSecret"}
            and all(isinstance(config[k], str) and _NAME.fullmatch(config[k]) for k in ("app", "environment"))
            and type(config["version"]) is int and 0 < config["version"] <= 2147483647
            and all(isinstance(config[k], str) and _TOKEN.fullmatch(config[k]) for k in ("tokenId", "tokenSecret")))


def valid_contract(contract):
    if not isinstance(contract, dict) or type(contract.get("schema")) is not int or contract.get("schema") != 1:
        return False
    reference, digest = contract.get("protocolReference"), contract.get("protocolSha256")
    tags, functions = contract.get("requiredTags"), contract.get("functions")
    return (isinstance(reference, str) and bool(_REFERENCE.fullmatch(reference))
            and isinstance(digest, str) and bool(re.fullmatch(r"[a-f0-9]{64}", digest))
            and isinstance(tags, dict) and 0 < len(tags) <= 32
            and all(isinstance(k, str) and _REFERENCE.fullmatch(k) and isinstance(v, str)
                    and 0 < len(v) <= 256 and not any(ord(c) < 32 for c in v) for k, v in tags.items())
            and reference in tags.values() and digest in tags.values()
            and isinstance(functions, dict) and set(functions) == {"separation", "transcription"}
            and all(isinstance(v, str) and _FUNCTION.fullmatch(v) for v in functions.values())
            # App tags describe the current deployment, while a function lookup
            # may target an older version. Bind those exact versioned function
            # names to the declared protocol, not merely the current tags.
            and functions == {"separation": f"separate_{digest}",
                              "transcription": f"transcribe_{digest}"})


async def check_metadata(config, contract, sdk, timeout=25):
    """The caller supplies a release-owned contract, never one from renderer input."""
    output = result()
    if not valid_config(config):
        output["errorCode"] = "invalid-config"
        return output
    stage = "access"

    async def inspect():
        nonlocal stage
        client = await sdk.Client.from_credentials.aio(config["tokenId"], config["tokenSecret"])
        app = await sdk.App.lookup.aio(config["app"], client=client,
                                       environment_name=config["environment"], create_if_missing=False)
        tags = await app.get_tags.aio(client=client)
        output["accessChecked"] = True
        output["stages"]["access"] = "passed"
        stage = "tags"
        if not valid_contract(contract):
            output["errorCode"] = "release-contract-unavailable"
            return
        if not isinstance(tags, dict) or any(tags.get(k) != v for k, v in contract["requiredTags"].items()):
            output["stages"]["tags"] = "failed"
            output["errorCode"] = "protocol-tags-mismatch"
            return
        output["stages"]["tags"] = "passed"
        stage = "functions"
        for name in contract["functions"].values():
            handle = sdk.Function.from_name(config["app"], name, version=config["version"],
                                            environment_name=config["environment"], client=client)
            await handle.hydrate.aio(client=client)
        output["stages"]["functions"] = "passed"
        output["compatible"] = True

    try:
        await asyncio.wait_for(inspect(), timeout=timeout)
    except TimeoutError:
        output["stages"][stage] = "failed"
        output["errorCode"] = "metadata-check-timeout"
    except Exception:
        output["stages"][stage] = "failed"
        output["errorCode"] = "metadata-check-failed"
    return output


def run(raw, contract=None, sdk=None):
    try:
        if len(raw) > 16384:
            raise ValueError()
        config = json.loads(raw)
        if not valid_config(config):
            raise ValueError()
    except (ValueError, TypeError):
        return {**result(), "errorCode": "invalid-config"}
    try:
        if sdk is None:
            sdk = importlib.import_module("modal")
            if sdk.__version__ != "1.5.5":
                return {**result(), "errorCode": "sdk-unavailable"}
        return asyncio.run(check_metadata(config, contract, sdk))
    except Exception:
        return {**result(), "errorCode": "sdk-unavailable"}


def main():
    # Redirect at descriptor level as well as Python level: SDK imports, logs,
    # native libraries and background cleanup cannot contaminate the protocol.
    protocol_fd = os.dup(sys.stdout.fileno())
    with open(os.devnull, "w") as sink:
        os.dup2(sink.fileno(), 1)
        os.dup2(sink.fileno(), 2)
        with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            output = {**result(), "errorCode": "invalid-config"}
            try:
                parser = argparse.ArgumentParser(add_help=False, exit_on_error=False)
                parser.add_argument("--contract")
                args, unknown = parser.parse_known_args()
                if unknown:
                    raise ValueError()
                contract = None
                if args.contract:
                    try:
                        with open(args.contract, encoding="utf8") as stream:
                            contract = json.loads(stream.read(65537))
                    except Exception:
                        pass  # Missing/malformed trusted input cannot grant compatibility.
                raw = sys.stdin.read(16385)
                # A dedicated subprocess owns this environment. Neither local
                # profiles nor inherited Modal settings may redirect credentials.
                for key in list(os.environ):
                    if key.startswith("MODAL_"):
                        del os.environ[key]
                with tempfile.TemporaryDirectory(prefix="singhouse-modal-check-") as directory:
                    config_path = Path(directory) / "empty.toml"
                    config_path.write_text("", encoding="utf8")
                    os.environ["MODAL_CONFIG_PATH"] = str(config_path)
                    output = run(raw, contract)
            except Exception:
                pass
    with os.fdopen(protocol_fd, "w", encoding="utf8") as protocol:
        protocol.write(json.dumps(output, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
