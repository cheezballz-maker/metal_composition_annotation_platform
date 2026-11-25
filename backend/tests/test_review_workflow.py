from __future__ import annotations

import base64
import importlib
import json
import os
import tempfile
import threading
import unittest
from hashlib import sha256
from pathlib import Path

from fastapi.testclient import TestClient

from backend.composition_schema import validate_composition, validate_record
from backend.review_store import ReviewStore, ReviewStoreError, request_digest
from backend.review_workflow import apply_action


ENV_KEYS = (
    "ANNOTATION_USERS_JSON",
    "ANNOTATION_APP_USERNAME",
    "ANNOTATION_APP_PASSWORD",
    "ANNOTATION_SESSION_SECRET",
    "ANNOTATION_WORKSPACE_PATH",
    "ANNOTATION_SEED_WORKSPACE",
    "ANNOTATION_REVIEW_WORKSPACE",
    "ANNOTATION_REVIEW_WORKSPACES_JSON",
)


def auth(username: str, password: str = "pass") -> dict[str, str]:
    token = base64.b64encode(f"{username}:{password}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


def composition(node_no: int = 1, name: str = "Alloy") -> dict:
    return {
        "node_no": node_no,
        "claim_no": 1,
        "composition_name": name,
        "composition_type": "alloy",
        "constituents": [],
        "constraints": [],
        "evidence_spans": [{"start": 0, "end": 5, "evidence_text": "Alloy"}],
        "unrepresented_relations": [],
    }


def source_quality(gaps: list | None = None) -> dict:
    return {
        "table_presence": "none",
        "table_quality": "not_applicable",
        "gaps": gaps or [],
        "corrections": [],
    }


def make_workspace(root: Path, *, include_gap: bool = False) -> None:
    (root / "documents").mkdir(parents=True)
    (root / "sources").mkdir()
    content = "Alloy source claim"
    sources = {}
    assignments = {"source-a": "alice", "source-b": "bob"}
    for source_id in assignments:
        raw = json.dumps([{"patent_id": source_id, "content": content}], ensure_ascii=False).encode()
        (root / "sources" / f"{source_id}.json").write_bytes(raw)
        sources[source_id] = {
            "file": f"sources/{source_id}.json",
            "array_item": 0,
            "content_field": "content",
            "content_sha256": sha256(content.encode()).hexdigest(),
            "snapshot_sha256": sha256(raw).hexdigest(),
        }
        quality = source_quality(
            [{"kind": "missing_image", "start": 6, "end": 12, "evidence_text": "source"}]
            if include_gap and source_id == "source-a" else []
        )
        seeded = [] if include_gap and source_id == "source-a" else [composition()]
        record = {
            "meta": {"source_type": "patent", "source_id": source_id, "section": "claim"},
            "source_quality": quality,
            "compositions": seeded,
        }
        document = {
            "dataset_id": "test-dataset",
            "source_id": source_id,
            "revision": 0,
            "status": "not_started",
            "reviewer": assignments[source_id],
            "meta": record["meta"],
            "source_quality": quality,
            "baseline": record,
            "compositions": [
                {
                    "id": "seed:1",
                    "seed_node_no": 1,
                    "origin": "seed",
                    "decision": "pending",
                    "deleted": False,
                    "data": composition(),
                }
            ] if seeded else [],
            "events": [],
            "source_checked": False,
            "review_outcome": None,
            "finalized_revision": None,
        }
        (root / "documents" / f"{source_id}.json").write_text(json.dumps(document), encoding="utf-8")
    manifest = {
        "schema_version": "composition-review-v1",
        "dataset_id": "test-dataset",
        "assignments": assignments,
        "checkers": ["checker", "leongzhiyi", "admin"],
        "sources": sources,
    }
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")


def workflow_mutator(payload: dict, actor: str = "alice", role: str = "reviewer", content: str = "Alloy source claim", blocking: bool = False):
    return lambda document, revision: apply_action(
        document,
        payload,
        actor=actor,
        role=role,
        content=content,
        next_revision=revision,
        validate_record=validate_record,
        validate_composition=validate_composition,
        blocking_source_ids=frozenset({"source-a"}) if blocking else frozenset(),
    )


class ReviewStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        make_workspace(self.root)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def commit(self, store: ReviewStore, payload: dict, revision: int = 0):
        return store.commit(
            "source-a",
            expected_revision=revision,
            action_id=payload["action_id"],
            request_digest=request_digest(payload),
            actor="alice",
            role="reviewer",
            timestamp="2026-09-15T00:00:00+00:00",
            mutate=workflow_mutator(payload),
        )

    def test_atomic_event_and_idempotent_retry(self) -> None:
        store = ReviewStore(self.root)
        payload = {"action_id": "accept-1", "revision": 0, "action": "accept", "composition_id": "seed:1"}
        document, retried = self.commit(store, payload)
        self.assertFalse(retried)
        self.assertEqual(document["revision"], 1)
        self.assertEqual(document["status"], "in_review")
        self.assertEqual(document["compositions"][0]["decision"], "accepted")
        self.assertEqual(document["events"][0]["actor"], "alice")
        self.assertEqual(document["events"][0]["previous_revision"], 0)

        repeated, retried = self.commit(store, payload)
        self.assertTrue(retried)
        self.assertEqual(repeated, document)
        self.assertEqual(len(repeated["events"]), 1)

        changed = dict(payload, action="reverse")
        with self.assertRaisesRegex(ReviewStoreError, "different request"):
            self.commit(store, changed)

    def test_concurrent_stale_write_has_one_winner(self) -> None:
        store = ReviewStore(self.root)
        barrier = threading.Barrier(3)
        outcomes: list[str] = []

        def write(action_id: str) -> None:
            payload = {"action_id": action_id, "revision": 0, "action": "accept", "composition_id": "seed:1"}
            barrier.wait()
            try:
                self.commit(store, payload)
                outcomes.append("saved")
            except ReviewStoreError as exc:
                outcomes.append(f"error:{exc.status_code}")

        threads = [threading.Thread(target=write, args=(f"accept-{index}",)) for index in range(2)]
        for thread in threads:
            thread.start()
        barrier.wait()
        for thread in threads:
            thread.join()
        self.assertCountEqual(outcomes, ["saved", "error:409"])
        document = store.load_document("source-a")
        self.assertEqual(document["revision"], 1)
        self.assertEqual(len(document["events"]), 1)

    def test_failed_persistence_changes_neither_state_nor_history(self) -> None:
        def broken_writer(path: Path, value: dict) -> None:
            raise OSError("disk full")

        store = ReviewStore(self.root, writer=broken_writer)
        payload = {"action_id": "accept-1", "revision": 0, "action": "accept", "composition_id": "seed:1"}
        with self.assertRaisesRegex(ReviewStoreError, "could not be persisted"):
            self.commit(store, payload)
        unchanged = ReviewStore(self.root).load_document("source-a")
        self.assertEqual(unchanged["revision"], 0)
        self.assertEqual(unchanged["events"], [])
        self.assertEqual(unchanged["compositions"][0]["decision"], "pending")

    def test_add_allocates_node_number_and_requires_raw_evidence(self) -> None:
        store = ReviewStore(self.root)
        added_data = composition(node_no=999, name="Added alloy")
        payload = {"action_id": "new-composition", "revision": 0, "action": "add", "data": added_data}
        document, _ = self.commit(store, payload)
        added = document["compositions"][-1]
        self.assertEqual(added["id"], "added:new-composition")
        self.assertEqual(added["data"]["node_no"], 2)
        self.assertEqual(added["creator"], "alice")

        invalid = composition(node_no=50)
        invalid["evidence_spans"] = []
        payload = {"action_id": "no-evidence", "revision": 1, "action": "add", "data": invalid}
        with self.assertRaisesRegex(ValueError, "evidence_spans is required"):
            self.commit(store, payload, revision=1)
        self.assertEqual(store.load_document("source-a")["revision"], 1)

    def test_add_accepts_constituent_backed_rare_earth_constraint(self) -> None:
        store = ReviewStore(self.root)
        added_data = composition(node_no=999, name="Copper alloy wire")
        added_data["constituents"] = [
            {"constituent_name": name, "constituent_status": "included"}
            for name in ("silver", "zirconium", "cerium", "lanthanum", "yttrium", "copper")
        ]
        added_data["constraints"] = [
            {
                "constraint_id": "rare-earth-selection",
                "mode": "any_of",
                "member_refs": ["cerium", "lanthanum", "yttrium"],
                "constituent_status": "included",
                "selection": {"min": 1, "max": 3},
                "amount_comparator": "range",
                "amount_unit": "%",
                "amount_lower_value": 0.05,
                "amount_lower_endpoint_type": "closed",
                "amount_upper_value": 0.2,
                "amount_upper_endpoint_type": "closed",
                "evidence": "rare earth metal is one or more selected from cerium, lanthanum, and yttrium",
            }
        ]
        payload = {"action_id": "rare-earth-composition", "revision": 0, "action": "add", "data": added_data}
        document, _ = self.commit(store, payload)
        saved = document["compositions"][-1]["data"]
        self.assertEqual(saved["constraints"][0]["member_refs"], ["cerium", "lanthanum", "yttrium"])
        self.assertEqual(saved["constraints"][0]["selection"], {"min": 1, "max": 3})

    def test_source_patent_identity_is_verified(self) -> None:
        store = ReviewStore(self.root)
        raw = json.dumps([{"patent_id": "wrong-source", "content": "Alloy source claim"}]).encode()
        (self.root / "sources" / "source-a.json").write_bytes(raw)
        store.manifest["sources"]["source-a"]["snapshot_sha256"] = sha256(raw).hexdigest()
        with self.assertRaisesRegex(ReviewStoreError, "patent_id mismatch"):
            store.load_source("source-a")


class ReviewApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        make_workspace(self.root)
        self.saved_env = {key: os.environ.get(key) for key in ENV_KEYS}
        for key in ENV_KEYS:
            os.environ.pop(key, None)
        os.environ["ANNOTATION_REVIEW_WORKSPACE"] = str(self.root)
        os.environ["ANNOTATION_USERS_JSON"] = json.dumps(
            [
                {"username": "alice", "password": "pass", "document_globs": ["*"]},
                {"username": "bob", "password": "pass", "document_globs": ["*"]},
                {"username": "checker", "password": "pass", "document_globs": ["*"]},
                {"username": "admin", "password": "pass", "document_globs": ["*"]},
                {"username": "outsider", "password": "pass", "document_globs": ["*"]},
            ]
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
        self.temp.cleanup()

    def test_queue_and_record_access_follow_manifest_roles(self) -> None:
        self.assertEqual(self.client.get("/api/review").status_code, 401)
        queue = self.client.get("/api/review", headers=auth("alice"))
        self.assertEqual(queue.status_code, 200, queue.text)
        self.assertEqual(queue.json()["role"], "reviewer")
        self.assertEqual([item["source_id"] for item in queue.json()["records"]], ["source-a"])
        self.assertEqual(self.client.get("/api/review/records/source-b", headers=auth("alice")).status_code, 404)

        checker = self.client.get("/api/review", headers=auth("checker")).json()
        self.assertEqual(checker["role"], "checker")
        self.assertEqual(len(checker["records"]), 2)
        self.assertEqual(self.client.get("/api/review", headers=auth("outsider")).status_code, 403)

    def test_admin_full_workflow_and_audit(self) -> None:
        queue = self.client.get("/api/review", headers=auth("admin")).json()
        self.assertEqual(queue["role"], "admin")
        self.assertEqual(len(queue["records"]), 2)
        url = "/api/review/records/source-b/actions"
        revision = 0

        def action(kind, **fields):
            nonlocal revision
            response = self.client.post(url, headers=auth("admin"), json={
                "action_id": f"admin-{revision}-{kind}", "revision": revision, "action": kind, **fields,
            })
            self.assertEqual(response.status_code, 200, response.text)
            doc = response.json()["document"]
            revision = doc["revision"]
            self.assertEqual(doc["events"][-1]["actor"], "admin")
            self.assertEqual(doc["events"][-1]["role"], "admin")
            return doc

        action("accept", composition_id="seed:1")
        action("save_review", source_checked=True, review_outcome="compositions_found")
        finalized = action("finalize")
        self.assertEqual(finalized["status"], "finalized")
        self.assertEqual(finalized["finalized_revision"], revision)
        self.assertEqual(finalized["reviewer"], "bob")
        action("reopen", reason="Check again")
        action("return", reason="Please recheck")
        self.assertEqual(action("finalize")["status"], "finalized")
        action("reopen", reason="Edit again")
        action("return", reason="Revisit")
        self.assertEqual(action("submit", source_checked=True, review_outcome="compositions_found")["status"], "submitted")

    def test_admin_finalization_keeps_validation_guards(self) -> None:
        from copy import deepcopy
        from backend.review_workflow import WorkflowError
        document = ReviewStore(self.root).load_document("source-a")
        document.update(source_checked=True, review_outcome="compositions_found")
        payload = {"action": "finalize"}
        with self.assertRaisesRegex(WorkflowError, "requires a decision"):
            workflow_mutator(payload, actor="admin", role="admin")(deepcopy(document), 1)
        document["compositions"][0]["decision"] = "accepted"
        for status in ["not_started", "in_review", "returned", "submitted"]:
            candidate = deepcopy(document)
            candidate["status"] = status
            final, _ = workflow_mutator(payload, actor="admin", role="admin")(candidate, 1)
            self.assertEqual(final["status"], "finalized")
        for role in ["reviewer", "checker"]:
            with self.assertRaises(WorkflowError):
                workflow_mutator(payload, actor=role, role=role)(deepcopy(document), 1)
        document.update(review_outcome="needs_adjudication", review_reason="Needs expert review")
        with self.assertRaisesRegex(WorkflowError, "still requires adjudication"):
            workflow_mutator(payload, actor="admin", role="admin")(deepcopy(document), 1)
        document.update(review_outcome="compositions_found", source_checked=False)
        with self.assertRaisesRegex(WorkflowError, "acknowledgment"):
            workflow_mutator(payload, actor="admin", role="admin")(deepcopy(document), 1)
        document.update(source_checked=True, status="finalized")
        with self.assertRaises(WorkflowError):
            workflow_mutator(payload, actor="admin", role="admin")(deepcopy(document), 2)

    def test_review_submit_and_checker_finalize(self) -> None:
        accepted = self.client.post(
            "/api/review/records/source-a/actions",
            headers=auth("alice"),
            json={"action_id": "accept-a", "revision": 0, "action": "accept", "composition_id": "seed:1"},
        )
        self.assertEqual(accepted.status_code, 200, accepted.text)
        retry = self.client.post(
            "/api/review/records/source-a/actions",
            headers=auth("alice"),
            json={"action_id": "accept-a", "revision": 0, "action": "accept", "composition_id": "seed:1"},
        )
        self.assertTrue(retry.json()["idempotent"])

        missing_ack = self.client.post(
            "/api/review/records/source-a/actions",
            headers=auth("alice"),
            json={"action_id": "submit-a", "revision": 1, "action": "submit", "review_outcome": "compositions_found"},
        )
        self.assertEqual(missing_ack.status_code, 422)
        submitted = self.client.post(
            "/api/review/records/source-a/actions",
            headers=auth("alice"),
            json={
                "action_id": "submit-b", "revision": 1, "action": "submit",
                "source_checked": True, "review_outcome": "compositions_found",
            },
        )
        self.assertEqual(submitted.status_code, 200, submitted.text)
        self.assertEqual(submitted.json()["document"]["status"], "submitted")
        self.assertEqual(
            self.client.post(
                "/api/review/records/source-a/actions", headers=auth("alice"),
                json={"action_id": "edit-late", "revision": 2, "action": "edit", "composition_id": "seed:1", "reason": "late", "data": composition(name="Changed")},
            ).status_code,
            409,
        )
        finalized = self.client.post(
            "/api/review/records/source-a/actions",
            headers=auth("checker"),
            json={"action_id": "finalize-a", "revision": 2, "action": "finalize"},
        )
        self.assertEqual(finalized.status_code, 200, finalized.text)
        document = finalized.json()["document"]
        self.assertEqual(document["revision"], 3)
        self.assertEqual(document["finalized_revision"], 3)
        self.assertEqual(document["events"][-1]["actor"], "checker")

    def test_edit_delete_and_return_reasons_are_enforced(self) -> None:
        for action in ("edit", "delete"):
            data = composition(name="Changed") if action == "edit" else None
            response = self.client.post(
                "/api/review/records/source-a/actions",
                headers=auth("alice"),
                json={"action_id": action, "revision": 0, "action": action, "composition_id": "seed:1", "reason": "  ", "data": data},
            )
            self.assertEqual(response.status_code, 422, response.text)

    def test_return_resubmit_reopen_and_checker_correction(self) -> None:
        def action(user: str, body: dict) -> dict:
            response = self.client.post("/api/review/records/source-a/actions", headers=auth(user), json=body)
            self.assertEqual(response.status_code, 200, response.text)
            return response.json()["document"]

        document = action("alice", {"action_id": "a1", "revision": 0, "action": "accept", "composition_id": "seed:1"})
        document = action("alice", {"action_id": "s1", "revision": 1, "action": "submit", "source_checked": True, "review_outcome": "compositions_found"})
        missing_reason = self.client.post(
            "/api/review/records/source-a/actions", headers=auth("checker"),
            json={"action_id": "r0", "revision": 2, "action": "return", "reason": " "},
        )
        self.assertEqual(missing_reason.status_code, 422)
        document = action("checker", {"action_id": "r1", "revision": 2, "action": "return", "reason": "Clarify the name"})
        self.assertEqual(document["status"], "returned")
        changed = composition(name="Reviewed alloy")
        document = action("alice", {"action_id": "e1", "revision": 3, "action": "edit", "composition_id": "seed:1", "reason": "Corrected source wording", "data": changed})
        self.assertEqual(document["status"], "in_review")
        document = action("alice", {"action_id": "s2", "revision": 4, "action": "submit", "source_checked": True, "review_outcome": "compositions_found"})
        document = action("checker", {"action_id": "f1", "revision": 5, "action": "finalize"})
        self.assertEqual(document["finalized_revision"], 6)
        document = action("checker", {"action_id": "o1", "revision": 6, "action": "reopen", "reason": "Checker correction needed"})
        self.assertIsNone(document["finalized_revision"])
        document = action("checker", {"action_id": "e2", "revision": 7, "action": "edit", "composition_id": "seed:1", "reason": "Checker corrected the name", "data": composition(name="Final alloy")})
        self.assertEqual(document["status"], "submitted")
        self.assertIsNone(document["finalized_revision"])
        document = action("checker", {"action_id": "f2", "revision": 8, "action": "finalize"})
        self.assertEqual(document["finalized_revision"], 9)

    def test_revision_is_strict_and_meta_identity_is_immutable(self) -> None:
        boolean_revision = self.client.post(
            "/api/review/records/source-a/actions", headers=auth("alice"),
            json={"action_id": "bad-revision", "revision": True, "action": "accept", "composition_id": "seed:1"},
        )
        self.assertEqual(boolean_revision.status_code, 422)
        changed_meta = {"source_type": "patent", "source_id": "different", "section": "claim"}
        response = self.client.post(
            "/api/review/records/source-a/actions", headers=auth("alice"),
            json={"action_id": "bad-meta", "revision": 0, "action": "metadata", "reason": "try", "data": {"meta": changed_meta}},
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(
            self.client.get("/api/review/records/source-a", headers=auth("alice")).json()["document"]["revision"],
            0,
        )

    def test_meaningless_actions_are_rejected_without_history(self) -> None:
        accepted = self.client.post(
            "/api/review/records/source-a/actions", headers=auth("alice"),
            json={"action_id": "accept-first", "revision": 0, "action": "accept", "composition_id": "seed:1"},
        )
        self.assertEqual(accepted.status_code, 200)
        again = self.client.post(
            "/api/review/records/source-a/actions", headers=auth("alice"),
            json={"action_id": "accept-again", "revision": 1, "action": "accept", "composition_id": "seed:1"},
        )
        self.assertEqual(again.status_code, 409)
        same_edit = self.client.post(
            "/api/review/records/source-a/actions", headers=auth("alice"),
            json={"action_id": "same-edit", "revision": 1, "action": "edit", "composition_id": "seed:1", "reason": "No actual change", "data": composition()},
        )
        self.assertEqual(same_edit.status_code, 409)
        document = self.client.get("/api/review/records/source-a", headers=auth("alice")).json()["document"]
        self.assertEqual(document["revision"], 1)
        self.assertEqual(len(document["events"]), 1)

    def test_progress_export_is_scoped_and_final_export_requires_checker(self) -> None:
        progress = self.client.get("/api/review/export?mode=progress", headers=auth("alice"))
        self.assertEqual(progress.status_code, 200, progress.text)
        self.assertEqual(progress.headers["content-type"], "application/zip")
        self.assertEqual(self.client.get("/api/review/export?mode=final", headers=auth("alice")).status_code, 403)


class SourceGapWorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        make_workspace(self.root, include_gap=True)
        self.store = ReviewStore(self.root)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def commit(self, payload: dict, revision: int, role: str = "reviewer", actor: str = "alice"):
        return self.store.commit(
            "source-a", expected_revision=revision, action_id=payload["action_id"],
            request_digest=request_digest(payload), actor=actor, role=role,
            timestamp="2026-09-15T00:00:00+00:00",
            mutate=workflow_mutator(payload, actor=actor, role=role, blocking=True),
        )[0]

    def test_gap_requires_adjudication_and_blocks_finalization(self) -> None:
        with self.assertRaisesRegex(Exception, "require adjudication"):
            self.commit(
                {"action_id": "normal", "action": "submit", "source_checked": True, "review_outcome": "compositions_found"},
                0,
            )
        submitted = self.commit(
            {"action_id": "adjudicate", "action": "submit", "source_checked": True, "review_outcome": "needs_adjudication", "review_reason": "The source contains an unresolved image quality issue."},
            0,
        )
        with self.assertRaisesRegex(Exception, "requires adjudication"):
            self.commit({"action_id": "final", "action": "finalize"}, submitted["revision"], role="checker", actor="checker")

        corrected_quality = source_quality()
        corrected_quality["corrections"] = [{"start": 6, "end": 12, "evidence_text": "source"}]
        corrected = self.commit(
            {"action_id": "resolve", "action": "metadata", "reason": "Resolved missing images", "data": {"source_quality": corrected_quality}},
            submitted["revision"], role="checker", actor="checker",
        )
        finalized = self.commit(
            {"action_id": "final-after-resolution", "action": "finalize", "review_outcome": "no_compositions_found"},
            corrected["revision"], role="checker", actor="checker",
        )
        self.assertEqual(finalized["status"], "finalized")
        self.assertEqual(finalized["review_outcome"], "no_compositions_found")


if __name__ == "__main__":
    unittest.main()
