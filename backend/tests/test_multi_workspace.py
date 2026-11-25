import importlib
import json

from fastapi.testclient import TestClient

from backend.tests.test_review_workflow import ENV_KEYS, make_workspace


def test_workspace_catalog_and_explicit_routing(tmp_path, monkeypatch):
    for key in ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    claims = tmp_path / "claims"
    descriptions = tmp_path / "descriptions"
    make_workspace(claims)
    make_workspace(descriptions)
    monkeypatch.setenv("ANNOTATION_REVIEW_WORKSPACES_JSON", json.dumps([
        {"key": "patent-claims", "label": "Patent Claims", "source_kind": "patent_claim", "path": str(claims)},
        {"key": "patent-descriptions", "label": "Patent Descriptions", "source_kind": "patent_description", "path": str(descriptions)},
    ]))
    monkeypatch.setenv("ANNOTATION_USERS_JSON", json.dumps([{"username": "alice", "password": "pass"}]))
    from backend import main
    backend = importlib.reload(main)
    with TestClient(backend.app) as client:
        headers = {"Authorization": "Basic YWxpY2U6cGFzcw=="}
        catalog = client.get("/api/review/workspaces", headers=headers)
        assert catalog.status_code == 200
        assert [item["key"] for item in catalog.json()["workspaces"]] == ["patent-claims", "patent-descriptions"]
        queue = client.get("/api/review?workspace=patent-descriptions", headers=headers)
        assert queue.status_code == 200
        assert queue.json()["workspace_label"] == "Patent Descriptions"
        assert client.get("/api/review?workspace=missing", headers=headers).status_code == 404
