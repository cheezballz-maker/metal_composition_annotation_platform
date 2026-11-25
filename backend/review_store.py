from __future__ import annotations

import json
import os
import tempfile
from copy import deepcopy
from hashlib import sha256
from pathlib import Path
from threading import Lock, RLock
from typing import Callable, Iterable


class ReviewStoreError(Exception):
    def __init__(self, detail: str, status_code: int = 500):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


_LOCKS_GUARD = Lock()
_DOCUMENT_LOCKS: dict[str, RLock] = {}


def _document_lock(path: Path) -> RLock:
    key = str(path.resolve())
    with _LOCKS_GUARD:
        return _DOCUMENT_LOCKS.setdefault(key, RLock())


def _read_json(path: Path, label: str) -> dict | list:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ReviewStoreError(f"{label} is missing", 503) from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise ReviewStoreError(f"{label} is unreadable or invalid", 500) from exc


def write_json_atomic(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    temp_path = Path(temp_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)


class ReviewStore:
    def __init__(self, root: str | Path, *, writer: Callable[[Path, dict], None] = write_json_atomic):
        self.root = Path(root).expanduser().resolve()
        self.writer = writer
        self.manifest = self._load_manifest()

    def _load_manifest(self) -> dict:
        manifest = _read_json(self.root / "manifest.json", "Review workspace manifest")
        if not isinstance(manifest, dict):
            raise ReviewStoreError("Review workspace manifest must be an object")
        if manifest.get("schema_version") != "composition-review-v1":
            raise ReviewStoreError("Unsupported review workspace schema_version")
        if not isinstance(manifest.get("dataset_id"), str) or not manifest["dataset_id"]:
            raise ReviewStoreError("Review workspace dataset_id is missing")
        assignments = manifest.get("assignments")
        sources = manifest.get("sources")
        checkers = manifest.get("checkers")
        if not isinstance(assignments, dict) or not isinstance(sources, dict) or not isinstance(checkers, list):
            raise ReviewStoreError("Review workspace manifest assignments, sources, or checkers are invalid")
        if set(assignments) != set(sources):
            raise ReviewStoreError("Review workspace assignments and sources do not cover the same records")
        if any(not isinstance(source_id, str) or not source_id or Path(source_id).name != source_id for source_id in sources):
            raise ReviewStoreError("Review workspace has an unsafe source ID")
        if any(not isinstance(value, str) or not value for value in assignments.values()):
            raise ReviewStoreError("Review workspace has an invalid reviewer assignment")
        return manifest

    @property
    def dataset_id(self) -> str:
        return self.manifest["dataset_id"]

    @property
    def source_ids(self) -> list[str]:
        return list(self.manifest["sources"])

    def role_for(self, username: str) -> str | None:
        if username in self.manifest["checkers"]:
            return "admin" if username == "admin" else "checker"
        if username in self.manifest["assignments"].values():
            return "reviewer"
        return None

    def allowed_source_ids(self, username: str, role: str) -> list[str]:
        if role in {"checker", "admin"}:
            return self.source_ids
        return [source_id for source_id, reviewer in self.manifest["assignments"].items() if reviewer == username]

    def assert_access(self, source_id: str, username: str, role: str) -> None:
        if source_id not in self.manifest["sources"]:
            raise ReviewStoreError("Review record not found", 404)
        if role not in {"checker", "admin"} and self.manifest["assignments"].get(source_id) != username:
            # Do not reveal whether another reviewer's record exists.
            raise ReviewStoreError("Review record not found", 404)

    def _document_path(self, source_id: str) -> Path:
        if source_id not in self.manifest["sources"]:
            raise ReviewStoreError("Review record not found", 404)
        return self.root / "documents" / f"{source_id}.json"

    def _source_path(self, source_id: str) -> Path:
        source = self.manifest["sources"].get(source_id)
        if not isinstance(source, dict) or not isinstance(source.get("file"), str):
            raise ReviewStoreError("Review source mapping is invalid")
        path = (self.root / source["file"]).resolve()
        try:
            path.relative_to(self.root)
        except ValueError as exc:
            raise ReviewStoreError("Review source mapping escapes the workspace") from exc
        return path

    def load_document(self, source_id: str) -> dict:
        path = self._document_path(source_id)
        with _document_lock(path):
            return self._load_document_unlocked(source_id, path)

    def _load_document_unlocked(self, source_id: str, path: Path) -> dict:
        document = _read_json(path, f"Review document {source_id}")
        if not isinstance(document, dict):
            raise ReviewStoreError(f"Review document {source_id} must be an object")
        if document.get("dataset_id") != self.dataset_id or document.get("source_id") != source_id:
            raise ReviewStoreError(f"Review document {source_id} does not match its manifest")
        if document.get("reviewer") != self.manifest["assignments"].get(source_id):
            raise ReviewStoreError(f"Review document {source_id} has an inconsistent reviewer")
        if isinstance(document.get("revision"), bool) or not isinstance(document.get("revision"), int):
            raise ReviewStoreError(f"Review document {source_id} has an invalid revision")
        if not isinstance(document.get("events"), list) or not isinstance(document.get("compositions"), list):
            raise ReviewStoreError(f"Review document {source_id} has invalid state")
        return document

    def load_source(self, source_id: str) -> tuple[str, bytes]:
        mapping = self.manifest["sources"][source_id]
        path = self._source_path(source_id)
        try:
            raw_bytes = path.read_bytes()
            source_json = json.loads(raw_bytes.decode("utf-8"))
            array_item = mapping.get("array_item", 0)
            field = mapping.get("content_field", "content")
            value = source_json[array_item] if isinstance(source_json, list) else source_json
            content = value[field]
        except FileNotFoundError as exc:
            raise ReviewStoreError(f"Review source {source_id} is missing", 503) from exc
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, IndexError, KeyError, TypeError) as exc:
            raise ReviewStoreError(f"Review source {source_id} is unreadable or invalid") from exc
        if not isinstance(content, str):
            raise ReviewStoreError(f"Review source {source_id} content must be a string")
        if not isinstance(value, dict) or value.get("patent_id") != source_id:
            raise ReviewStoreError(f"Review source {source_id} patent_id mismatch")
        expected_hash = mapping.get("content_sha256")
        actual_hash = sha256(content.encode("utf-8")).hexdigest()
        if expected_hash and actual_hash != expected_hash:
            raise ReviewStoreError(f"Review source {source_id} content hash mismatch")
        expected_snapshot_hash = mapping.get("snapshot_sha256")
        if expected_snapshot_hash and sha256(raw_bytes).hexdigest() != expected_snapshot_hash:
            raise ReviewStoreError(f"Review source {source_id} snapshot hash mismatch")
        return content, raw_bytes

    def list_documents(self, source_ids: Iterable[str]) -> list[dict]:
        return [self.load_document(source_id) for source_id in source_ids]

    def commit(
        self,
        source_id: str,
        *,
        expected_revision: int,
        action_id: str,
        request_digest: str,
        actor: str,
        role: str,
        timestamp: str,
        mutate: Callable[[dict, int], tuple[dict, dict]],
    ) -> tuple[dict, bool]:
        if isinstance(expected_revision, bool) or not isinstance(expected_revision, int) or expected_revision < 0:
            raise ReviewStoreError("revision must be a non-negative integer", 422)
        if not isinstance(action_id, str) or not action_id.strip():
            raise ReviewStoreError("action_id is required", 422)
        action_id = action_id.strip()
        path = self._document_path(source_id)
        with _document_lock(path):
            current = self._load_document_unlocked(source_id, path)
            for event in current["events"]:
                if event.get("action_id") != action_id:
                    continue
                if event.get("request_digest") != request_digest or event.get("actor") != actor:
                    raise ReviewStoreError("action_id was already used for a different request", 409)
                return deepcopy(current), True
            if current["revision"] != expected_revision:
                raise ReviewStoreError(
                    f"Revision conflict: expected {expected_revision}, current {current['revision']}",
                    409,
                )

            previous_revision = current["revision"]
            next_revision = previous_revision + 1
            working, event = mutate(deepcopy(current), next_revision)
            working["revision"] = next_revision
            event.update(
                {
                    "action_id": action_id,
                    "request_digest": request_digest,
                    "timestamp": timestamp,
                    "actor": actor,
                    "role": role,
                    "dataset_id": self.dataset_id,
                    "source_id": source_id,
                    "previous_revision": previous_revision,
                    "new_revision": next_revision,
                }
            )
            working["events"] = [*current["events"], event]
            try:
                self.writer(path, working)
            except Exception as exc:
                raise ReviewStoreError("Review action could not be persisted") from exc
            return deepcopy(working), False

    def snapshot(self, source_ids: Iterable[str]) -> tuple[list[dict], dict[str, bytes]]:
        """Read documents and exact source snapshots while holding all document locks."""
        selected = list(source_ids)
        locks = [_document_lock(self._document_path(source_id)) for source_id in sorted(selected)]
        for lock in locks:
            lock.acquire()
        try:
            documents = [self._load_document_unlocked(source_id, self._document_path(source_id)) for source_id in selected]
            sources = {source_id: self.load_source(source_id)[1] for source_id in selected}
            return deepcopy(documents), sources
        finally:
            for lock in reversed(locks):
                lock.release()


def request_digest(payload: dict) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return sha256(encoded).hexdigest()
