from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dataset-id", required=True)
    args = parser.parse_args()

    package = args.package.resolve()
    output = args.output.resolve()
    if output.exists():
        raise SystemExit(f"output exists: {output}")

    records = {}
    seed_lines = {}
    with (package / "gold.jsonl").open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            record = json.loads(line)
            source_id = record["meta"]["source_id"]
            if source_id in records:
                raise SystemExit(f"duplicate source id: {source_id}")
            records[source_id] = record
            seed_lines[source_id] = line_number

    source_dir = package / "sources"
    source_files = {path.stem: path for path in source_dir.glob("*.json")}
    if set(source_files) != set(records):
        raise SystemExit("source files and seed records do not match")

    staging = output.parent / f".{output.name}.staging"
    if staging.exists():
        raise SystemExit(f"staging exists: {staging}")
    (staging / "sources").mkdir(parents=True)
    (staging / "documents").mkdir()

    manifest_sources = {}
    assignments = {}
    try:
        for source_id in sorted(records):
            source_path = source_files[source_id]
            raw = source_path.read_bytes()
            source_obj = json.loads(raw)
            if isinstance(source_obj, list) and len(source_obj) == 1:
                source_item = source_obj[0]
                array_item = 0
            elif isinstance(source_obj, dict):
                source_item = source_obj
                array_item = None
            else:
                raise SystemExit(f"unsupported source snapshot shape: {source_id}")
            content = source_item.get("content")
            if not isinstance(content, str):
                raise SystemExit(f"source has no content: {source_id}")
            destination = staging / "sources" / source_path.name
            shutil.copyfile(source_path, destination)
            manifest_sources[source_id] = {
                "file": f"sources/{source_id}.json",
                "array_item": array_item,
                "content_field": "content",
                "content_sha256": sha256(content.encode("utf-8")),
                "snapshot_sha256": sha256(raw),
            }
            assignments[source_id] = "admin"

            record = records[source_id]
            compositions = []
            for composition in record.get("compositions", []):
                compositions.append({
                    "id": f"seed:{composition['node_no']}",
                    "seed_node_no": composition["node_no"],
                    "origin": "seed",
                    "decision": "pending",
                    "deleted": False,
                    "data": composition,
                })
            document = {
                "dataset_id": args.dataset_id,
                "source_id": source_id,
                "seed_line_number": seed_lines[source_id],
                "revision": 0,
                "status": "not_started",
                "reviewer": "admin",
                "meta": record["meta"],
                "source_quality": record["source_quality"],
                "baseline": record,
                "compositions": compositions,
                "events": [],
                "source_checked": False,
                "review_outcome": None,
                "finalized_revision": None,
            }
            (staging / "documents" / f"{source_id}.json").write_text(
                json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )

        seed_bytes = (package / "gold.jsonl").read_bytes()
        manifest = {
            "schema_version": "composition-review-v1",
            "dataset_id": args.dataset_id,
            "assignments": assignments,
            "seed_line_numbers": seed_lines,
            "checkers": ["admin", "leongzhiyi"],
            "sources": manifest_sources,
            "seed_sha256": sha256(seed_bytes),
            "projection_sha256": None,
            "offset_basis": "raw_content",
            "offset_unit": "unicode_code_point",
            "interval_convention": "half-open",
            "import_validation": {
                "record_count": len(records),
                "source_count": len(records),
                "seed_composition_count": sum(len(r.get("compositions", [])) for r in records.values()),
                "constituent_count": sum(len(c.get("constituents", [])) for r in records.values() for c in r.get("compositions", [])),
                "constraint_count": sum(len(c.get("constraints", [])) for r in records.values() for c in r.get("compositions", [])),
                "raw_span_reference_count": sum(len(c.get("evidence_spans", [])) for r in records.values() for c in r.get("compositions", [])),
                "all_raw_slices_exact": False,
                "source_snapshot_bytes_preserved": True,
                "negative_review_blockers": {},
            },
        }
        (staging / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        staging.replace(output)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


if __name__ == "__main__":
    main()
