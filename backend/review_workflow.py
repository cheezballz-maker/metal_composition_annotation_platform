from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
import re
from typing import Any, Callable
from .description_schema import inherited_references, lean_inheritance, clean_description_composition


CONTENT_ACTIONS = {"accept", "edit", "delete", "add", "restore", "reverse", "metadata"}
REVIEW_OUTCOMES = {"compositions_found", "no_compositions_found", "needs_adjudication"}


def is_description(document: dict) -> bool:
    meta = document.get("meta", {})
    return meta.get("section") == "description" or meta.get("source_type") == "patent_description"


def description_done(document: dict) -> bool:
    return is_description(document) and document.get("status") in {"submitted", "finalized"} and document.get("review_outcome") != "needs_adjudication"


def description_locked(document: dict) -> bool:
    return is_description(document) and (document.get("status") in {"submitted", "finalized"} or document.get("review_outcome") == "needs_adjudication")


@dataclass
class WorkflowError(Exception):
    detail: str
    status_code: int = 422

    def __str__(self) -> str:
        return self.detail


def _required_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise WorkflowError(f"{label} is required")
    return value.strip()


def _composition(document: dict, composition_id: Any) -> dict:
    if not isinstance(composition_id, str) or not composition_id:
        raise WorkflowError("composition_id is required")
    for composition in document.get("compositions", []):
        if composition.get("id") == composition_id:
            return composition
    raise WorkflowError("Composition not found", 404)


def _unresolved_gaps(document: dict) -> list:
    source_quality = document.get("source_quality")
    gaps = source_quality.get("gaps", []) if isinstance(source_quality, dict) else []
    return gaps if isinstance(gaps, list) else []


def _retained(document: dict) -> list[dict]:
    return [item for item in document.get("compositions", []) if not item.get("deleted", False)]


def _blocking_gaps(document: dict, blocking_source_ids: frozenset[str]) -> list:
    gaps = _unresolved_gaps(document)
    if document.get("source_id") in blocking_source_ids:
        return gaps
    blocking = []
    for gap in gaps:
        if not isinstance(gap, dict):
            continue
        description = " ".join(str(gap.get(key, "")) for key in ("kind", "type", "status", "reason", "description"))
        evidence = str(gap.get("evidence_text", ""))
        if re.search(r"\b(missing|unavailable|unreadable)\b", description, re.I) or re.search(
            r"<img\b[^>]*\bsrc\s*=\s*(['\"])?\s*\1", evidence, re.I
        ):
            blocking.append(gap)
    return blocking


def has_blocking_source_gaps(document: dict, blocking_source_ids: frozenset[str] = frozenset()) -> bool:
    return bool(_blocking_gaps(document, blocking_source_ids))


def _validate_outcome(document: dict, blocking_source_ids: frozenset[str]) -> None:
    if document.get("source_checked") is not True:
        raise WorkflowError("Source review acknowledgment is required")
    pending = [item for item in document.get("compositions", []) if item.get("origin") == "seed" and item.get("decision") == "pending"]
    if pending:
        raise WorkflowError("Every seeded composition requires a decision")
    outcome = document.get("review_outcome")
    if outcome not in REVIEW_OUTCOMES:
        raise WorkflowError("A valid review_outcome is required")
    retained = _retained(document)
    if _blocking_gaps(document, blocking_source_ids) and outcome != "needs_adjudication":
        raise WorkflowError("Unresolved source-quality gaps require adjudication")
    if outcome == "needs_adjudication" and not isinstance(document.get("review_reason"), str):
        raise WorkflowError("needs_adjudication requires a reason")
    if outcome == "needs_adjudication" and not document["review_reason"].strip():
        raise WorkflowError("needs_adjudication requires a reason")
    if retained and outcome == "no_compositions_found":
        raise WorkflowError("A retained composition conflicts with no_compositions_found")
    if not retained and outcome == "compositions_found":
        raise WorkflowError("compositions_found requires a retained composition")


