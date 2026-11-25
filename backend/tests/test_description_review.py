"""Description completion, legacy records, and unchanged claims guards."""
from copy import deepcopy
import io
import json
import zipfile

import pytest

from backend.composition_export import build_export_bundle
from backend.review_store import ReviewStore, request_digest
from backend.review_workflow import WorkflowError, apply_action
from backend.composition_schema import validate_composition, validate_record
from backend.tests.test_review_workflow import make_workspace


def description_workspace(root):
    make_workspace(root)
    for path in (root / "documents").glob("*.json"):
        doc = json.loads(path.read_text(encoding="utf-8"))
        doc["meta"]["section"] = "description"
        doc["baseline"]["meta"]["section"] = "description"
        for item in doc["compositions"]:
            item["data"].pop("claim_no", None)
        for item in doc["baseline"]["compositions"]:
            item.pop("claim_no", None)
        path.write_text(json.dumps(doc), encoding="utf-8")
    return ReviewStore(root)


def act(store, action, sid="source-a", **fields):
    doc = store.load_document(sid)
    payload = {"action": action, "action_id": f"{sid}-{doc['revision']}-{action}", **fields}
    return store.commit(sid, expected_revision=doc["revision"], action_id=payload["action_id"],
        request_digest=request_digest(payload), actor="admin", role="admin", timestamp="2026-11-20T00:00:00Z",
        mutate=lambda current, revision: apply_action(current, payload, actor="admin", role="admin",
            content="Alloy source claim", next_revision=revision,
            validate_record=validate_record, validate_composition=validate_composition))[0]


def test_completion_requires_review_and_source_check_then_explicit_unlock(tmp_path):
    store = description_workspace(tmp_path / "review")
    with pytest.raises(WorkflowError, match="Every seeded"):
        act(store, "mark_done", source_checked=True)
    act(store, "accept", composition_id="seed:1")
    with pytest.raises(WorkflowError, match="Source review"):
        act(store, "mark_done")
    done = act(store, "mark_done", source_checked=True)
    assert done["status"] == "finalized"
    assert done["review_outcome"] == "compositions_found"
    assert done["finalized_revision"] == done["revision"]
    assert done["events"][-1]["action"] == "mark_done"
    saved_bytes = (store.root / "documents/source-a.json").read_bytes()
    with pytest.raises(WorkflowError, match="Unlock to review"):
        act(store, "delete", composition_id="seed:1")
    assert (store.root / "documents/source-a.json").read_bytes() == saved_bytes
    unlocked = act(store, "reopen_review")
    assert unlocked["compositions"] == done["compositions"]
    assert unlocked["events"][:-1] == done["events"]
    opened = act(store, "delete", composition_id="seed:1")
    assert opened["status"] == "in_review" and not opened["source_checked"]
    assert opened["compositions"][0]["deleted"]
    assert opened["finalized_revision"] is None


def test_description_edits_deletes_and_help_do_not_require_routine_reasons(tmp_path):
    store = description_workspace(tmp_path / "review")
    changed = deepcopy(store.load_document("source-a")["compositions"][0]["data"])
    changed["composition_name"] = "Reviewed alloy"
    edited = act(store, "edit", composition_id="seed:1", data=changed)
    assert edited["events"][-1]["reason"] is None
    with pytest.raises(WorkflowError, match="Help note"):
        act(store, "request_help")
    help_doc = act(store, "request_help", review_reason="Source table is unreadable")
    assert help_doc["status"] == "in_review" and help_doc["review_outcome"] == "needs_adjudication"
    with pytest.raises(WorkflowError, match="Unlock to review"):
        act(store, "delete", composition_id="seed:1")
    unlocked = act(store, "reopen_review")
    assert unlocked["compositions"] == help_doc["compositions"]
    assert unlocked["review_outcome"] is None and unlocked["review_reason"] is None
    assert unlocked["events"][-2]["after"]["review_reason"] == "Source table is unreadable"
    deleted = act(store, "delete", composition_id="seed:1")
    assert deleted["compositions"][0]["deleted"]
    done = act(store, "mark_done", source_checked=True)
    assert done["review_outcome"] == "no_compositions_found" and done["review_reason"] is None


