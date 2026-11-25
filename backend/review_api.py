from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .composition_export import build_export_bundle, summarize_document
from .composition_schema import validate_composition, validate_record
from .review_store import ReviewStore, ReviewStoreError, request_digest
from .review_workflow import WorkflowError, apply_action, has_blocking_source_gaps


router = APIRouter(prefix="/api/review", tags=["composition review"])


class ReviewAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action_id: Annotated[str, Field(min_length=1, max_length=200)]
    revision: Annotated[int, Field(strict=True, ge=0)]
    action: Literal[
        "accept", "edit", "delete", "add", "restore", "reverse", "metadata", "save_review",
        "submit", "return", "finalize", "reopen", "admin_move_to_in_review",
        "mark_done", "request_help", "reopen_review", "undo",
    ]
    composition_id: str | None = None
    data: dict[str, Any] | None = None
    reason: str | None = None
    source_checked: bool | None = None
    review_outcome: Literal["compositions_found", "no_compositions_found", "needs_adjudication"] | None = None
    review_reason: str | None = None

    @field_validator("action_id")
    @classmethod
    def clean_action_id(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("action_id is required")
        return value


@dataclass(frozen=True)
class WorkspaceConfig:
    key: str
    label: str
    source_kind: str
    path: Path


def _workspace_configs() -> dict[str, WorkspaceConfig]:
    raw = os.getenv("ANNOTATION_REVIEW_WORKSPACES_JSON", "").strip()
    if raw:
        try:
            configured = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=503, detail="Review workspace configuration is invalid") from exc
        entries = list(configured.values()) if isinstance(configured, dict) else configured
        if not isinstance(entries, list):
            raise HTTPException(status_code=503, detail="Review workspace configuration must be a list or object")
        result: dict[str, WorkspaceConfig] = {}
        for entry in entries:
            if not isinstance(entry, dict):
                raise HTTPException(status_code=503, detail="Review workspace entry is invalid")
            key = str(entry.get("key", "")).strip()
            label = str(entry.get("label", "")).strip()
            source_kind = str(entry.get("source_kind", "")).strip()
            path = str(entry.get("path", "")).strip()
            if not re.fullmatch(r"[a-z0-9-]+", key) or not label or not source_kind or not path or key in result:
                raise HTTPException(status_code=503, detail="Review workspace entry is incomplete or duplicated")
            result[key] = WorkspaceConfig(key, label, source_kind, Path(path).expanduser().resolve())
        return result
    configured = os.getenv("ANNOTATION_REVIEW_WORKSPACE", "").strip()
    if not configured:
        return {}
    return {"default": WorkspaceConfig("default", "Composition review", "patent_claim", Path(configured).expanduser().resolve())}


def _store(workspace: str | None = None, required: bool = True) -> tuple[ReviewStore, WorkspaceConfig] | None:
    configs = _workspace_configs()
    if not configs:
        if required:
            raise HTTPException(status_code=404, detail="Composition review is not enabled")
        return None
    if workspace is None:
        config = next(iter(configs.values()))
    else:
        config = configs.get(workspace)
        if config is None:
            raise HTTPException(status_code=404, detail="Review workspace not found")
    try:
        return ReviewStore(config.path), config
    except ReviewStoreError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


def _identity(request: Request, store: ReviewStore) -> tuple[str, str]:
    user = getattr(request.state, "annotation_user", None)
    username = getattr(user, "username", None)
    if not isinstance(username, str) or not username:
        raise HTTPException(status_code=401, detail="Authenticated review identity required")
    role = store.role_for(username)
    if role is None:
        raise HTTPException(status_code=403, detail="User is not assigned to this review dataset")
    return username, role


def _call_store(function):
    try:
        return function()
    except ReviewStoreError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    except WorkflowError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _blocking_source_ids(store: ReviewStore) -> frozenset[str]:
    import_validation = store.manifest.get("import_validation", {})
    blockers = import_validation.get("negative_review_blockers", {}) if isinstance(import_validation, dict) else {}
    return frozenset(blockers) if isinstance(blockers, dict) else frozenset()


def review_summary(document: dict, blocking_source_ids: frozenset[str] = frozenset()) -> dict:
    metrics = summarize_document(document)
    compositions = document.get("compositions", [])
    decisions: dict[str, int] = {}
    for item in compositions:
        decision = item.get("decision", "pending")
        decisions[decision] = decisions.get(decision, 0) + 1
    source_quality = document.get("source_quality", {})
    gaps = source_quality.get("gaps", []) if isinstance(source_quality, dict) else []
    warning_labels: list[str] = []
    if source_quality.get("text_quality") == "loss":
        warning_labels.append("ocr_issue")
    if gaps:
        warning_labels.append("source_gap")
    relation_kinds = {
        str(relation.get("kind", "")).lower()
        for item in compositions
        for relation in item.get("data", {}).get("unrepresented_relations", [])
        if isinstance(relation, dict)
    }
    if any("ambig" in kind for kind in relation_kinds):
        warning_labels.append("ambiguous")
    return {
        "source_id": document["source_id"],
        "reviewer": document["reviewer"],
        "status": document["status"],
        "revision": document["revision"],
        "seeded_composition_count": sum(item.get("origin") == "seed" for item in compositions),
        "retained_composition_count": metrics["mention_count"],
        "unique_composition_count": metrics["unique_composition_count"],
        "pending_count": metrics["pending_count"],
        "canonical_groups": metrics["canonical_groups"],
        "ambiguous_candidate_groups": metrics["ambiguous_candidate_groups"],
        "decisions": decisions,
        "source_checked": document.get("source_checked", False),
        "review_outcome": document.get("review_outcome"),
        "review_reason": document.get("review_reason"),
        "has_source_gaps": bool(gaps),
        "has_blocking_source_gaps": has_blocking_source_gaps(document, blocking_source_ids),
        "warning_labels": warning_labels,
    }


