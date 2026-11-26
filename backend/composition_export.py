"""Conservative composition identity and self-contained raw-coordinate exports.

No chemical aliases or dimensional conversions are approved in version 1.
Identity is deliberately case sensitive and never changes the exported record.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import zipfile
from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal
from html import unescape
from .description_schema import clean_description_composition

NORMALIZATION_VERSION = "composition-conservative-v1"
_TAGS = re.compile(
    r"</?(?:div|p|br|span|sub|sup|b|strong|i|em|u|table|thead|tbody|tfoot|tr|td|th|"
    r"claim|claim-text|claims|seg-[a-z-]+|img|h[1-6]|ul|ol|li)\b[^>]*>", re.I
)
_BLOCK = re.compile(r"</?(?:div|p|br|table|thead|tbody|tfoot|tr|td|th|h[1-6]|li)\b", re.I)


def readable_relation(raw: str) -> str:
    """Remove recognized presentation markup, preserving literal comparisons."""
    return " ".join(unescape(_TAGS.sub(lambda m: " " if _BLOCK.match(m[0]) else "", raw)).split())


def _normalize(value):
    if isinstance(value, str):
        return " ".join(value.split())
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (float, int)):
        number = Decimal(str(value))
        if not number.is_finite():
            raise ValueError("Non-finite amounts cannot be normalized")
        # Numeric type remains distinct from null and literal strings.
        return {"$number": "0" if number == 0 else format(number.normalize(), "f")}
    if isinstance(value, list):
        return [_normalize(item) for item in value]
    if isinstance(value, dict):
        return {key: _normalize(item) for key, item in sorted(value.items())}
    raise ValueError(f"Unsupported annotation value: {type(value).__name__}")


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def canonical_composition(composition: dict) -> str:
    semantic = {key: deepcopy(value) for key, value in composition.items()
                if key not in {"node_no", "claim_no", "evidence_spans", "constituents", "constraints", "unrepresented_relations"}}
    constituents = deepcopy(composition.get("constituents", []))
    for constituent in constituents:
        # New labeled amounts retain their provenance in exports, but a second
        # occurrence at another location is not a different chemical profile.
        if isinstance(constituent.get("amounts"), list):
            constituent["amounts"] = [
                {key: value for key, value in amount.items() if key != "evidence_spans"}
                for amount in constituent["amounts"]
            ]
    semantic["constituents"] = sorted((_normalize(c) for c in constituents), key=_json)
    constraints = []
    for constraint in composition.get("constraints", []):
        item = {key: value for key, value in constraint.items()
                if key not in {"constraint_id", "evidence", "evidence_spans", "member_refs"}}
        refs = [_normalize(v) for v in constraint.get("member_refs", [])]
        item["member_refs"] = refs if constraint.get("mode") == "ratio" else sorted(refs, key=_json)
        constraints.append(_normalize(item))
    semantic["constraints"] = sorted(constraints, key=_json)
    relations = []
    for relation in composition.get("unrepresented_relations", []):
        if isinstance(relation, dict):
            span = relation.get("evidence_span") if isinstance(relation.get("evidence_span"), dict) else relation
            item = {key: value for key, value in relation.items() if key not in {"start", "end", "evidence_text", "evidence_span"}}
            item["meaning"] = readable_relation(span.get("evidence_text", ""))
        else:
            item = readable_relation(str(relation))
        relations.append(_normalize(item))
    semantic["unrepresented_relations"] = sorted(relations, key=_json)
    # Constituents and constraints are already normalized; normalize top-level
    # semantic scalar fields separately to avoid normalizing tagged numbers twice.
    for key in set(semantic) - {"constituents", "constraints", "unrepresented_relations"}:
        semantic[key] = _normalize(semantic[key])
    return _json(semantic)


def summarize_document(document: dict) -> dict:
    retained = [entry for entry in document["compositions"] if not entry.get("deleted")]
    groups: dict[str, list[str]] = {}
    candidates: dict[str, list[str]] = {}
    for entry in retained:
        signature = canonical_composition(entry["data"])
        digest = hashlib.sha256(signature.encode()).hexdigest()
        groups.setdefault(digest, []).append(entry["id"])
        candidate = json.loads(signature)
        candidate.pop("composition_name", None)
        candidate.pop("unrepresented_relations", None)
        candidates.setdefault(_json(candidate), []).append(digest)
    ambiguous = [sorted(set(ids)) for ids in candidates.values() if len(set(ids)) > 1]
    return {
        "source_id": document["source_id"],
        "mention_count": len(retained),
        "unique_composition_count": len(groups),
        "pending_count": sum(entry.get("origin") == "seed" and entry.get("decision") == "pending"
                             for entry in document["compositions"]),
        "canonical_groups": [{"group_id": f"{document['source_id']}:{digest}",
                              "signature_sha256": digest, "mention_ids": ids}
                             for digest, ids in sorted(groups.items())],
        "ambiguous_candidate_groups": ambiguous,
        "normalization_version": NORMALIZATION_VERSION,
    }


def corrected_record(document: dict) -> dict:
    # Preserve unknown record-level fields from the baseline as well.
    record = deepcopy(document["baseline"])
    record["meta"] = deepcopy(document["meta"])
    record["source_quality"] = deepcopy(document["source_quality"])
    record["compositions"] = [deepcopy(entry["data"]) for entry in document["compositions"] if not entry.get("deleted")]
    if record.get("meta", {}).get("section") == "description":
        record["compositions"] = [clean_description_composition(c) for c in record["compositions"]]
    return record


def build_export_bundle(manifest: dict, documents: list[dict], source_snapshots: dict[str, bytes],
                        *, actor: str, mode: str = "progress") -> bytes:
    """Build a bundle from an authorized, locked snapshot supplied by the store."""
    from .composition_schema import validate_record
    from .review_workflow import WorkflowError, validate_final_review, description_done, is_description

    if mode not in {"progress", "final"}:
        raise ValueError("Export mode must be progress or final")
    expected = set(manifest["sources"])
    ids = [doc["source_id"] for doc in documents]
    if len(ids) != len(set(ids)) or not set(ids) <= expected:
        raise ValueError("Export includes duplicate or unknown source IDs")
    if not set(ids) <= set(source_snapshots):
        raise ValueError("Export is missing required source snapshots")
    if mode == "final" and (set(ids) != expected or any(
        not (description_done(doc) and (doc["status"] == "submitted" or doc.get("finalized_revision") == doc["revision"]))
        if is_description(doc) else doc["status"] != "finalized" or doc.get("finalized_revision") != doc["revision"] for doc in documents
    )):
        if documents and all(is_description(doc) for doc in documents):
            raise ValueError("Complete every document before exporting the completed dataset")
        raise ValueError("Final export requires every record finalized at its current revision")
    ordered = sorted(documents, key=lambda doc: doc["source_id"])
    records, reports, audits, source_files = [], [], [], {}
    for doc in ordered:
        sid = doc["source_id"]
        if mode == "final":
            try:
                validate_final_review(doc, frozenset(manifest.get("import_validation", {}).get("negative_review_blockers", {})))
            except WorkflowError as exc:
                raise ValueError(f"Final export record {sid}: {exc}") from exc
            approval_actions = {"finalize", "mark_done", "submit"} if is_description(doc) else {"finalize"}
            if not doc["events"] or doc["events"][-1].get("action") not in approval_actions or doc["events"][-1].get("new_revision") != doc["revision"]:
                raise ValueError(f"Final export record {sid} lacks its revision's approval event")
        for event in doc["events"]:
            required = ("action_id", "action", "actor", "role", "timestamp", "dataset_id", "source_id", "previous_revision", "new_revision")
            if any(key not in event for key in required) or not event["actor"] or event["source_id"] != sid or event["dataset_id"] != manifest["dataset_id"]:
                raise ValueError(f"Incomplete or mismatched audit event in {sid}")
        source = manifest["sources"][sid]
        snapshot = source_snapshots[sid]
        decoded = json.loads(snapshot)
        value = decoded[source.get("array_item", 0)] if isinstance(decoded, list) else decoded
        content = value[source.get("content_field", "content")]
        digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
        if digest != source["content_sha256"]:
            raise ValueError(f"Source content hash mismatch: {sid}")
        if source.get("snapshot_sha256") and hashlib.sha256(snapshot).hexdigest() != source["snapshot_sha256"]:
            raise ValueError(f"Source snapshot hash mismatch: {sid}")
        record = corrected_record(doc)
        validate_record(record, content)
        records.append(record)
        metrics = summarize_document(doc)
        metrics.update(status=doc["status"], reviewer=doc["reviewer"], revision=doc["revision"],
                       finalizer=next((event.get("actor") for event in reversed(doc["events"])
                                       if event.get("action") in ({"finalize", "mark_done", "submit"} if is_description(doc) else {"finalize"})), None))
        reports.append(metrics)
        audits.extend(doc["events"])
        source_files[f"sources/{sid}.json"] = snapshot
    status_counts = {}
    for report in reports:
        status_counts[report["status"]] = status_counts.get(report["status"], 0) + 1
    summary = {
        "mode": mode, "dataset_id": manifest["dataset_id"], "normalization_version": NORMALIZATION_VERSION,
        "expected_source_count": len(expected), "exported_source_count": len(ids),
        "omitted_source_count": len(expected - set(ids)),
        "mention_count": sum(item["mention_count"] for item in reports),
        "sum_per_source_unique_composition_count": sum(item["unique_composition_count"] for item in reports),
        "dataset_wide_distinct_signature_count": len({group["signature_sha256"] for item in reports for group in item["canonical_groups"]}),
        "status_counts": status_counts, "sources": reports,
    }
    exported_manifest = deepcopy(manifest)
    # Subset exports must not expose other reviewers' source mappings/assignments.
    exported_manifest["sources"] = {sid: {**manifest["sources"][sid], "file": f"sources/{sid}.json"} for sid in ids}
    exported_manifest["assignments"] = {sid: manifest["assignments"][sid] for sid in ids}
    if "seed_line_numbers" in exported_manifest:
        exported_manifest["seed_line_numbers"] = {sid: value for sid, value in manifest["seed_line_numbers"].items() if sid in ids}
    # Import summaries may contain per-source diagnostics outside this export.
    for key in ("source_gaps", "blocking_gaps", "assignment_report", "import_report"):
        exported_manifest.pop(key, None)
    validation = exported_manifest.get("import_validation", {})
    for key in ("sources_with_quality_gaps", "negative_review_blockers"):
        if isinstance(validation.get(key), dict):
            validation[key] = {sid: count for sid, count in validation[key].items() if sid in ids}
    exported_manifest.update(
        export_mode=mode, export_actor=actor, export_time=datetime.now(timezone.utc).isoformat(),
        normalization_version=NORMALIZATION_VERSION, offset_basis="raw_content", offset_unit="unicode_code_point",
        interval_convention="half-open", exported_revisions={doc["source_id"]: doc["revision"] for doc in ordered},
        expected_source_count=len(expected), exported_source_count=len(ids), omitted_source_count=len(expected - set(ids)),
        finalized_source_count=status_counts.get("finalized", 0),
        normalization_policy={"approved_aliases": {}, "unit_conversions": [], "chemical_names_case_sensitive": True},
    )
    rows = io.StringIO(newline="")
    columns = ["source_id", "mention_count", "unique_composition_count", "pending_count", "status", "reviewer", "finalizer", "revision"]
    writer = csv.DictWriter(rows, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(reports)
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr("gold.jsonl", "".join(_json(record) + "\n" for record in records))
        bundle.writestr("audit.jsonl", "".join(_json(event) + "\n" for event in audits))
        bundle.writestr("summary.json", json.dumps(summary, ensure_ascii=False, indent=2, allow_nan=False))
        bundle.writestr("per-source.csv", rows.getvalue())
        bundle.writestr("manifest.json", json.dumps(exported_manifest, ensure_ascii=False, indent=2, allow_nan=False))
        for name, snapshot in source_files.items():
            bundle.writestr(name, snapshot)
    return output.getvalue()
