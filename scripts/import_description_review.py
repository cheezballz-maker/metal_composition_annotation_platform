"""Create a review workspace from description extraction JSONL.

The importer is content agnostic within the composition schema: it preserves the
source text and annotations, converts occurrence_no to the platform's stable
node_no, validates every raw evidence span, and writes one record per source ID.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tempfile
from copy import deepcopy
from pathlib import Path
from typing import Any

from backend.composition_schema import validate_record


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=Path, required=True, help="Extraction JSONL")
    parser.add_argument("--documents", type=Path, required=True, help="Prepared patent document JSON")
    parser.add_argument("--output", type=Path, required=True, help="New workspace directory")
    parser.add_argument("--dataset-id", required=True)
    parser.add_argument("--reviewer", required=True)
    parser.add_argument("--checker", action="append", default=[])
    return parser.parse_args()


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def write_json(path: Path, value: Any) -> bytes:
    raw = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    path.write_bytes(raw)
    return raw


def load_seed(path: Path) -> tuple[list[dict[str, Any]], str]:
    raw = path.read_bytes()
    records = [json.loads(line) for line in raw.decode("utf-8-sig").splitlines() if line.strip()]
    ids = [record.get("meta", {}).get("source_id") for record in records]
    if not records or any(not isinstance(source_id, str) or not source_id for source_id in ids):
        raise ValueError("Seed records require meta.source_id")
    if len(ids) != len(set(ids)):
        raise ValueError("Seed contains duplicate source IDs")
    return records, sha256(raw)


def load_documents(path: Path) -> tuple[dict[str, dict[str, Any]], str]:
    raw = path.read_bytes()
    payload = json.loads(raw.decode("utf-8-sig"))
    rows = payload.get("documents") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise ValueError("Prepared documents must be an array or contain a documents array")
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("patent_id"), str) or not isinstance(row.get("description"), str):
            raise ValueError("Each prepared document requires patent_id and description")
        if row["patent_id"] in result:
            raise ValueError(f"Prepared documents contain duplicate patent ID {row['patent_id']}")
        result[row["patent_id"]] = row
    return result, sha256(raw)


def main() -> None:
    args = parse_args()
    output = args.output.resolve()
    if output.exists():
        raise FileExistsError(f"review workspace already exists: {output}")
    records, seed_hash = load_seed(args.seed.resolve())
    documents, documents_hash = load_documents(args.documents.resolve())
    source_ids = [record["meta"]["source_id"] for record in records]
    missing = [source_id for source_id in source_ids if source_id not in documents]
    if missing:
        raise ValueError(f"Prepared documents are missing {len(missing)} seed source IDs")

    staging = Path(tempfile.mkdtemp(dir=output.parent, prefix=f".{output.name}."))
    (staging / "sources").mkdir()
    (staging / "documents").mkdir()
    manifest_sources: dict[str, dict[str, Any]] = {}
    assignments: dict[str, str] = {}
    composition_count = 0
    try:
        for line_number, seed_record in enumerate(records, start=1):
            source_id = seed_record["meta"]["source_id"]
            prepared = documents[source_id]
            content = prepared["description"]
            expected_hash = seed_record["meta"].get("source_sha256")
            actual_hash = sha256(content.encode("utf-8"))
            if expected_hash and expected_hash != actual_hash:
                raise ValueError(f"Description hash mismatch for {source_id}")

            record = deepcopy(seed_record)
            record["meta"]["source_type"] = "patent"
            record["meta"]["section"] = "description"
            record["meta"].pop("source_sha256", None)
            converted = []
            for index, composition in enumerate(record.get("compositions", []), start=1):
                item = deepcopy(composition)
                occurrence_no = item.pop("occurrence_no", index)
                item.pop("claim_no", None)
                if isinstance(occurrence_no, bool) or not isinstance(occurrence_no, int) or occurrence_no <= 0:
                    raise ValueError(f"Invalid occurrence_no for {source_id}")
                item["node_no"] = occurrence_no
                converted.append(item)
            record["compositions"] = converted
            validate_record(record, content)
            composition_count += len(converted)

            snapshot = [{
                "patent_id": source_id,
                "title": prepared.get("title"),
                "alternative_titles": prepared.get("alternative_titles", []),
                "source_type": "patent_description",
                "section": "description",
                "content": content,
            }]
            snapshot_raw = write_json(staging / "sources" / f"{source_id}.json", snapshot)
            manifest_sources[source_id] = {
                "file": f"sources/{source_id}.json",
                "array_item": 0,
                "content_field": "content",
                "content_sha256": actual_hash,
                "snapshot_sha256": sha256(snapshot_raw),
            }
            assignments[source_id] = args.reviewer
            review_document = {
                "dataset_id": args.dataset_id,
                "source_id": source_id,
                "seed_line_number": line_number,
                "revision": 0,
                "status": "not_started",
                "reviewer": args.reviewer,
                "meta": deepcopy(record["meta"]),
                "source_quality": deepcopy(record["source_quality"]),
                "baseline": deepcopy(record),
                "compositions": [{
                    "id": f"seed:{composition['node_no']}",
                    "seed_node_no": composition["node_no"],
                    "origin": "seed",
                    "decision": "pending",
                    "deleted": False,
                    "data": deepcopy(composition),
                } for composition in converted],
                "events": [],
                "source_checked": False,
                "review_outcome": None,
                "review_reason": None,
                "finalized_revision": None,
            }
            write_json(staging / "documents" / f"{source_id}.json", review_document)

        manifest = {
            "schema_version": "composition-review-v1",
            "dataset_id": args.dataset_id,
            "workspace_key": "patent-descriptions",
            "workspace_label": "Patent Descriptions",
            "source_kind": "patent_description",
            "assignments": assignments,
            "checkers": list(dict.fromkeys(args.checker)),
            "sources": manifest_sources,
            "seed_sha256": seed_hash,
            "prepared_documents_sha256": documents_hash,
            "offset_basis": "raw_content",
            "offset_unit": "unicode_code_point",
            "interval_convention": "half-open",
            "import_validation": {
                "record_count": len(records),
                "source_count": len(manifest_sources),
                "seed_composition_count": composition_count,
                "all_raw_slices_exact": True,
                "negative_review_blockers": {},
            },
        }
        write_json(staging / "manifest.json", manifest)
        output.parent.mkdir(parents=True, exist_ok=True)
        staging.replace(output)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    print(json.dumps({"workspace": str(output), "records": len(records), "compositions": composition_count}, sort_keys=True))


if __name__ == "__main__":
    main()
