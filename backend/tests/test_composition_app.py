"""Regression coverage for the composition-only application shell and auth."""
import importlib
import json

import pytest
from fastapi.testclient import TestClient

from backend.tests.test_review_workflow import ENV_KEYS, make_workspace


@pytest.fixture
def app_client(tmp_path, monkeypatch):
    for key in ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    review = tmp_path / "review"
    make_workspace(review)
    legacy = tmp_path / "legacy"
    legacy.mkdir()
    retained = legacy / "retained.txt"
    retained.write_text("preserve archived annotation data")
    monkeypatch.setenv("ANNOTATION_REVIEW_WORKSPACE", str(review))
    monkeypatch.setenv("ANNOTATION_WORKSPACE_PATH", str(legacy))
    monkeypatch.setenv("ANNOTATION_SEED_WORKSPACE", "1")
    monkeypatch.setenv("ANNOTATION_USERS_JSON", json.dumps([
        {"username": "alice", "password": "test-pass"},
        {"username": "checker", "password": "test-pass"},
        {"username": "outsider", "password": "test-pass", "document_globs": ["*"]},
    ]))
    monkeypatch.setenv("ANNOTATION_SESSION_SECRET", "test-secret-" * 4)
    from backend import main
    backend = importlib.reload(main)
    with TestClient(backend.app) as client:
        yield client, backend
    assert retained.read_text() == "preserve archived annotation data"
    assert list(legacy.iterdir()) == [retained]


def sign_in(client, username="alice", **kwargs):
    return client.post("/api/auth/login", json={"username": username, "password": "test-pass"}, **kwargs)


def test_session_login_review_roles_and_logout(app_client):
    client, _ = app_client
    assert client.get("/api/review").status_code == 401
    assert client.post("/api/auth/login", json={"username": "alice", "password": "wrong"}).status_code == 401
    response = sign_in(client)
    assert response.status_code == 200
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie
    assert client.get("/api/auth/session").json()["username"] == "alice"
    queue = client.get("/api/review").json()
    assert [item["source_id"] for item in queue["records"]] == ["source-a"]
    assert client.get("/api/review/records/source-b").status_code == 404
    assert client.post("/api/auth/logout").status_code == 200
    assert client.get("/api/review").status_code == 401
    sign_in(client, "checker")
    assert len(client.get("/api/review").json()["records"]) == 2
    sign_in(client, "outsider")
    assert client.get("/api/review").status_code == 403


def test_legacy_endpoints_are_removed_without_touching_data(app_client):
    client, backend = app_client
    sign_in(client, "checker")
    assert not any(path.startswith("/api/workspace") for path in backend.app.openapi()["paths"])
    for method, path in [
        ("GET", "/api/workspace"), ("GET", "/api/workspace/files"),
        ("POST", "/api/workspace/open"), ("POST", "/api/workspace/pick-folder"),
        ("GET", "/api/workspace/files/retained.txt"),
        ("POST", "/api/workspace/files/retained.txt/annotations"),
        ("POST", "/api/workspace/files/retained.txt/export"),
        ("GET", "/api/workspace/edit-logs/retained.txt"),
    ]:
        assert client.request(method, path, json={}).status_code == 404
    assert client.get("/api/health").json() == {
        "status": "ok", "workflow": "composition-review", "review_enabled": True,
    }
    assert client.head("/api/health").status_code == 200


def test_cookie_security_tampering_and_expiration(app_client, monkeypatch):
    client, backend = app_client
    assert "Secure" in sign_in(client, headers={"X-Forwarded-Proto": "https"}).headers["set-cookie"]
    client.cookies.clear()
    sign_in(client)
    token = client.cookies.get("annotation_session")
    assert backend.decode_session(token) is not None
    assert backend.decode_session(token + "tampered") is None
    monkeypatch.setattr(backend, "time", lambda: 99999999999)
    assert client.get("/api/review").status_code == 401


def test_missing_dataset_is_explicit(app_client, monkeypatch):
    client, _ = app_client
    sign_in(client)
    monkeypatch.delenv("ANNOTATION_REVIEW_WORKSPACE")
    assert client.get("/api/review").json()["enabled"] is False


def test_credentials_require_no_legacy_assignment_globs(app_client):
    _, backend = app_client
    assert backend.parse_configured_users('[{"username":"new","password":"pass"}]')[0].username == "new"
    for value in ["", "[]", "{}", '[{"username":"a","password":""}]',
                  '[{"username":"a","password":"p"},{"username":"a","password":"p"}]']:
        with pytest.raises(ValueError):
            backend.parse_configured_users(value)