def _workflow_flags(document: dict, blocking_source_ids: frozenset[str]) -> dict:
    return {
        "has_source_gaps": bool(document.get("source_quality", {}).get("gaps", [])),
        "has_blocking_source_gaps": has_blocking_source_gaps(document, blocking_source_ids),
    }


def _response_document(document: dict, blocking_source_ids: frozenset[str]) -> dict:
    return {**document, "workflow": _workflow_flags(document, blocking_source_ids)}


@router.get("/workspaces")
def get_review_workspaces(request: Request) -> dict:
    configs = _workspace_configs()
    workspaces = []
    for config in configs.values():
        try:
            store = ReviewStore(config.path)
            username, role = _identity(request, store)
        except HTTPException as exc:
            if exc.status_code == 403:
                continue
            raise
        except ReviewStoreError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
        workspaces.append({
            "key": config.key,
            "label": config.label,
            "source_kind": config.source_kind,
            "dataset_id": store.dataset_id,
            "role": role,
            "record_count": len(store.allowed_source_ids(username, role)),
        })
    return {"enabled": bool(configs), "username": getattr(getattr(request.state, "annotation_user", None), "username", None), "workspaces": workspaces}


@router.get("")
def get_review_queue(request: Request, workspace: str | None = Query(default=None)) -> dict:
    selected = _store(workspace, required=False)
    if selected is None:
        return {"enabled": False, "dataset_id": None, "role": None, "username": None, "records": []}
    store, config = selected
    username, role = _identity(request, store)
    source_ids = store.allowed_source_ids(username, role)
    documents = _call_store(lambda: store.list_documents(source_ids))
    return {
        "enabled": True,
        "dataset_id": store.dataset_id,
        "role": role,
        "username": username,
        "workspace_key": config.key,
        "workspace_label": config.label,
        "source_kind": config.source_kind,
        "records": [review_summary(document, _blocking_source_ids(store)) for document in documents],
    }


@router.get("/records/{source_id}")
def get_review_record(source_id: str, request: Request, workspace: str | None = Query(default=None)) -> dict:
    selected = _store(workspace)
    assert selected is not None
    store, _ = selected
    username, role = _identity(request, store)
    _call_store(lambda: store.assert_access(source_id, username, role))
    document = _call_store(lambda: store.load_document(source_id))
    content, _ = _call_store(lambda: store.load_source(source_id))
    return {
        "document": _response_document(document, _blocking_source_ids(store)),
        "content": content,
        "source": store.manifest["sources"][source_id],
        "workflow": _workflow_flags(document, _blocking_source_ids(store)),
    }


@router.post("/records/{source_id}/actions")
def post_review_action(source_id: str, payload: ReviewAction, request: Request, workspace: str | None = Query(default=None)) -> dict:
    selected = _store(workspace)
    assert selected is not None
    store, _ = selected
    username, role = _identity(request, store)
    _call_store(lambda: store.assert_access(source_id, username, role))
    content, _ = _call_store(lambda: store.load_source(source_id))
    raw_payload = payload.model_dump(mode="json")
    digest = request_digest(raw_payload)
    blocking_source_ids = _blocking_source_ids(store)

    def commit():
        return store.commit(
            source_id,
            expected_revision=payload.revision,
            action_id=payload.action_id,
            request_digest=digest,
            actor=username,
            role=role,
            timestamp=datetime.now(timezone.utc).isoformat(),
            mutate=lambda document, next_revision: apply_action(
                document,
                raw_payload,
                actor=username,
                role=role,
                content=content,
                next_revision=next_revision,
                validate_record=validate_record,
                validate_composition=validate_composition,
                blocking_source_ids=blocking_source_ids,
            ),
        )

    document, idempotent = _call_store(commit)
    return {
        "document": _response_document(document, blocking_source_ids),
        "idempotent": idempotent,
    }


@router.get("/export")
def export_review_workspace(
    request: Request,
    mode: Literal["progress", "final"] = Query(default="progress"),
    workspace: str | None = Query(default=None),
) -> Response:
    selected = _store(workspace)
    assert selected is not None
    store, _ = selected
    username, role = _identity(request, store)
    if mode == "final" and role not in {"checker", "admin"}:
        raise HTTPException(status_code=403, detail="Only a checker can create the final export")
    source_ids = store.allowed_source_ids(username, role)
    documents, sources = _call_store(lambda: store.snapshot(source_ids))
    try:
        bundle = build_export_bundle(store.manifest, documents, sources, actor=username, mode=mode)
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    filename = f"{store.dataset_id}-{mode}.zip"
    return Response(
        content=bundle,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
