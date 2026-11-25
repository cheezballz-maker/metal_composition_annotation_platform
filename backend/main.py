"""Composition review application: authentication, review API, and static frontend."""
from __future__ import annotations

import json
import os
import secrets
from base64 import b64decode, urlsafe_b64decode, urlsafe_b64encode
from dataclasses import dataclass
from hashlib import sha256
from hmac import new as hmac_new
from pathlib import Path
from time import time

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parents[1]
FRONTEND_DIST = ROOT / "frontend" / "dist"
APP_USERNAME = os.getenv("ANNOTATION_APP_USERNAME", "annotator")
APP_PASSWORD = os.getenv("ANNOTATION_APP_PASSWORD", "")
APP_USERS_JSON = os.getenv("ANNOTATION_USERS_JSON")
SESSION_SECRET = os.getenv("ANNOTATION_SESSION_SECRET", "")
SESSION_COOKIE_NAME = "annotation_session"
SESSION_MAX_AGE = 8 * 60 * 60


class ReviewCompressionMiddleware:
    """Lossless compression for review JSON; leave auth, assets and ZIP exports alone."""
    def __init__(self, app):
        self.app = app
        self.compressed = GZipMiddleware(app, minimum_size=1000, compresslevel=3)

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        target = self.compressed if scope["type"] == "http" and path.startswith("/api/review") and not path.endswith("/export") else self.app
        await target(scope, receive, send)

@dataclass(frozen=True)
class ConfiguredUser:
    username: str
    password: str


@dataclass(frozen=True)
class UserAccess:
    username: str


def parse_configured_users(raw: str) -> tuple[ConfiguredUser, ...]:
    if not raw.strip():
        raise ValueError("must be a non-empty JSON array")
    try:
        entries = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("must be valid JSON") from exc
    if not isinstance(entries, list) or not entries:
        raise ValueError("must be a non-empty JSON array")

    users = []
    usernames = set()
    for position, entry in enumerate(entries, start=1):
        if not isinstance(entry, dict):
            raise ValueError(f"entry {position} must be an object")
        username = entry.get("username")
        password = entry.get("password")
        if not isinstance(username, str) or not username.strip() or username != username.strip():
            raise ValueError(f"entry {position} has an invalid username")
        if username in usernames:
            raise ValueError(f"username {username!r} is duplicated")
        if not isinstance(password, str) or not password:
            raise ValueError(f"entry {position} has an empty password")
        users.append(ConfiguredUser(username=username, password=password))
        usernames.add(username)
    return tuple(users)


try:
    CONFIGURED_USERS = parse_configured_users(APP_USERS_JSON) if APP_USERS_JSON is not None else ()
except ValueError as exc:
    raise RuntimeError(f"Invalid ANNOTATION_USERS_JSON: {exc}") from exc

AUTH_USERS = CONFIGURED_USERS or (
    (ConfiguredUser(username=APP_USERNAME, password=APP_PASSWORD),) if APP_PASSWORD else ()
)

if SESSION_SECRET and not AUTH_USERS:
    raise RuntimeError("ANNOTATION_SESSION_SECRET requires ANNOTATION_USERS_JSON or ANNOTATION_APP_PASSWORD")
if SESSION_SECRET and len(SESSION_SECRET) < 32:
    raise RuntimeError("ANNOTATION_SESSION_SECRET must contain at least 32 characters")


class LoginRequest(BaseModel):
    username: str
    password: str


