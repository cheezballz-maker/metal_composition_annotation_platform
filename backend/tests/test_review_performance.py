"""Lossless review transport and unchanged validation decisions."""
from copy import deepcopy
import importlib
import json

import pytest
from fastapi.testclient import TestClient

from backend.tests.test_description_extensions import description_save_workspace
from backend.tests.test_review_workflow import ENV_KEYS, auth


def test_review_compression_keeps_payload_and_persistence_identical(tmp_path, monkeypatch):
    for key in ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    root = tmp_path / "review"
    description_save_workspace(root)
    monkeypatch.setenv("ANNOTATION_REVIEW_WORKSPACE", str(root))
    monkeypatch.setenv("ANNOTATION_USERS_JSON", json.dumps([{"username":"alice","password":"pass"}]))
    from backend import main
    app = importlib.reload(main).app
    endpoint = "/api/review/records/source-a"
    stored = (root/"documents/source-a.json").read_bytes()
    with TestClient(app, headers=auth("alice")) as client:
        plain = client.get(endpoint, headers={"Accept-Encoding":"identity"})
        compressed = client.get(endpoint, headers={"Accept-Encoding":"gzip"})
        assert plain.status_code == compressed.status_code == 200
        assert plain.content == compressed.content
        assert "content-encoding" not in plain.headers
        assert compressed.headers["content-encoding"] == "gzip"
        assert int(compressed.headers["content-length"]) < len(compressed.content)
        assert "Accept-Encoding" in compressed.headers["vary"]
        assert (root/"documents/source-a.json").read_bytes() == stored
        original = plain.json()["document"]
        data = deepcopy(original["compositions"][0]["data"])
        data["composition_name"] = "Reviewed alloy"
        payload = {"action":"edit","action_id":"compressed-save","revision":original["revision"],"composition_id":"seed:1","data":data}
        saved = client.post(endpoint+"/actions",json=payload,headers={"Accept-Encoding":"gzip"})
        assert saved.status_code == 200 and saved.headers["content-encoding"] == "gzip"
        document = saved.json()["document"]
        assert document["compositions"][0]["data"] == data
        assert document["events"][-1]["after"]["composition"]["data"] == data
        retry = client.post(endpoint+"/actions",json=payload,headers={"Accept-Encoding":"identity"})
        assert retry.json()["idempotent"] and retry.json()["document"] == document
        export = client.get("/api/review/export",headers={"Accept-Encoding":"gzip"})
        assert export.status_code == 200 and "content-encoding" not in export.headers
        health = client.get("/api/health",headers={"Accept-Encoding":"gzip"})
        assert "content-encoding" not in health.headers


def test_normal_descriptions_validate_once_and_legacy_undo_still_revalidates(tmp_path):
    from backend.composition_schema import validate_composition, validate_record
    from backend.review_workflow import _validate_document
    root = tmp_path/"review"
    description_save_workspace(root)
    document = json.loads((root/"documents/source-a.json").read_text(encoding="utf-8"))
    calls = []
    def checked(record, content):
        calls.append(deepcopy(record))
        return validate_record(record,content)
    before = deepcopy(document)
    _validate_document(document,"Alloy source claim",checked,validate_composition)
    assert len(calls) == 1 and document == before
    child = deepcopy(document["compositions"][0])
    child.update(id="seed:2")
    child["data"].update(node_no=2,constituents=[{"constituent_name":"Ti","constituent_status":"included"}],unrepresented_relations=[{"kind":"inherits_from","mode":"add_only","base_node_no":1,"changes":[{"target":"constituent","ref":"Ti","operation":"add"}],"evidence_span":child["data"]["evidence_spans"][0]}])
    document["compositions"].append(child)
    calls.clear()
    _validate_document(document,"Alloy source claim",checked,validate_composition)
    assert len(calls)==2 and document["compositions"][1]["data"]["inherits_from"] == 1
    invalid=deepcopy(document)
    invalid["compositions"][1]["data"]["constituents"][0]["constituent_name"] = "Cu"
    with pytest.raises(ValueError,match="cannot repeat"):
        _validate_document(invalid,"Alloy source claim",checked,validate_composition)


def test_inheritance_fast_path_keeps_malformed_input_a_validation_error(tmp_path):
    from backend.composition_schema import validate_composition, validate_record
    from backend.review_workflow import _validate_document
    root = tmp_path/"review"
    description_save_workspace(root)
    for malformed in [None, 42, {}]:
        document = json.loads((root/"documents/source-a.json").read_text(encoding="utf-8"))
        document["compositions"][0]["data"]["unrepresented_relations"] = malformed
        with pytest.raises(ValueError,match="array"):
            _validate_document(document,"Alloy source claim",validate_record,validate_composition)
