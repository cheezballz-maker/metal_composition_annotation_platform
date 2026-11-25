from __future__ import annotations

import argparse
import csv
import json
import shutil
import sys
import tempfile
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.claim_source import ClaimSource, load_claim_source, sha256_bytes
from backend.composition_schema import SPAN_FIELDS, validate_record


EXTRACTION_ROOT = ROOT.parent / "extraction_evaluator"
DEFAULT_SEED = EXTRACTION_ROOT / "mace_gold_v7_20260915" / "gold.jsonl"
DEFAULT_PROJECTION = (
    EXTRACTION_ROOT
    / "mace_gold_v7_20260915"
    / "offset_audit"
    / "reprojection"
    / "unique_raw_projections.csv"
)
DEFAULT_SOURCES = EXTRACTION_ROOT / "claim_v2_raw"
DEFAULT_DATASET_ID = "mace-gold-v7-20260915"
DEFAULT_OUTPUT = ROOT / "review-workspaces" / DEFAULT_DATASET_ID
DEFAULT_REPORT = ROOT / "REVIEW_IMPORT_REPORT.json"
REVIEWERS = ("guoyuxin", "khushisharma")
SECOND_CHECKER = "leongzhiyi"


@dataclass(frozen=True)
class Projection:
    source_id: str
    rendered_start: int
    rendered_end: int
    raw_start: int
    raw_end: int
    plain_evidence_text: str
    raw_evidence_text: str

    @property
    def key(self) -> tuple[str, int, int, str]:
        return (
            self.source_id,
            self.rendered_start,
            self.rendered_end,
            self.plain_evidence_text,
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate and import the raw-coordinate composition review workspace."
    )
    parser.add_argument("--seed", type=Path, default=DEFAULT_SEED)
    parser.add_argument("--projection", type=Path, default=DEFAULT_PROJECTION)
    parser.add_argument("--sources", type=Path, default=DEFAULT_SOURCES)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--dataset-id", default=DEFAULT_DATASET_ID)
    parser.add_argument("--owner", help="Authenticated owner account; required for import.")
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def load_seed_records(path: Path) -> tuple[list[dict[str, Any]], str]:
    raw_bytes = Path(path).read_bytes()
    records: list[dict[str, Any]] = []
    for line_number, raw_line in enumerate(raw_bytes.splitlines(), start=1):
        if not raw_line.strip():
            continue
        try:
            record = json.loads(raw_line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid seed JSON on line {line_number}") from exc
        if not isinstance(record, dict):
            raise ValueError(f"seed line {line_number} must be an object")
        records.append(record)
    source_ids = [record.get("meta", {}).get("source_id") for record in records]
    if any(not isinstance(source_id, str) or not source_id for source_id in source_ids):
        raise ValueError("every seed record must have a non-empty meta.source_id")
    if len(set(source_ids)) != len(source_ids):
        raise ValueError("seed source IDs must be unique")
    if any(Path(source_id).name != source_id for source_id in source_ids):
        raise ValueError("seed source IDs must be safe file names")
    return records, sha256_bytes(raw_bytes)


def _csv_integer(row: dict[str, str], key: str, row_number: int) -> int:
    try:
        return int(row[key])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"projection row {row_number} has invalid {key}") from exc


def load_projections(path: Path) -> tuple[dict[tuple[str, int, int, str], Projection], str]:
    projection_path = Path(path)
    raw_bytes = projection_path.read_bytes()
    try:
        decoded = raw_bytes.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError("projection CSV is not UTF-8") from exc
    rows = csv.DictReader(decoded.splitlines(keepends=True))
    required = {
        "patent_id",
        "rendered_start",
        "rendered_end",
        "raw_start",
        "raw_end",
        "plain_evidence_text",
        "raw_evidence_text",
        "exact_render_roundtrip",
    }
    if rows.fieldnames is None or required.difference(rows.fieldnames):
        raise ValueError(f"projection CSV is missing columns: {sorted(required.difference(rows.fieldnames or []))}")
    projections: dict[tuple[str, int, int, str], Projection] = {}
    for row_number, row in enumerate(rows, start=2):
        if str(row.get("exact_render_roundtrip", "")).strip().lower() != "true":
            raise ValueError(f"projection row {row_number} did not pass rendered round-trip validation")
        projection = Projection(
            source_id=str(row["patent_id"]),
            rendered_start=_csv_integer(row, "rendered_start", row_number),
            rendered_end=_csv_integer(row, "rendered_end", row_number),
            raw_start=_csv_integer(row, "raw_start", row_number),
            raw_end=_csv_integer(row, "raw_end", row_number),
            plain_evidence_text=str(row["plain_evidence_text"]),
            raw_evidence_text=str(row["raw_evidence_text"]),
        )
        if projection.key in projections:
            raise ValueError(f"projection row {row_number} duplicates an import join key")
        projections[projection.key] = projection
    return projections, sha256_bytes(raw_bytes)


