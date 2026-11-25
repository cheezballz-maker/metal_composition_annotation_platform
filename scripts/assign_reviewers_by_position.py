"""Assign contiguous review-workspace positions while preserving review state."""
from __future__ import annotations

import argparse
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--expected-count", type=int, required=True)
    parser.add_argument("--split-after", type=int, required=True)
    parser.add_argument("--first-reviewer", required=True)
    parser.add_argument("--remaining-reviewer", required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    workspace = args.workspace.resolve()
    manifest_path = workspace / "manifest.json"
    manifest_raw = manifest_path.read_bytes()
    manifest = json.loads(manifest_raw)
    source_ids = list(manifest["sources"])
    if len(source_ids) != args.expected_count or not 0 < args.split_after < len(source_ids):
        raise ValueError("Workspace count or split position is incorrect")
    desired = {
        source_id: args.first_reviewer if index < args.split_after else args.remaining_reviewer
        for index, source_id in enumerate(source_ids)
    }

    originals: dict[Path, bytes] = {}
    expected_documents: dict[str, dict] = {}
    try:
        for source_id in source_ids:
            path = workspace / "documents" / f"{source_id}.json"
            raw = path.read_bytes()
            document = json.loads(raw)
            if document.get("source_id") != source_id:
                raise ValueError(f"Document identity mismatch for {source_id}")
            expected = deepcopy(document)
            expected["reviewer"] = desired[source_id]
            expected_documents[source_id] = expected
            if document.get("reviewer") != desired[source_id]:
                originals[path] = raw
                atomic_json(path, expected)

        updated_manifest = deepcopy(manifest)
        updated_manifest["assignments"] = desired
        atomic_json(manifest_path, updated_manifest)

        store = ReviewStore(workspace)
        if store.manifest["assignments"] != desired:
            raise ValueError("Manifest assignments were not applied")
        for source_id in source_ids:
            if store.load_document(source_id) != expected_documents[source_id]:
                raise ValueError(f"Review state changed unexpectedly for {source_id}")
    except BaseException:
        manifest_path.write_bytes(manifest_raw)
        for path, raw in originals.items():
            path.write_bytes(raw)
        raise

    print(json.dumps({
        "records": len(source_ids),
        "first_reviewer": args.first_reviewer,
        "first_reviewer_count": args.split_after,
        "remaining_reviewer": args.remaining_reviewer,
        "remaining_reviewer_count": len(source_ids) - args.split_after,
        "documents_rewritten": len(originals),
        "review_state_preserved": True,
    }, sort_keys=True))


if __name__ == "__main__":
    main()