def validate_final_review(document: dict, blocking_source_ids: frozenset[str] = frozenset()) -> None:
    """Validate workflow facts that must hold for a normal final approval."""
    _validate_outcome(document, blocking_source_ids)
    if document.get("review_outcome") == "needs_adjudication":
        raise WorkflowError("Record still requires adjudication before finalization")


def _validate_document(
    document: dict,
    content: str,
    validate_record: Callable[[dict, str], dict],
    validate_composition: Callable[..., dict],
) -> None:
    meta = document.get("meta", {})
    require_claim = meta.get("section") == "claim" or meta.get("source_type") == "patent_claim"
    validated_compositions = []
    seen_ids: set[str] = set()
    for item in document.get("compositions", []):
        internal_id = item.get("id")
        if not isinstance(internal_id, str) or not internal_id or internal_id in seen_ids:
            raise WorkflowError("Composition IDs must be non-empty and unique")
        seen_ids.add(internal_id)
        require_evidence = item.get("origin") == "added" and not item.get("deleted", False)
        item["data"] = validate_composition(
            item.get("data"), content, require_evidence=require_evidence, require_claim=require_claim, require_constraint_evidence=not is_description(document),
            inherited_names=inherited_references(item.get("data", {}), [c["data"] for c in document.get("compositions", [])]) if meta.get("section") == "description" else None,
        )
        if meta.get("section") != "description" or not item.get("deleted"):
            validated_compositions.append(item["data"])

    record = {
        "meta": deepcopy(document.get("meta", {})),
        "source_quality": deepcopy(document.get("source_quality", {})),
        "compositions": validated_compositions,
    }
    validated = validate_record(record, content)
    if meta.get("section") == "description" and any(
        any(isinstance(r, dict) and r.get("kind") == "inherits_from" for r in item["data"].get("unrepresented_relations", []))
        for item in document.get("compositions", [])
    ):
        for item in document.get("compositions", []):
            item["data"] = lean_inheritance(item["data"])
        # Validate the lean result too, including legacy snapshots restored by Undo.
        validate_record({**record, "compositions": [i["data"] for i in document["compositions"] if not i.get("deleted")]}, content)
    document["meta"] = validated.get("meta", record["meta"])
    document["source_quality"] = validated.get("source_quality", record["source_quality"])


def _assert_content_write_allowed(document: dict, role: str) -> None:
    status = document.get("status")
    if role == "reviewer":
        allowed = {"not_started", "in_review", "returned"}
        if status not in allowed:
            raise WorkflowError("This record is read-only for its reviewer", 409)
        return
    if role in {"checker", "admin"}:
        if status == "finalized" and not is_description(document):
            raise WorkflowError("Reopen the finalized record before changing it", 409)
        return
    raise WorkflowError("Review access is required", 403)