def load_sources(directory: Path, source_ids: set[str]) -> dict[str, ClaimSource]:
    source_directory = Path(directory)
    paths = {path.stem: path for path in source_directory.glob("*.json")}
    missing = sorted(source_ids.difference(paths))
    extra = sorted(set(paths).difference(source_ids))
    if missing or extra:
        raise ValueError(f"source set mismatch; missing={missing}, extra={extra}")
    return {
        source_id: load_claim_source(paths[source_id], expected_source_id=source_id)
        for source_id in sorted(source_ids)
    }


def validate_projection_sources(
    projections: dict[tuple[str, int, int, str], Projection],
    sources: dict[str, ClaimSource],
) -> None:
    for projection in projections.values():
        source = sources.get(projection.source_id)
        if source is None:
            raise ValueError(f"projection references unknown source {projection.source_id}")
        if not (0 <= projection.raw_start < projection.raw_end <= len(source.content)):
            raise ValueError(f"raw projection range is invalid for {projection.source_id}")
        raw_slice = source.content[projection.raw_start : projection.raw_end]
        if raw_slice != projection.raw_evidence_text:
            raise ValueError(f"raw projection text mismatch for {projection.source_id}")


def reproject_record(
    record: dict[str, Any],
    content: str,
    projections: dict[tuple[str, int, int, str], Projection],
) -> tuple[dict[str, Any], list[tuple[str, int, int, str]]]:
    projected = deepcopy(record)
    source_id = record["meta"]["source_id"]
    used: list[tuple[str, int, int, str]] = []

    def visit(value: Any, path: str) -> None:
        if isinstance(value, dict):
            present = SPAN_FIELDS.intersection(value)
            if present:
                missing = SPAN_FIELDS.difference(value)
                if missing:
                    raise ValueError(f"{source_id} {path} has incomplete evidence: {sorted(missing)}")
                start = value["start"]
                end = value["end"]
                text = value["evidence_text"]
                if isinstance(start, bool) or not isinstance(start, int):
                    raise ValueError(f"{source_id} {path}.start must be an integer")
                if isinstance(end, bool) or not isinstance(end, int):
                    raise ValueError(f"{source_id} {path}.end must be an integer")
                if not isinstance(text, str):
                    raise ValueError(f"{source_id} {path}.evidence_text must be a string")
                key = (source_id, start, end, text)
                projection = projections.get(key)
                if projection is None:
                    raise ValueError(f"{source_id} {path} has no unambiguous raw projection")
                value["start"] = projection.raw_start
                value["end"] = projection.raw_end
                value["evidence_text"] = content[projection.raw_start : projection.raw_end]
                used.append(key)
                return
            for key, item in value.items():
                visit(item, f"{path}.{key}")
        elif isinstance(value, list):
            for index, item in enumerate(value):
                visit(item, f"{path}[{index}]")

    visit(projected, "record")
    return validate_record(projected, content), used


def estimated_work(record: dict[str, Any], source_length: int) -> int:
    compositions = record["compositions"]
    constituent_count = sum(len(comp["constituents"]) for comp in compositions)
    constraint_count = sum(len(comp["constraints"]) for comp in compositions)
    return len(compositions) * 10_000 + constituent_count * 100 + constraint_count * 500 + source_length


def balanced_assignments(
    records: list[dict[str, Any]], sources: dict[str, ClaimSource]
) -> tuple[dict[str, str], dict[str, Any]]:
    if len(records) != 100:
        raise ValueError(f"approved assignment expects 100 records, got {len(records)}")
    populated = [record for record in records if record["compositions"]]
    empty = [record for record in records if not record["compositions"]]
    if len(populated) != 20 or len(empty) != 80:
        raise ValueError(
            f"approved assignment expects 20 populated and 80 empty records, got {len(populated)} and {len(empty)}"
        )
    assignments: dict[str, str] = {}
    totals = {reviewer: 0 for reviewer in REVIEWERS}
    counts = {reviewer: {"records": 0, "populated": 0, "empty": 0} for reviewer in REVIEWERS}

    def distribute(group: list[dict[str, Any]], kind: str, quota: int) -> None:
        weighted = []
        for record in group:
            source_id = record["meta"]["source_id"]
            weighted.append((estimated_work(record, len(sources[source_id].content)), source_id))
        for weight, source_id in sorted(weighted, key=lambda item: (-item[0], item[1])):
            eligible = [reviewer for reviewer in REVIEWERS if counts[reviewer][kind] < quota]
            reviewer = min(eligible, key=lambda name: (totals[name], name))
            assignments[source_id] = reviewer
            totals[reviewer] += weight
            counts[reviewer]["records"] += 1
            counts[reviewer][kind] += 1

    distribute(populated, "populated", 10)
    distribute(empty, "empty", 40)
    report = {
        "algorithm": "greedy-descending-estimated-work-v1",
        "reviewers": {
            reviewer: {
                **counts[reviewer],
                "estimated_work": totals[reviewer],
                "source_ids": sorted(source_id for source_id, owner in assignments.items() if owner == reviewer),
            }
            for reviewer in REVIEWERS
        },
    }
    return assignments, report


