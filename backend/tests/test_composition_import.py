from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.claim_source import load_claim_source
from scripts.import_composition_review import Projection, import_workspace, reproject_record


def seed_record() -> dict:
    return {
        "meta": {"source_type": "patent", "source_id": "source-1", "section": "claim"},
        "compositions": [
            {
                "node_no": 1,
                "claim_no": 1,
                "composition_name": "steel",
                "composition_type": "alloy",
                "constituents": [],
                "constraints": [],
                "evidence_spans": [{"start": 0, "end": 3, "evidence_text": "ABC"}],
                "unrepresented_relations": [],
            }
        ],
        "source_quality": {
            "table_presence": "not_applicable",
            "table_quality": "not_applicable",
            "gaps": [],
            "corrections": [],
        },
    }


def test_claim_source_loads_decoded_content_and_retains_exact_snapshot_bytes(tmp_path: Path) -> None:
    raw = b'[{"patent_id":"source-1", "content":"A\\ud83e\\uddeaB"}]\n'
    path = tmp_path / "source-1.json"
    path.write_bytes(raw)
    source = load_claim_source(path, "source-1")
    assert source.raw_bytes == raw
    assert source.content == "A🧪B"
    assert len(source.content) == 3


def test_reprojection_changes_only_span_coordinates_and_text() -> None:
    record = seed_record()
    content = "<b>ABC</b>"
    projection = Projection("source-1", 0, 3, 3, 6, "ABC", "ABC")
    projected, used = reproject_record(record, content, {projection.key: projection})
    assert used == [projection.key]
    assert projected["compositions"][0]["evidence_spans"] == [
        {"start": 3, "end": 6, "evidence_text": "ABC"}
    ]
    assert record["compositions"][0]["evidence_spans"][0]["start"] == 0


def test_reprojection_fails_instead_of_guessing() -> None:
    with pytest.raises(ValueError, match="no unambiguous raw projection"):
        reproject_record(seed_record(), "ABC", {})


def test_workspace_import_is_new_only_and_source_snapshot_is_byte_exact(tmp_path: Path) -> None:
    source_path = tmp_path / "source-1.json"
    raw = b'[{"patent_id":"source-1","content":"ABC"}]\n'
    source_path.write_bytes(raw)
    source = load_claim_source(source_path, "source-1")
    record = seed_record()
    manifest = {
        "schema_version": "composition-review-v1",
        "dataset_id": "test-dataset",
        "assignments": {"source-1": "reviewer"},
        "seed_line_numbers": {"source-1": 23},
        "checkers": ["owner", "checker"],
        "sources": {"source-1": {"file": "sources/source-1.json"}},
    }
    output = tmp_path / "workspace"
    import_workspace(output, manifest, {"source-1": source}, {"source-1": record})
    assert (output / "sources" / "source-1.json").read_bytes() == raw
    document = json.loads((output / "documents" / "source-1.json").read_text())
    assert document["baseline"] == record
    assert document["seed_line_number"] == 23
    assert document["compositions"][0]["id"] == "seed:1"
    assert document["compositions"][0]["decision"] == "pending"
    assert document["source_checked"] is False
    with pytest.raises(FileExistsError):
        import_workspace(output, manifest, {"source-1": source}, {"source-1": record})
