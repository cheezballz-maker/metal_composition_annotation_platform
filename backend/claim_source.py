from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class ClaimSource:
    path: Path
    raw_bytes: bytes
    item: dict[str, Any]
    source_id: str
    content: str
    file_sha256: str
    content_sha256: str


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_text(value: str) -> str:
    return sha256_bytes(value.encode("utf-8"))


def load_claim_source(path: Path, expected_source_id: str | None = None) -> ClaimSource:
    source_path = Path(path)
    raw_bytes = source_path.read_bytes()
    try:
        payload = json.loads(raw_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"invalid UTF-8 JSON source: {source_path}") from exc
    if not isinstance(payload, list) or len(payload) != 1 or not isinstance(payload[0], dict):
        raise ValueError(f"source must be a one-item JSON object array: {source_path}")
    item = payload[0]
    source_id = item.get("patent_id")
    content = item.get("content")
    if not isinstance(source_id, str) or not source_id:
        raise ValueError(f"source patent_id must be a non-empty string: {source_path}")
    if not isinstance(content, str):
        raise ValueError(f"source content must be a string: {source_path}")
    if expected_source_id is not None and source_id != expected_source_id:
        raise ValueError(f"source ID mismatch for {source_path}: expected {expected_source_id}, got {source_id}")
    return ClaimSource(
        path=source_path,
        raw_bytes=raw_bytes,
        item=item,
        source_id=source_id,
        content=content,
        file_sha256=sha256_bytes(raw_bytes),
        content_sha256=sha256_text(content),
    )