@pytest.mark.parametrize("status", ["submitted", "finalized"])
def test_assigned_reviewer_can_reopen_legacy_description_without_erasing_history(tmp_path, status):
    store = description_workspace(tmp_path / "review")
    original = store.load_document("source-a")
    original["status"] = status
    updated, _ = apply_action(deepcopy(original), {"action": "reopen_review"}, actor="alice", role="reviewer",
        content="Alloy source claim", next_revision=1, validate_record=validate_record, validate_composition=validate_composition)
    assert updated["status"] == "in_review"
    assert updated["compositions"] == original["compositions"]
    assert updated["events"] == original["events"]


@pytest.mark.parametrize("status,outcome", [("submitted", None), ("finalized", "compositions_found"), ("in_review", "needs_adjudication"), ("submitted", "needs_adjudication")])
@pytest.mark.parametrize("role", ["reviewer", "checker", "admin"])
def test_locked_descriptions_reject_every_mutation_until_explicit_unlock(tmp_path, status, outcome, role):
    store = description_workspace(tmp_path / "review")
    original = store.load_document("source-a")
    original.update(status=status, review_outcome=outcome, review_reason="Review needed" if outcome == "needs_adjudication" else None)
    snapshot = deepcopy(original)
    for action in ["accept", "edit", "delete", "add", "restore", "reverse", "metadata", "undo", "save_review", "submit", "mark_done", "request_help", "finalize", "return", "reopen", "admin_move_to_in_review"]:
        with pytest.raises(WorkflowError, match="Unlock to review") as error:
            apply_action(original, {"action": action}, actor="alice", role=role, content="Alloy source claim", next_revision=1, validate_record=validate_record, validate_composition=validate_composition)
        assert error.value.status_code == 409
        assert original == snapshot
    unlocked, _ = apply_action(deepcopy(original), {"action":"reopen_review"}, actor="alice", role=role, content="Alloy source claim", next_revision=1, validate_record=validate_record, validate_composition=validate_composition)
    assert unlocked["status"] == "in_review" and unlocked["review_outcome"] is None
    assert unlocked["compositions"] == original["compositions"] and unlocked["events"] == original["events"]


def test_claims_keep_reasons_and_reject_description_actions(tmp_path):
    make_workspace(tmp_path / "claims")
    store = ReviewStore(tmp_path / "claims")
    with pytest.raises(WorkflowError, match="Delete reason"):
        act(store, "delete", composition_id="seed:1")
    for action in ["mark_done", "request_help", "reopen_review"]:
        with pytest.raises(WorkflowError, match="only available for descriptions"):
            act(store, action)


def test_description_final_export_supports_new_and_legacy_completion_but_checks_current_approval(tmp_path):
    store = description_workspace(tmp_path / "review")
    act(store, "accept", composition_id="seed:1")
    act(store, "mark_done", source_checked=True)
    act(store, "accept", sid="source-b", composition_id="seed:1")
    # A previously submitted description remains complete without a data migration.
    act(store, "submit", sid="source-b", source_checked=True, review_outcome="compositions_found")
    docs, sources = store.snapshot(["source-a", "source-b"])
    data = build_export_bundle(store.manifest, docs, sources, actor="admin", mode="final")
    with zipfile.ZipFile(io.BytesIO(data)) as bundle:
        assert len(bundle.read("gold.jsonl").splitlines()) == 2
        assert b'mark_done' in bundle.read("audit.jsonl")
    docs[1]["events"][-1]["new_revision"] -= 1
    with pytest.raises(ValueError, match="approval event"):
        build_export_bundle(store.manifest, docs, sources, actor="admin", mode="final")


def test_unresolved_source_gaps_still_block_completion(tmp_path):
    store = description_workspace(tmp_path / "review")
    doc = store.load_document("source-a")
    doc["compositions"][0]["decision"] = "accepted"
    doc["source_quality"]["gaps"] = [{"kind": "missing_image", "start": 6, "end": 12, "evidence_text": "source"}]
    with pytest.raises(WorkflowError, match="source-quality gaps"):
        apply_action(doc, {"action": "mark_done", "source_checked": True}, actor="alice", role="reviewer",
            content="Alloy source claim", next_revision=1, validate_record=validate_record,
            validate_composition=validate_composition, blocking_source_ids=frozenset({"source-a"}))
