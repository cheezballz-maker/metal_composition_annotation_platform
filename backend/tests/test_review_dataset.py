from __future__ import annotations

import base64
import importlib
import io
import json
import os
import tempfile
import unittest
import zipfile
from hashlib import sha256
from pathlib import Path

from fastapi.testclient import TestClient


ENV_KEYS = (
    "ANNOTATION_USERS_JSON",
    "ANNOTATION_APP_USERNAME",
    "ANNOTATION_APP_PASSWORD",
    "ANNOTATION_SESSION_SECRET",
    "ANNOTATION_WORKSPACE_PATH",
    "ANNOTATION_SEED_WORKSPACE",
    "ANNOTATION_REVIEW_WORKSPACE",
)
REVIEWERS = ("guoyuxin", "khushisharma")
CHECKERS = ("zhaoweijie", "leongzhiyi")


def auth(username: str) -> dict[str, str]:
    token = base64.b64encode(f"{username}:pass".encode()).decode()
    return {"Authorization": f"Basic {token}"}


def create_review_workspace(root: Path) -> dict[str, dict]:
    (root / "documents").mkdir(parents=True)
    (root / "sources").mkdir()
    assignments: dict[str, str] = {}
    source_mappings: dict[str, dict] = {}
    baselines: dict[str, dict] = {}
    for index in range(100):
        source_id = f"source-{index:03d}"
        reviewer = REVIEWERS[0] if index < 50 else REVIEWERS[1]
        content = f"Alloy source claim {index:03d}"
        raw = (json.dumps([{"patent_id": source_id, "content": content}]) + "\n").encode()
        (root / "sources" / f"{source_id}.json").write_bytes(raw)
        assignments[source_id] = reviewer
        source_mappings[source_id] = {
            "file": f"sources/{source_id}.json",
            "array_item": 0,
            "content_field": "content",
            "content_sha256": sha256(content.encode()).hexdigest(),
            "snapshot_sha256": sha256(raw).hexdigest(),
        }
        composition = {
            "node_no": 1,
            "claim_no": 1,
            "composition_name": "Alloy",
            "composition_type": "alloy",
            "constituents": [],
            "constraints": [],
            "evidence_spans": [{"start": 0, "end": 5, "evidence_text": "Alloy"}],
            "unrepresented_relations": [],
        }
        baseline = {
            "meta": {"source_type": "patent", "source_id": source_id, "section": "claim"},
            "compositions": [composition],
            "source_quality": {
                "table_presence": "not_applicable",
                "table_quality": "not_applicable",
                "gaps": [],
                "corrections": [],
            },
            "portable_unknown_field": {"preserved": index},
        }
        baselines[source_id] = baseline
        document = {
            "dataset_id": "portable-review-dataset",
            "source_id": source_id,
            "seed_line_number": index + 1,
            "revision": 0,
            "status": "not_started",
            "reviewer": reviewer,
            "meta": baseline["meta"],
            "source_quality": baseline["source_quality"],
            "baseline": baseline,
            "compositions": [
                {
                    "id": "seed:1",
                    "seed_node_no": 1,
                    "origin": "seed",
                    "decision": "pending",
                    "deleted": False,
                    "data": composition,
                }
            ],
            "events": [],
            "source_checked": False,
            "review_outcome": None,
            "finalized_revision": None,
        }
        (root / "documents" / f"{source_id}.json").write_text(
            json.dumps(document), encoding="utf-8"
        )
    manifest = {
        "schema_version": "composition-review-v1",
        "dataset_id": "portable-review-dataset",
        "assignments": assignments,
        "seed_line_numbers": {source_id: index + 1 for index, source_id in enumerate(assignments)},
        "checkers": list(CHECKERS),
        "sources": source_mappings,
        "seed_sha256": "seed-fixture",
        "projection_sha256": "projection-fixture",
        "offset_basis": "raw_content",
        "offset_unit": "unicode_code_point",
        "interval_convention": "half-open",
    }
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return baselines


class ReviewDatasetAccessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.review_workspace = tempfile.TemporaryDirectory()
        self.legacy_workspace = tempfile.TemporaryDirectory()
        self.baselines = create_review_workspace(Path(self.review_workspace.name))
        self.saved_env = {key: os.environ.get(key) for key in ENV_KEYS}
        for key in ENV_KEYS:
            os.environ.pop(key, None)
        os.environ.update(
            {
                "ANNOTATION_REVIEW_WORKSPACE": self.review_workspace.name,
                "ANNOTATION_WORKSPACE_PATH": self.legacy_workspace.name,
                "ANNOTATION_SEED_WORKSPACE": "0",
                "ANNOTATION_USERS_JSON": json.dumps(
                    [
                        {"username": username, "password": "pass", "document_globs": ["*"]}
                        for username in (*REVIEWERS, *CHECKERS)
                    ]
                ),
            }
        )
        import backend.main

        self.backend = importlib.reload(backend.main)
        self.client = TestClient(self.backend.app)

    def tearDown(self) -> None:
        self.client.close()
        for key in ENV_KEYS:
            os.environ.pop(key, None)
        for key, value in self.saved_env.items():
            if value is not None:
                os.environ[key] = value
        self.review_workspace.cleanup()
        self.legacy_workspace.cleanup()

    def queue(self, username: str) -> list[dict]:
        response = self.client.get("/api/review", headers=auth(username))
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["records"]

    def test_manifest_assignment_visibility_and_cross_assignment_denial(self) -> None:
        first = self.queue(REVIEWERS[0])
        second = self.queue(REVIEWERS[1])
        self.assertEqual(len(first), 50)
        self.assertEqual(len(second), 50)
        self.assertEqual({entry["source_id"] for entry in first}, set(list(self.baselines)[:50]))
        self.assertEqual({entry["source_id"] for entry in second}, set(list(self.baselines)[50:]))
        for checker in CHECKERS:
            self.assertEqual(len(self.queue(checker)), 100)

        foreign = "source-050"
        self.assertEqual(
            self.client.get(f"/api/review/records/{foreign}", headers=auth(REVIEWERS[0])).status_code,
            404,
        )
        denied_action = self.client.post(
            f"/api/review/records/{foreign}/actions",
            headers=auth(REVIEWERS[0]),
            json={
                "action_id": "cross-assignment",
                "revision": 0,
                "action": "accept",
                "composition_id": "seed:1",
            },
        )
        self.assertEqual(denied_action.status_code, 404)

    def test_progress_exports_are_scoped_and_checker_round_trips_all_baselines(self) -> None:
        reviewer_export = self.client.get("/api/review/export", headers=auth(REVIEWERS[0]))
        self.assertEqual(reviewer_export.status_code, 200, reviewer_export.text)
        with zipfile.ZipFile(io.BytesIO(reviewer_export.content)) as bundle:
            manifest = json.loads(bundle.read("manifest.json"))
            self.assertEqual(manifest["exported_source_count"], 50)
            self.assertEqual(manifest["omitted_source_count"], 50)
            self.assertEqual(set(manifest["assignments"].values()), {REVIEWERS[0]})
            self.assertEqual(len([name for name in bundle.namelist() if name.startswith("sources/")]), 50)

        checker_export = self.client.get("/api/review/export", headers=auth(CHECKERS[0]))
        self.assertEqual(checker_export.status_code, 200, checker_export.text)
        with zipfile.ZipFile(io.BytesIO(checker_export.content)) as bundle:
            exported = {
                record["meta"]["source_id"]: record
                for record in (
                    json.loads(line) for line in bundle.read("gold.jsonl").splitlines()
                )
            }
            self.assertEqual(exported, self.baselines)
            self.assertEqual(
                len([name for name in bundle.namelist() if name.startswith("sources/")]), 100
            )


if __name__ == "__main__":
    unittest.main()