def prepare_import(
    seed_path: Path,
    projection_path: Path,
    source_directory: Path,
    dataset_id: str,
    owner: str | None,
) -> tuple[dict[str, Any], dict[str, ClaimSource], dict[str, dict[str, Any]], dict[str, Any]]:
    records, seed_sha256 = load_seed_records(seed_path)
    source_ids = {record["meta"]["source_id"] for record in records}
    sources = load_sources(source_directory, source_ids)
    projections, projection_sha256 = load_projections(projection_path)
    validate_projection_sources(projections, sources)
    projected_records: dict[str, dict[str, Any]] = {}
    used_projection_keys: list[tuple[str, int, int, str]] = []
    for record in records:
        source_id = record["meta"]["source_id"]
        projected, used = reproject_record(record, sources[source_id].content, projections)
        projected_records[source_id] = projected
        used_projection_keys.extend(used)
    unused = sorted(set(projections).difference(used_projection_keys))
    if unused:
        raise ValueError(f"{len(unused)} projection rows were not used by any seed evidence")
    assignments, assignment_report = balanced_assignments(records, sources)
    source_gap_counts = {
        source_id: len(record["source_quality"]["gaps"])
        for source_id, record in projected_records.items()
        if record["source_quality"]["gaps"]
    }
    negative_review_blockers = {
        source_id: gap_count
        for source_id, gap_count in source_gap_counts.items()
        if not projected_records[source_id]["compositions"]
    }
    checker_accounts = [name for name in (owner, SECOND_CHECKER) if name]
    checker_accounts = list(dict.fromkeys(checker_accounts))
    seed_composition_count = sum(len(record["compositions"]) for record in records)
    constituent_count = sum(
        len(composition["constituents"])
        for record in records
        for composition in record["compositions"]
    )
    constraint_count = sum(
        len(composition["constraints"])
        for record in records
        for composition in record["compositions"]
    )
    composition_evidence_count = sum(
        len(composition["evidence_spans"])
        for record in records
        for composition in record["compositions"]
    )
    unrepresented_relation_count = sum(
        len(composition["unrepresented_relations"])
        for record in records
        for composition in record["compositions"]
    )
    source_quality_gap_count = sum(len(record["source_quality"]["gaps"]) for record in records)
    manifest = {
        "schema_version": "composition-review-v1",
        "dataset_id": dataset_id,
        "assignments": assignments,
        "seed_line_numbers": {
            record["meta"]["source_id"]: line_number
            for line_number, record in enumerate(records, start=1)
        },
        "checkers": checker_accounts,
        "sources": {
            source_id: {
                "file": f"sources/{source_id}.json",
                "array_item": 0,
                "content_field": "content",
                "content_sha256": source.content_sha256,
                "snapshot_sha256": source.file_sha256,
            }
            for source_id, source in sorted(sources.items())
        },
        "seed_sha256": seed_sha256,
        "projection_sha256": projection_sha256,
        "offset_basis": "raw_content",
        "offset_unit": "unicode_code_point",
        "interval_convention": "half-open",
        "import_validation": {
            "record_count": len(records),
            "source_count": len(sources),
            "seed_composition_count": seed_composition_count,
            "constituent_count": constituent_count,
            "constraint_count": constraint_count,
            "raw_span_reference_count": len(used_projection_keys),
            "raw_span_reference_breakdown": {
                "composition_evidence": composition_evidence_count,
                "unrepresented_relations": unrepresented_relation_count,
                "source_quality_gaps": source_quality_gap_count,
            },
            "unique_projection_count": len(set(used_projection_keys)),
            "projection_row_count": len(projections),
            "all_raw_slices_exact": True,
            "all_projection_rows_used": True,
            "source_snapshot_bytes_preserved": True,
            "sources_with_quality_gaps": source_gap_counts,
            "negative_review_blockers": negative_review_blockers,
        },
    }
    if len(records) != 100 or len(sources) != 100:
        raise ValueError("approved import requires exactly 100 seed records and sources")
    expected_counts = {
        "seed compositions": (seed_composition_count, 206),
        "constituents": (constituent_count, 1537),
        "constraints": (constraint_count, 59),
        "composition evidence spans": (composition_evidence_count, 589),
        "unrepresented relations": (unrepresented_relation_count, 172),
        "source-quality gaps": (source_quality_gap_count, 7),
    }
    mismatches = [f"{label}={actual} (expected {expected})" for label, (actual, expected) in expected_counts.items() if actual != expected]
    if mismatches:
        raise ValueError("approved seed count mismatch: " + ", ".join(mismatches))
    if len(used_projection_keys) != 768 or len(projections) != 256:
        raise ValueError(
            f"approved import expects 768 span references and 256 projections, got {len(used_projection_keys)} and {len(projections)}"
        )
    report = {
        "schema_version": manifest["schema_version"],
        "dataset_id": dataset_id,
        "dry_run": True,
        "inputs": {
            "seed": str(Path(seed_path).resolve()),
            "projection": str(Path(projection_path).resolve()),
            "sources": str(Path(source_directory).resolve()),
            "seed_sha256": seed_sha256,
            "projection_sha256": projection_sha256,
        },
        "validation": manifest["import_validation"],
        "assignment": assignment_report,
        "checkers": checker_accounts,
        "finalization_blockers": [
            {
                "source_id": source_id,
                "reason": "unresolved source-quality gaps must not be certified as a negative result",
                "gap_count": gap_count,
            }
            for source_id, gap_count in sorted(negative_review_blockers.items())
        ],
    }
    return manifest, sources, projected_records, report