def apply_action(
    document: dict,
    payload: dict,
    *,
    actor: str,
    role: str,
    content: str,
    next_revision: int,
    validate_record: Callable[[dict, str], dict],
    validate_composition: Callable[..., dict],
    blocking_source_ids: frozenset[str] = frozenset(),
) -> tuple[dict, dict]:
    """Apply one already-authorized action to a copied review document.

    The returned event intentionally contains only raw-coordinate annotation state.
    Actor, time, revisions, and request identity are added by the store.
    """

    action = payload.get("action")
    if action not in CONTENT_ACTIONS | {"save_review", "submit", "return", "finalize", "reopen", "admin_move_to_in_review", "mark_done", "request_help", "reopen_review", "undo"}:
        raise WorkflowError("Unsupported review action")

    if description_locked(document) and action != "reopen_review":
        raise WorkflowError("Select Unlock to review before changing this finalized or flagged document", 409)

    before_document = deepcopy(document)
    reason = payload.get("reason")
    target_id = payload.get("composition_id")

    if action in CONTENT_ACTIONS or action == "undo":
        _assert_content_write_allowed(document, role)

    if action == "undo":
        if not is_description(document):
            raise WorkflowError("Undo is only available for descriptions", 422)
        undone = {event.get("undoes_action_id") for event in document.get("events", []) if event.get("action") == "undo"}
        target_event = next((event for event in reversed(document.get("events", []))
                             if event.get("action") in {"accept", "edit", "delete", "add", "restore", "reverse"}
                             and event.get("action_id") not in undone
                             and event.get("composition_id")
                             and isinstance(event.get("before"), dict)
                             and "composition" in event["before"]), None)
        if target_event is None:
            raise WorkflowError("There is no saved composition change to undo", 409)
        target_id = target_event["composition_id"]
        before_item = target_event["before"].get("composition")
        current_index = next((i for i, item in enumerate(document.get("compositions", [])) if item.get("id") == target_id), None)
        if before_item is None:
            if current_index is None:
                raise WorkflowError("The composition has changed since this action", 409)
            document["compositions"].pop(current_index)
        elif current_index is None:
            raise WorkflowError("The composition has changed since this action", 409)
        else:
            document["compositions"][current_index] = deepcopy(before_item)
            document["compositions"][current_index]["data"] = clean_description_composition(before_item["data"])
        document["status"] = "in_review"
        document["source_checked"] = False
        document["review_outcome"] = None
        document["review_reason"] = None
        document["finalized_revision"] = None
        _validate_document(document, content, validate_record, validate_composition)

    if action in {"mark_done", "request_help", "reopen_review"}:
        if not is_description(document):
            raise WorkflowError("This action is only available for descriptions", 422)
        if role not in {"reviewer", "checker", "admin"}:
            raise WorkflowError("Review access is required", 403)
        if action == "reopen_review":
            if not description_locked(document):
                raise WorkflowError("Only a finalized or flagged document can be unlocked", 409)
            document["status"] = "in_review"
            document["source_checked"] = False
            document["review_outcome"] = None
            document["review_reason"] = None
            document["finalized_revision"] = None
        else:
            _assert_content_write_allowed(document, role)
            if action == "request_help":
                document["review_reason"] = _required_text(payload.get("review_reason"), "Help note")
                document["review_outcome"] = "needs_adjudication"
                document["status"] = "in_review"
                document["finalized_revision"] = None
            else:
                document["source_checked"] = payload.get("source_checked") is True
                document["review_outcome"] = "compositions_found" if _retained(document) else "no_compositions_found"
                document["review_reason"] = None
                _validate_document(document, content, validate_record, validate_composition)
                validate_final_review(document, blocking_source_ids)
                document["status"] = "finalized"
                document["finalized_revision"] = next_revision

    elif action == "accept":
        item = _composition(document, target_id)
        if item.get("deleted"):
            raise WorkflowError("Restore the composition before accepting it", 409)
        if item.get("decision") == "accepted":
            raise WorkflowError("Composition is already accepted", 409)
        item["decision"] = "accepted"

    elif action == "edit":
        reason = (reason.strip() if isinstance(reason, str) and reason.strip() else None) if is_description(document) else _required_text(reason, "Edit reason")
        item = _composition(document, target_id)
        if item.get("deleted"):
            raise WorkflowError("Restore the composition before editing it", 409)
        meta = document.get("meta", {})
        updated_data = validate_composition(
            payload.get("data"), content,
            require_evidence=item.get("origin") == "added",
            require_claim=meta.get("section") == "claim" or meta.get("source_type") == "patent_claim", require_constraint_evidence=not is_description(document),
            inherited_names=inherited_references(payload.get("data", {}), [c["data"] for c in document.get("compositions", [])]) if meta.get("section") == "description" else None,
        )
        if updated_data.get("node_no") != item.get("data", {}).get("node_no"):
            raise WorkflowError("composition.node_no cannot be changed")
        if updated_data == item.get("data"):
            raise WorkflowError("Edit does not change the composition", 409)
        item["data"] = updated_data
        item["decision"] = "edited"

    elif action == "delete":
        reason = (reason.strip() if isinstance(reason, str) and reason.strip() else None) if is_description(document) else _required_text(reason, "Delete reason")
        item = _composition(document, target_id)
        if item.get("deleted"):
            raise WorkflowError("Composition is already deleted", 409)
        item["deleted"] = True
        item["decision"] = "deleted"

    elif action == "add":
        data = deepcopy(payload.get("data"))
        if not isinstance(data, dict):
            raise WorkflowError("Composition data must be an object")
        current_node_numbers = [
            item.get("data", {}).get("node_no") for item in document.get("compositions", [])
            if isinstance(item.get("data", {}).get("node_no"), int)
            and not isinstance(item.get("data", {}).get("node_no"), bool)
        ]
        data["node_no"] = max(current_node_numbers, default=0) + 1
        data.setdefault("constituents", [])
        data.setdefault("constraints", [])
        data.setdefault("evidence_spans", [])
        data.setdefault("unrepresented_relations", [])
        meta = document.get("meta", {})
        data = validate_composition(
            data, content, require_evidence=True,
            require_claim=meta.get("section") == "claim" or meta.get("source_type") == "patent_claim", require_constraint_evidence=not is_description(document),
            inherited_names=inherited_references(data, [c["data"] for c in document.get("compositions", [])]) if meta.get("section") == "description" else None,
        )
        internal_id = f"added:{payload['action_id']}"
        if any(item.get("id") == internal_id for item in document.get("compositions", [])):
            raise WorkflowError("Composition ID already exists", 409)
        document.setdefault("compositions", []).append(
            {
                "id": internal_id,
                "seed_node_no": None,
                "origin": "added",
                "creator": actor,
                "decision": "added",
                "deleted": False,
                "data": data,
            }
        )
        target_id = internal_id

    elif action == "restore":
        item = _composition(document, target_id)
        if not item.get("deleted"):
            raise WorkflowError("Composition is not deleted", 409)
        item["deleted"] = False
        item["decision"] = "pending" if item.get("origin") == "seed" else "added"

    elif action == "reverse":
        item = _composition(document, target_id)
        if item.get("deleted"):
            raise WorkflowError("Restore the composition before reversing its decision", 409)
        if item.get("origin") != "seed":
            raise WorkflowError("Only seeded composition decisions can be reversed")
        if item.get("decision") == "pending":
            raise WorkflowError("Composition decision is already pending", 409)
        item["decision"] = "pending"

    elif action == "metadata":
        reason = _required_text(reason, "Metadata change reason")
        data = payload.get("data")
        if not isinstance(data, dict) or not data or any(key not in {"meta", "source_quality"} for key in data):
            raise WorkflowError("Metadata data must contain meta and/or source_quality")
        for key in ("meta", "source_quality"):
            if key in data:
                if not isinstance(data[key], dict):
                    raise WorkflowError(f"{key} must be an object")
                document[key] = deepcopy(data[key])
        original_meta = before_document.get("meta", {})
        for key in ("source_id", "source_type", "section"):
            if document.get("meta", {}).get(key) != original_meta.get(key):
                raise WorkflowError(f"record.meta.{key} cannot be changed")
        if all(document.get(key) == before_document.get(key) for key in ("meta", "source_quality")):
            raise WorkflowError("Metadata action does not change the record", 409)

    elif action == "save_review":
        if role not in {"reviewer", "checker", "admin"}:
            raise WorkflowError("Review access is required", 403)
        if document.get("status") == "finalized":
            raise WorkflowError("Reopen the finalized record before changing it", 409)
        if payload.get("source_checked") is not True:
            raise WorkflowError("Source review acknowledgment is required")
        outcome = payload.get("review_outcome")
        if outcome not in REVIEW_OUTCOMES:
            raise WorkflowError("A valid review_outcome is required")
        review_reason = payload.get("review_reason")
        if outcome == "needs_adjudication" and (not isinstance(review_reason, str) or not review_reason.strip()):
            raise WorkflowError("needs_adjudication requires a reason")
        document["source_checked"] = True
        document["review_outcome"] = outcome
        document["review_reason"] = review_reason.strip() if isinstance(review_reason, str) and review_reason.strip() else None
        if document.get("status") == "not_started":
            document["status"] = "in_review"

    elif action == "submit":
        if role not in {"reviewer", "admin"}:
            raise WorkflowError("Only the assigned reviewer can submit a record", 403)
        if document.get("status") not in {"not_started", "in_review", "returned"}:
            raise WorkflowError("Record cannot be submitted from its current status", 409)
        outcome = payload.get("review_outcome")
        document["source_checked"] = payload.get("source_checked")
        document["review_outcome"] = outcome
        review_reason = payload.get("review_reason")
        document["review_reason"] = review_reason.strip() if isinstance(review_reason, str) and review_reason.strip() else None
        _validate_document(document, content, validate_record, validate_composition)
        _validate_outcome(document, blocking_source_ids)
        document["status"] = "submitted"

    elif action == "return":
        if role not in {"checker", "admin"}:
            raise WorkflowError("Only a checker can return a record", 403)
        if document.get("status") != "submitted":
            raise WorkflowError("Only a submitted record can be returned", 409)
        reason = _required_text(reason, "Return reason")
        document["status"] = "returned"

    elif action == "admin_move_to_in_review":
        if role != "admin":
            raise WorkflowError("Only an admin can move a record to in review", 403)
        if document.get("status") not in {"not_started", "submitted", "returned"}:
            raise WorkflowError("Record cannot be moved to in review from its current status", 409)
        reason = _required_text(reason, "Status change reason")
        document["status"] = "in_review"
        document["finalized_revision"] = None

    elif action == "finalize":
        if role not in {"checker", "admin"}:
            raise WorkflowError("Only a checker can finalize a record", 403)
        allowed_statuses = {"not_started", "in_review", "returned", "submitted"} if role == "admin" else {"submitted"}
        if document.get("status") not in allowed_statuses:
            raise WorkflowError("Only a submitted record can be finalized", 409)
        if payload.get("source_checked") is not None:
            document["source_checked"] = payload["source_checked"]
        if payload.get("review_outcome") is not None:
            document["review_outcome"] = payload["review_outcome"]
        if payload.get("review_reason") is not None:
            document["review_reason"] = payload["review_reason"].strip() or None
        _validate_document(document, content, validate_record, validate_composition)
        validate_final_review(document, blocking_source_ids)
        document["status"] = "finalized"
        document["finalized_revision"] = next_revision

    elif action == "reopen":
        if role not in {"checker", "admin"}:
            raise WorkflowError("Only a checker can reopen a record", 403)
        if document.get("status") != "finalized":
            raise WorkflowError("Only a finalized record can be reopened", 409)
        reason = _required_text(reason, "Reopen reason")
        document["status"] = "submitted"
        document["finalized_revision"] = None

    if action in CONTENT_ACTIONS:
        _validate_document(document, content, validate_record, validate_composition)
        if document.get("status") in {"not_started", "returned"}:
            document["status"] = "in_review"
        document["finalized_revision"] = None

    event = {
        "action": action,
        "composition_id": target_id,
        "reason": reason.strip() if isinstance(reason, str) and reason.strip() else None,
        "before": _event_snapshot(before_document, action, target_id),
        "after": _event_snapshot(document, action, target_id),
    }
    if action == "undo":
        event["undoes_action_id"] = target_event["action_id"]
    return document, event


def _event_snapshot(document: dict, action: str, composition_id: str | None) -> dict:
    workflow = {
        "status": document.get("status"),
        "source_checked": document.get("source_checked"),
        "review_outcome": document.get("review_outcome"),
        "review_reason": document.get("review_reason"),
        "finalized_revision": document.get("finalized_revision"),
    }
    if action in {"accept", "edit", "delete", "add", "restore", "reverse", "undo"} and composition_id:
        item = next((item for item in document.get("compositions", []) if item.get("id") == composition_id), None)
        return {**workflow, "composition": deepcopy(item) if item is not None else None}
    if action == "metadata":
        return {
            **workflow,
            "meta": deepcopy(document.get("meta", {})),
            "source_quality": deepcopy(document.get("source_quality", {})),
        }
    return workflow
