# Metal Composition Annotation Platform

A React/Vite and FastAPI application for reviewing extracted metal and alloy
compositions against patent source text. Claims and descriptions use separate
review workspaces with their own assignments and workflow rules.

## Features

- Assigned review queues, authenticated accounts and reviewer/checker permissions.
- Description review with resizable Source, Compositions and Composition Instance panels.
- Exact source spans, overlapping evidence navigation, scoped editors and undo.
- Ordered preferred concentrations and add-only composition inheritance.
- Constituent restrictions: combined constituent concentration, group constituent
  selection, and Other rules as a free-text notes subsection.
- No separate restriction evidence field for descriptions; composition source spans remain available.
- Finalize/flag controls, explicit unlocking, revision conflict protection and attributed history.
- Progress and final exports that retain raw source coordinates and annotation fields.

## Requirements

- Python 3.11 or later.
- Node.js 22 or later and npm.
- A separately imported review workspace. This repository contains application
  code and synthetic tests; patent datasets, human annotations and credentials
  must be supplied separately.

## Configure

Set the following environment variables before starting the backend:

| Variable | Purpose |
|---|---|
| `ANNOTATION_REVIEW_WORKSPACE` | Absolute path to one imported workspace. |
| `ANNOTATION_REVIEW_WORKSPACES_JSON` | Optional array of workspace objects with `key`, `label`, `source_kind` and `path`, for multiple collections. |
| `ANNOTATION_USERS_JSON` | Array of account objects with `username` and `password`. Names must match workspace assignments/checkers. |
| `ANNOTATION_SESSION_SECRET` | Stable random secret of at least 32 characters for session login. |

Store real passwords and secrets outside Git. Importing reviewer assignments does
not create login accounts. Use one backend worker: storage uses in-process locks.

## Run locally

```sh
python -m venv .venv
# Activate .venv with the command for your shell.
python -m pip install -r backend/requirements.txt
cd frontend
npm ci
npm run build
cd ..
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --workers 1
```

Open http://127.0.0.1:8000. For frontend development, run `npm run dev` from
`frontend`; its API proxy targets the backend on port 8000.

## Import data

- `scripts/import_description_review.py` imports description extraction JSONL and
  a prepared patent-document dataset. Supply `--seed`, `--documents`, `--output`,
  `--dataset-id`, `--reviewer` and any `--checker` accounts.
- `scripts/import_composition_review.py` imports claims with rendered-to-raw
  projections. Supply explicit `--seed`, `--projection`, `--sources`, `--output`,
  `--report` and `--owner` paths/options rather than its historical pilot defaults.
- Additional scripts append description batches, assign reviewers, and migrate
  description schemas. Inspect each script's `--help` before using it.

Import into a new directory. Back up live review data before upgrades; retain
the workspace, authentication configuration and session secret across releases.
See [COMPOSITION_REVIEW.md](COMPOSITION_REVIEW.md) for schema and workflow details.

## Docker

```sh
docker build -t metal-composition-review .
docker run --rm -p 8000:8000 --env-file /path/to/private.env \
  -v /path/to/review-workspace:/data/review-workspace metal-composition-review
```

The image contains no dataset. The Build Hub packaging/backup utilities under
`deploy/` are optional and follow the existing deployment layout; the packager
expects a `build-hub-deploy` checkout and an already-built frontend.

## Verify

```sh
python -m pip install pytest httpx
python -m pytest backend/tests
cd frontend
npm ci
npm run test:review-mapper
npm run build
```

Tests use synthetic data and cover schemas, raw offsets, review permissions,
save/reload/export, inheritance, preferred ranges, conflict handling and undo.