def write_json(path: Path, value: Any) -> None:
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def import_workspace(
    output: Path,
    manifest: dict[str, Any],
    sources: dict[str, ClaimSource],
    records: dict[str, dict[str, Any]],
) -> None:
    workspace = Path(output)
    if workspace.exists():
        raise FileExistsError(f"review workspace already exists: {workspace}")
    workspace.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(dir=workspace.parent, prefix=f".{workspace.name}."))
    (staging / "sources").mkdir()
    (staging / "documents").mkdir()
    dataset_id = manifest["dataset_id"]
    try:
        for source_id, source in sorted(sources.items()):
            destination = staging / manifest["sources"][source_id]["file"]
            shutil.copyfile(source.path, destination)
            if destination.read_bytes() != source.raw_bytes:
                raise RuntimeError(f"source snapshot copy changed bytes for {source_id}")
            record = records[source_id]
            reviewer = manifest["assignments"][source_id]
            document = {
                "dataset_id": dataset_id,
                "source_id": source_id,
                "seed_line_number": manifest.get("seed_line_numbers", {}).get(source_id),
                "revision": 0,
                "status": "not_started",
                "reviewer": reviewer,
                "meta": deepcopy(record["meta"]),
                "source_quality": deepcopy(record["source_quality"]),
                "baseline": deepcopy(record),
                "compositions": [
                    {
                        "id": f"seed:{composition['node_no']}",
                        "seed_node_no": composition["node_no"],
                        "origin": "seed",
                        "decision": "pending",
                        "deleted": False,
                        "data": deepcopy(composition),
                    }
                    for composition in record["compositions"]
                ],
                "events": [],
                "source_checked": False,
                "review_outcome": None,
                "finalized_revision": None,
            }
            write_json(staging / "documents" / f"{source_id}.json", document)
        write_json(staging / "manifest.json", manifest)
        staging.replace(workspace)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def main() -> None:
    args = parse_args()
    if not args.dataset_id.strip():
        raise SystemExit("--dataset-id must be non-empty")
    owner = args.owner.strip() if args.owner else None
    if not args.dry_run and not owner:
        raise SystemExit("--owner is required for an import")
    manifest, sources, records, report = prepare_import(
        args.seed.resolve(),
        args.projection.resolve(),
        args.sources.resolve(),
        args.dataset_id.strip(),
        owner,
    )
    if not args.dry_run:
        import_workspace(args.output.resolve(), manifest, sources, records)
        report["dry_run"] = False
        report["workspace"] = str(args.output.resolve())
    write_json(args.report.resolve(), report)
    print(json.dumps(report["validation"], sort_keys=True))


if __name__ == "__main__":
    main()