app = FastAPI(title="Composition Review")
app.add_middleware(ReviewCompressionMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def authentication_enabled() -> bool:
    return bool(AUTH_USERS)


def session_authentication_enabled() -> bool:
    return bool(SESSION_SECRET and AUTH_USERS)


def authenticate_credentials(username: str, password: str) -> UserAccess | None:
    for configured_user in AUTH_USERS:
        username_matches = secrets.compare_digest(username, configured_user.username)
        password_matches = secrets.compare_digest(password, configured_user.password)
        if username_matches and password_matches:
            return UserAccess(username=configured_user.username)
    return None


def authenticate_basic_header(header: str | None) -> UserAccess | None:
    if not header or not header.startswith("Basic "):
        return None
    try:
        decoded = b64decode(header.removeprefix("Basic ").strip()).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None
    username, separator, password = decoded.partition(":")
    if not separator:
        return None
    return authenticate_credentials(username, password)


def encode_session(user: UserAccess) -> str:
    payload = json.dumps(
        {"username": user.username, "expires_at": int(time()) + SESSION_MAX_AGE},
        separators=(",", ":"),
    ).encode()
    encoded_payload = urlsafe_b64encode(payload).rstrip(b"=")
    signature = hmac_new(SESSION_SECRET.encode(), encoded_payload, sha256).digest()
    return f"{encoded_payload.decode()}.{urlsafe_b64encode(signature).rstrip(b'=').decode()}"


def decode_session(token: str | None) -> UserAccess | None:
    if not token or not SESSION_SECRET:
        return None
    encoded_payload, separator, encoded_signature = token.partition(".")
    if not separator:
        return None
    try:
        payload_bytes = encoded_payload.encode()
        expected_signature = hmac_new(SESSION_SECRET.encode(), payload_bytes, sha256).digest()
        supplied_signature = urlsafe_b64decode(encoded_signature + "=" * (-len(encoded_signature) % 4))
        if not secrets.compare_digest(supplied_signature, expected_signature):
            return None
        payload = json.loads(urlsafe_b64decode(encoded_payload + "=" * (-len(encoded_payload) % 4)))
        expires_at = int(payload.get("expires_at", 0)) if isinstance(payload, dict) else 0
    except (TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or expires_at <= int(time()):
        return None
    username = payload.get("username")
    for configured_user in AUTH_USERS:
        if isinstance(username, str) and secrets.compare_digest(username, configured_user.username):
            return UserAccess(username=configured_user.username)
    return None


def secure_cookie_request(request: Request) -> bool:
    forwarded_protocol = request.headers.get("x-forwarded-proto", "").split(",", 1)[0].strip()
    return request.url.scheme == "https" or forwarded_protocol == "https"


@app.middleware("http")
async def require_basic_auth(request: Request, call_next):
    if request.method == "OPTIONS" or request.url.path == "/api/health" or not authentication_enabled():
        request.state.annotation_user = None
        return await call_next(request)
    if session_authentication_enabled():
        if not request.url.path.startswith("/api/") or request.url.path in {"/api/auth/login", "/api/auth/logout"}:
            request.state.annotation_user = None
            return await call_next(request)
        user = decode_session(request.cookies.get(SESSION_COOKIE_NAME))
        if user:
            request.state.annotation_user = user
            return await call_next(request)
        return JSONResponse({"detail": "Authentication required"}, status_code=401)
    user = authenticate_basic_header(request.headers.get("authorization"))
    if user:
        request.state.annotation_user = user
        return await call_next(request)
    return Response(
        "Authentication required",
        status_code=401,
        headers={"WWW-Authenticate": 'Basic realm="Annotation Platform"'},
    )


def request_user(request: Request) -> UserAccess | None:
    return getattr(request.state, "annotation_user", None)


@app.get("/api/auth/session")
def auth_session(request: Request) -> dict:
    user = request_user(request)
    return {
        "authenticated": not authentication_enabled() or user is not None,
        "username": user.username if user else None,
        "mode": "session" if session_authentication_enabled() else ("basic" if authentication_enabled() else "none"),
    }


@app.post("/api/auth/login")
def login(payload: LoginRequest, request: Request) -> Response:
    if not session_authentication_enabled():
        raise HTTPException(status_code=404, detail="Session login is not enabled")
    user = authenticate_credentials(payload.username, payload.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid username or password")
    response = JSONResponse({"authenticated": True, "username": user.username, "mode": "session"})
    response.set_cookie(
        SESSION_COOKIE_NAME,
        encode_session(user),
        max_age=SESSION_MAX_AGE,
        httponly=True,
        secure=secure_cookie_request(request),
        samesite="lax",
        path="/",
    )
    return response


@app.post("/api/auth/logout")
def logout(request: Request) -> Response:
    response = JSONResponse({"authenticated": False})
    response.delete_cookie(
        SESSION_COOKIE_NAME,
        httponly=True,
        secure=secure_cookie_request(request),
        samesite="lax",
        path="/",
    )
    return response



@app.api_route("/api/health", methods=["GET", "HEAD"])
def health() -> dict:
    return {"status": "ok", "workflow": "composition-review",
            "review_enabled": bool(
                os.getenv("ANNOTATION_REVIEW_WORKSPACE", "").strip()
                or os.getenv("ANNOTATION_REVIEW_WORKSPACES_JSON", "").strip()
            )}


from .review_api import router as review_router

app.include_router(review_router)


if FRONTEND_DIST.is_dir():
    assets_dir = FRONTEND_DIST / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
    def frontend_index() -> FileResponse:
        return FileResponse(FRONTEND_DIST / "index.html")
