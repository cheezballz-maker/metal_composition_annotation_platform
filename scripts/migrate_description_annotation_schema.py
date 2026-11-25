"""Migrate a description review workspace to the aligned patent schema.

Only current annotation metadata and composition payloads are normalized.
Review decisions, statuses, revisions, assignments, and audit events are kept.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
from copy import deepcopy
from pathlib import Path

for candidate in (Path.cwd(), Path(__file__).resolve().parents[1]):
    if (candidate / "backend").is_dir():
        sys.path.insert(0, str(candidate))
        break

from backend.composition_schema import validate_record
from backend.review_store import ReviewStore


def atomic_json(path: Path, value: dict) -> None:
    descriptor, temp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    temp = Path(temp_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def normalize_meta(meta: dict) -> dict:
    result = deepcopy(meta)
    result["source_type"] = "patent"
    result["section"] = "description"
    result.pop("source_sha256", None)
    return result


def normalize_composition(composition: dict) -> dict:
    result = deepcopy(composition)
    result.pop("claim_no", None)
    return result


def normalize_document(document: dict) -> dict:
    result = deepcopy(document)
    result["meta"] = normalize_meta(result["meta"])
    result["baseline"]["meta"] = normalize_meta(result["baseline"]["meta"])
    result["baseline"]["compositions"] = [
        normalize_composition(item) for item in result["baseline"]["compositions"]
    ]
    for entry in result["compositions"]:
        entry["data"] = normalize_composition(entry["data"])
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--expected-count", type=int, required=True)
    parser.add_argument("--seed", type=Path, help="Revised combined seed used to refresh manifest provenance")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    workspace = args.workspace.resolve()
    manifest_path = workspace / "manifest.json"
    manifest_raw = manifest_path.read_bytes()
    store = ReviewStore(workspace)
    source_ids = store.source_ids
    if len(source_ids) != args.expected_count:
        raise ValueError(f"Expected {args.expected_count} records; found {len(source_ids)}")

    originals: dict[Path, bytes] = {}
    normalized: dict[str, dict] = {}
    try:
        for source_id in source_ids:
            path = workspace / "documents" / f"{source_id}.json"
            raw = path.read_bytes()
            document = json.loads(raw)
            migrated = normalize_document(document)
            content, _ = store.load_source(source_id)
            validate_record({
                "meta": migrated["meta"],
                "source_quality": migrated["source_quality"],
                "compositions": [entry["data"] for entry in migrated["compositions"]],
            }, content)
            validate_record(migrated["baseline"], content)
            originals[path] = raw
            normalized[source_id] = migrated

        for source_id, document in normalized.items():
            atomic_json(workspace / "documents" / f"{source_id}.json", document)
        if args.seed:
            manifest = json.loads(manifest_raw)
            manifest["seed_sha256"] = hashlib.sha256(args.seed.resolve().read_bytes()).hexdigest()
            atomic_json(manifest_path, manifest)

        verified = ReviewStore(workspace)
        for source_id in source_ids:
            actual = verified.load_document(source_id)
            if actual != normalized[source_id]:
                raise ValueError(f"Migrated document mismatch for {source_id}")
    except BaseException:
        manifest_path.write_bytes(manifest_raw)
        for path, raw in originals.items():
            path.write_bytes(raw)
        raise

    print(json.dumps({
        "records": len(source_ids),
        "meta_source_type": "patent",
        "source_sha256_removed": True,
        "claim_no_removed": True,
        "review_state_preserved": True,
        "seed_sha256_refreshed": bool(args.seed),
    }, sort_keys=True))


if __name__ == "__main__":
    main()
