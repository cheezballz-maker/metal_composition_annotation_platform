"""Append a prepared description-review batch without rewriting existing reviews.

The batch workspace must have been created by ``import_description_review``.
Only previously unseen source/document files are added. Existing files are
hash-checked before and after the manifest is replaced atomically.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import tempfile
import sys
from datetime import datetime, timezone
from pathlib import Path

for candidate in (Path.cwd(), Path(__file__).resolve().parents[1]):
    if (candidate / "backend").is_dir():
        sys.path.insert(0, str(candidate))
        break

from backend.composition_schema import validate_record
from backend.review_store import ReviewStore


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--batch-workspace", type=Path, required=True)
    parser.add_argument("--start-line", type=int, required=True)
    parser.add_argument("--batch-name", required=True)
    parser.add_argument("--combined-seed", type=Path)
    parser.add_argument("--expected-existing", type=int, required=True)
    return parser.parse_args()


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def hashes(root: Path, relative_paths: list[str]) -> dict[str, str]:
    return {name: digest(root / name) for name in relative_paths}


def write_json_atomic(path: Path, value: dict) -> None:
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


def main() -> None:
    args = parse_args()
    workspace = args.workspace.resolve()
    batch = args.batch_workspace.resolve()
    manifest_path = workspace / "manifest.json"
    old_manifest_raw = manifest_path.read_bytes()
    current = json.loads(old_manifest_raw)
    incoming = json.loads((batch / "manifest.json").read_text(encoding="utf-8"))

    existing_ids = list(current["sources"])
    new_ids = list(incoming["sources"])
    if len(existing_ids) != args.expected_existing:
        raise ValueError(f"Expected {args.expected_existing} existing records; found {len(existing_ids)}")
    if len(new_ids) != len(set(new_ids)) or set(existing_ids) & set(new_ids):
        raise ValueError("Batch IDs are duplicated or overlap existing records")
    for key in ("schema_version", "dataset_id", "workspace_key", "source_kind"):
        if current.get(key) != incoming.get(key):
            raise ValueError(f"Workspace mismatch for {key}")
    if set(incoming.get("assignments", {})) != set(new_ids):
        raise ValueError("Batch assignments do not cover exactly the batch records")

    protected = [f"sources/{source_id}.json" for source_id in existing_ids]
    protected += [f"documents/{source_id}.json" for source_id in existing_ids]
    old_hashes = hashes(workspace, protected)
    created: list[Path] = []
    composition_count = 0
    try:
        for offset, source_id in enumerate(new_ids):
            source_src = batch / incoming["sources"][source_id]["file"]
            document_src = batch / "documents" / f"{source_id}.json"
            source_raw = source_src.read_bytes()
            document = json.loads(document_src.read_text(encoding="utf-8"))
            source_payload = json.loads(source_raw.decode("utf-8"))
            source_item = source_payload[incoming["sources"][source_id].get("array_item", 0)]
            content = source_item[incoming["sources"][source_id].get("content_field", "content")]
            validate_record(document["baseline"], content)
            document["seed_line_number"] = args.start_line + offset
            composition_count += len(document["compositions"])

            source_dst = workspace / "sources" / f"{source_id}.json"
            document_dst = workspace / "documents" / f"{source_id}.json"
            with source_dst.open("xb") as handle:
                handle.write(source_raw)
            created.append(source_dst)
            with document_dst.open("x", encoding="utf-8") as handle:
                json.dump(document, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
            created.append(document_dst)

        merged = dict(current)
        merged["assignments"] = {**current["assignments"], **incoming["assignments"]}
        merged["sources"] = {**current["sources"], **incoming["sources"]}
        if args.combined_seed:
            merged["seed_sha256"] = digest(args.combined_seed.resolve())
        validation = dict(current.get("import_validation", {}))
        validation.update({
            "record_count": len(merged["sources"]),
            "source_count": len(merged["sources"]),
            "seed_composition_count": validation.get("seed_composition_count", 0) + composition_count,
            "all_raw_slices_exact": True,
        })
        merged["import_validation"] = validation
        merged.setdefault("append_batches", []).append({
            "batch": args.batch_name,
            "source_ids": new_ids,
            "record_count": len(new_ids),
            "seed_composition_count": composition_count,
            "seed_sha256": incoming.get("seed_sha256"),
            "appended_at": datetime.now(timezone.utc).isoformat(),
        })
        write_json_atomic(manifest_path, merged)

        store = ReviewStore(workspace)
        if len(store.source_ids) != len(existing_ids) + len(new_ids):
            raise ValueError("Merged workspace record count is incorrect")
        for source_id in store.source_ids:
            store.load_source(source_id)
            store.load_document(source_id)
        if hashes(workspace, protected) != old_hashes:
            raise ValueError("An existing review file changed during append")
    except BaseException:
        manifest_path.write_bytes(old_manifest_raw)
        for path in reversed(created):
            path.unlink(missing_ok=True)
        raise

    print(json.dumps({
        "existing_records_preserved": len(existing_ids),
        "records_added": len(new_ids),
        "total_records": len(existing_ids) + len(new_ids),
        "compositions_added": composition_count,
        "existing_file_hashes_preserved": True,
    }, sort_keys=True))


if __name__ == "__main__":
    main()
