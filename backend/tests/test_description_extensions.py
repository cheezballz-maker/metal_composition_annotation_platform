"""Description-only ranges, inheritance, persistence, and export regression checks."""
from copy import deepcopy
import json

import pytest

from backend.description_schema import lean_inheritance, migrate_description_document
from backend.composition_schema import validate_record, validate_composition
from backend.composition_export import canonical_composition, corrected_record
from backend.review_store import ReviewStore, request_digest
from backend.tests.test_review_workflow import make_workspace, workflow_mutator
from backend.tests.test_composition_schema import CONTENT, composition, record


def description_save_workspace(root):
    """Synthetic dataset exercising the real API and constituent-only saves."""
    make_workspace(root)
    for path in (root / "documents").glob("*.json"):
        doc = json.loads(path.read_text(encoding="utf-8"))
        doc["meta"]["section"] = "description"
        doc["baseline"]["meta"]["section"] = "description"
        for item in [*(c["data"] for c in doc["compositions"]), *doc["baseline"]["compositions"]]:
            item.pop("claim_no", None)
            item["constituents"] = [
                {"constituent_name": "Cu", "constituent_status": "included", "amount_comparator": "range", "amount_lower_value": 3, "amount_upper_value": 20, "amount_unit": "wt%"},
                {"constituent_name": "Fe", "constituent_status": "included", "amount_comparator": "equal", "amount_value": 1, "amount_unit": "wt%"},
                {"constituent_name": "Al", "constituent_status": "included", "amount_comparator": "balance"},
            ]
        path.write_text(json.dumps(doc), encoding="utf-8")


def test_unknown_inclusion_is_description_only_and_preserved(tmp_path):
    root = tmp_path / "review"
    description_save_workspace(root)
    store = ReviewStore(root)
    doc = store.load_document("source-a")
    updated = deepcopy(doc["compositions"][0]["data"])
    updated["constituents"][0]["constituent_status"] = None
    payload = {"action_id": "unknown-save", "action": "edit", "composition_id": "seed:1", "data": updated}
    saved, _ = store.commit("source-a", expected_revision=0, action_id=payload["action_id"],
        request_digest=request_digest(payload), actor="alice", role="reviewer", timestamp="2026-11-26T00:00:00+00:00",
        mutate=workflow_mutator(payload))
    assert saved["compositions"][0]["data"]["constituents"][0]["constituent_status"] is None
    assert corrected_record(store.load_document("source-a"))["compositions"][0]["constituents"][0]["constituent_status"] is None
    with pytest.raises(ValueError, match="constituent_status is unsupported"):
        validate_composition(updated, "Alloy source claim")
    for invalid in ("unknown", "", False):
        updated["constituents"][0]["constituent_status"] = invalid
        with pytest.raises(ValueError, match="constituent_status is unsupported"):
            validate_composition(updated, "Alloy source claim", require_constraint_evidence=False)


def test_preferred_ranges_save_through_real_http_api_without_finalizing_or_changing_other_sections(tmp_path, monkeypatch):
    import importlib
    from fastapi.testclient import TestClient
    from backend.tests.test_review_workflow import ENV_KEYS, auth
    for key in ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    root = tmp_path / "review"
    description_save_workspace(root)
    monkeypatch.setenv("ANNOTATION_REVIEW_WORKSPACE", str(root))
    monkeypatch.setenv("ANNOTATION_USERS_JSON", json.dumps([{"username": "alice", "password": "pass"}]))
    from backend import main
    app = importlib.reload(main).app
    path = "/api/review/records/source-a"
    with TestClient(app, headers=auth("alice")) as client:
        initial = client.get(path).json()["document"]
        data = deepcopy(initial["compositions"][0]["data"])
        siblings = deepcopy(data["constituents"][1:])
        other_document = (root / "documents/source-b.json").read_bytes()
        source_span = data["evidence_spans"]
        data["constituents"][0] = {"constituent_name": "Cu", "constituent_status": "included", "amounts": [
            {"preferred_order": 0, "amount_comparator": None, "amount_lower_value": None, "amount_upper_value": None, "evidence_spans": []},
            {"preferred_order": 1, "amount_comparator": "range", "amount_lower_value": 5, "amount_upper_value": 18, "amount_unit": "wt%", "evidence_spans": source_span},
        ]}
        payload = {"action": "edit", "action_id": "preferred-save", "revision": initial["revision"], "composition_id": "seed:1", "data": data}
        response = client.post(path + "/actions", json=payload)
        assert response.status_code == 200, response.text
        saved = response.json()["document"]
        assert saved["status"] == "in_review" and not saved["source_checked"]
        assert saved["compositions"][0]["data"] == data
        assert saved["compositions"][0]["data"]["constituents"][1:] == siblings
        assert (root / "documents/source-b.json").read_bytes() == other_document
        assert client.get(path).json()["document"]["compositions"][0]["data"] == data
        stored = json.loads((root / "documents/source-a.json").read_text(encoding="utf-8"))
        assert corrected_record(stored)["compositions"][0] == data
        no_change = client.post(path + "/actions", json={**payload, "action_id": "unchanged-save", "revision": saved["revision"]})
        assert no_change.status_code == 409 and no_change.json()["detail"] == "Edit does not change the composition"
        bad = deepcopy(data)
        bad["constituents"][0]["amounts"].append({"preferred_order": 2, "amount_comparator": "range", "evidence_spans": source_span})
        rejected = client.post(path + "/actions", json={**payload, "action_id": "fix-after-rejection", "revision": saved["revision"], "data": bad})
        assert rejected.status_code == 422
        bad["constituents"][0]["amounts"][2].update(amount_lower_value=7, amount_upper_value=15, amount_unit="wt%")
        fixed = client.post(path + "/actions", json={**payload, "action_id": "fix-after-rejection", "revision": saved["revision"], "data": bad})
        assert fixed.status_code == 200, fixed.text
        stale = client.post(path + "/actions", json={**payload, "action_id": "genuine-stale", "revision": saved["revision"], "data": bad})
        assert stale.status_code == 409 and stale.json()["detail"].startswith("Revision conflict:")


def description():
    value = record()
    value["meta"]["section"] = "description"
    value["compositions"][0].pop("claim_no")
    return value


def test_description_constraint_evidence_is_removed_and_migration_preserves_history():
    value = description()
    rule = {"constraint_id":"k1","mode":"sum","member_refs":["C"],"constituent_status":"included","selection":{"min":None,"max":None},"amount_comparator":"range","amount_unit":"%","amount_upper_value":.2,"amount_upper_endpoint_type":"closed"}
    value["compositions"][0]["constraints"]=[rule]
    assert validate_record(value, CONTENT)==value
    for quote in ("", "existing source wording"):
        old=deepcopy(value);old["compositions"][0]["constraints"][0]["evidence"]=quote
        with pytest.raises(ValueError, match="removed"):
            validate_record(old,CONTENT)
        doc={"meta":old["meta"],"baseline":old,"compositions":[{"data":old["compositions"][0]}],"events":[{"before":deepcopy(old)}]}
        migrated=migrate_description_document(doc)
        assert "evidence" not in migrated["compositions"][0]["data"]["constraints"][0]
        assert migrated["events"]==doc["events"]
        assert migrated["compositions"][0]["data"]["evidence_spans"]==value["compositions"][0]["evidence_spans"]
    claim=deepcopy(value);claim["meta"]["section"]="claim"
    with pytest.raises(ValueError,match="evidence"):
        validate_record(claim,CONTENT)


def test_free_text_description_notes_need_no_rule_evidence_but_claims_keep_old_contract():
    value=description();note={"kind":"source_note","description":"Review this composition against the examples."}
    value["compositions"][0]["unrepresented_relations"]=[note]
    assert validate_record(value,CONTENT)==value
    claim=deepcopy(value);claim["meta"]["section"]="claim"
    with pytest.raises(ValueError,match="evidence_span"):
        validate_record(claim,CONTENT)


def test_description_restriction_without_evidence_saves_through_http_and_exports(tmp_path, monkeypatch):
    import importlib
    from fastapi.testclient import TestClient
    from backend.tests.test_review_workflow import ENV_KEYS, auth
    for key in ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    root = tmp_path / "review"
    description_save_workspace(root)
    monkeypatch.setenv("ANNOTATION_REVIEW_WORKSPACE", str(root))
    monkeypatch.setenv("ANNOTATION_USERS_JSON", json.dumps([{"username": "alice", "password": "pass"}]))
    from backend import main
    app = importlib.reload(main).app
    with TestClient(app, headers=auth("alice")) as client:
        endpoint = "/api/review/records/source-a"
        initial = client.get(endpoint).json()["document"]
        data = deepcopy(initial["compositions"][0]["data"])
        data["constraints"] = [{"constraint_id": "k1", "mode": "sum", "member_refs": ["Cu", "Fe"],
            "constituent_status": "included", "selection": {"min": None, "max": None},
            "amount_comparator": "range", "amount_unit": "wt%", "amount_upper_value": 21,
            "amount_upper_endpoint_type": "closed"}]
        response = client.post(endpoint+"/actions", json={"action":"edit","action_id":"no-quote-rule", "revision":initial["revision"],"composition_id":"seed:1","data":data})
        assert response.status_code == 200, response.text
        saved = response.json()["document"]
        assert saved["compositions"][0]["data"] == data
        assert corrected_record(saved)["compositions"][0]["constraints"] == data["constraints"]
        assert "evidence" not in data["constraints"][0]
        assert data["constituents"] == initial["compositions"][0]["data"]["constituents"]
        assert data["evidence_spans"] == initial["compositions"][0]["data"]["evidence_spans"]


def with_ranges():
    value = description()
    constituent = value["compositions"][0]["constituents"][0]
    scalar = {k: v for k, v in constituent.items() if k.startswith("amount_")}
    for key in scalar:
        del constituent[key]
    constituent["amounts"] = [
        {**scalar, "preferred_order": 0, "evidence_spans": deepcopy(value["compositions"][0]["evidence_spans"])},
        {**scalar, "preferred_order": 1, "amount_lower_value": .12, "amount_upper_value": .18,
         "variant_ref": "preferred-A", "evidence_spans": deepcopy(value["compositions"][0]["evidence_spans"])},
    ]
    return value


def with_inheritance():
    value = description()
    base = value["compositions"][0]
    child = deepcopy(base)
    child["node_no"] = 8
    child["constituents"][0]["amount_lower_value"] = .12
    child["unrepresented_relations"] = [{
        "kind": "inherits_from", "base_node_no": 7,
        "changes": [{"target": "constituent", "ref": "C", "operation": "narrow"}],
        "evidence_span": deepcopy(child["evidence_spans"][0]),
    }]
    value["compositions"].append(child)
    return value


def with_add_only_inheritance():
    value = with_inheritance()
    child = value["compositions"][1]
    child["constituents"][0]["constituent_name"] = "Ti"
    child["unrepresented_relations"][0].update(mode="add_only", changes=[{"target": "constituent", "ref": "Ti", "operation": "add"}])
    return value


def test_add_only_links_preserve_parents_and_export_only_local_additions_plus_link():
    value = with_add_only_inheritance()
    before = deepcopy(value)
    assert validate_record(value, CONTENT) == before == value
    exported = corrected_record({"baseline": value, "meta": value["meta"], "source_quality": value["source_quality"], "compositions": [{"data": c} for c in value["compositions"]]})
    assert exported == {**value, "compositions": [lean_inheritance(c) for c in value["compositions"]]}
    assert [c["constituent_name"] for c in exported["compositions"][1]["constituents"]] == ["Ti"]
    assert exported["compositions"][1]["inherits_from"] == 7


def with_lean_inheritance():
    value = with_add_only_inheritance()
    value["compositions"] = [lean_inheritance(c) for c in value["compositions"]]
    return value


def test_lean_inheritance_needs_only_parent_reference_and_local_additions():
    value = with_lean_inheritance()
    value["compositions"][1]["evidence_spans"] = []
    before = deepcopy(value)
    assert validate_record(value, CONTENT) == before == value
    child = value["compositions"][1]
    assert child["inherits_from"] == 7 and child["unrepresented_relations"] == []
    assert [c["constituent_name"] for c in child["constituents"]] == ["Ti"]


@pytest.mark.parametrize("failure", ["self", "missing", "boolean", "string", "zero", "list", "cycle", "duplicate", "exclusion", "restriction_override", "mixed"])
def test_lean_inheritance_validates_add_only_semantics(failure):
    value = with_lean_inheritance()
    base, child = value["compositions"]
    if failure == "self": child["inherits_from"] = 8
    if failure == "missing": child["inherits_from"] = 99
    if failure == "boolean": child["inherits_from"] = True
    if failure == "string": child["inherits_from"] = "7"
    if failure == "zero": child["inherits_from"] = 0
    if failure == "list": child["inherits_from"] = [7]
    if failure == "cycle": base["inherits_from"] = 8
    if failure == "duplicate": child["constituents"][0]["constituent_name"] = "C"
    if failure == "exclusion": child["constituents"][0]["constituent_status"] = "excluded"
    if failure == "restriction_override":
        constraint = {"constraint_id":"sum-1","mode":"sum","member_refs":["C"],"constituent_status":"included","selection":{"min":None,"max":None},"amount_comparator":"range","amount_upper_value":.2,"amount_unit":"%","evidence":"suffix"}
        base["constraints"] = [constraint]
        child["constraints"] = [deepcopy(constraint)]
    if failure == "mixed": child["unrepresented_relations"] = with_add_only_inheritance()["compositions"][1]["unrepresented_relations"]
    with pytest.raises(ValueError): validate_record(value, CONTENT)


def test_migration_preserves_annotations_history_workflow_and_distinct_evidence():
    value = with_add_only_inheritance()
    value["compositions"][1]["unrepresented_relations"].append({"kind":"source_note","description":"keep me","evidence_span":deepcopy(value["compositions"][1]["evidence_spans"][0])})
    value["compositions"][1]["evidence_spans"] = []
    doc = {"meta":value["meta"],"baseline":deepcopy(value),"compositions":[{"data":c,"decision":"edited","deleted":False} for c in value["compositions"]],"events":[{"action":"edit","before":{"composition":{"data":deepcopy(value["compositions"][1])}}}],"revision":42,"status":"finalized","reviewer":"alice","review_outcome":"compositions_found"}
    snapshot = deepcopy(doc)
    result = migrate_description_document(doc)
    assert doc == snapshot and result["events"] == snapshot["events"]
    for key in ["revision","status","reviewer","review_outcome"]: assert result[key] == snapshot[key]
    child = result["compositions"][1]["data"]
    assert child["inherits_from"] == 7 and len(child["unrepresented_relations"]) == 1
    assert child["unrepresented_relations"][0]["description"] == "keep me"
    for key in ["constituents","constraints","composition_name","node_no"]: assert child[key] == snapshot["compositions"][1]["data"][key]
    assert child["evidence_spans"] == [snapshot["compositions"][1]["data"]["unrepresented_relations"][0]["evidence_span"]]
    assert migrate_description_document(result) == result
    claims = deepcopy(doc)
    claims["meta"]["section"] = "claim"
    assert migrate_description_document(claims) == claims


def test_lean_links_are_rejected_in_claims():
    value = record()
    value["compositions"][0]["inherits_from"] = 7
    with pytest.raises(ValueError, match="only for descriptions"): validate_record(value, CONTENT)


def test_undo_restores_legacy_snapshot_as_lean_without_rewriting_history(tmp_path):
    from backend.review_workflow import apply_action
    root = tmp_path / "review"
    description_save_workspace(root)
    document = json.loads((root / "documents/source-a.json").read_text(encoding="utf-8"))
    base = document["compositions"][0]
    old_child = deepcopy(base)
    old_child.update(id="seed:2", decision="edited")
    old_child["data"].update(node_no=2, constituents=[{"constituent_name":"Ti","constituent_status":"included"}])
    old_child["data"]["unrepresented_relations"] = [{"kind":"inherits_from","mode":"add_only","base_node_no":1,"changes":[{"target":"constituent","ref":"Ti","operation":"add"}],"evidence_span":deepcopy(old_child["data"]["evidence_spans"][0])}]
    document["compositions"].append(deepcopy(old_child))
    document["compositions"][1]["data"]["composition_name"] = "Edited name"
    document["events"] = [{"action":"edit","action_id":"old-edit","composition_id":"seed:2","before":{"composition":deepcopy(old_child)}}]
    migrated = migrate_description_document(document)
    history = deepcopy(migrated["events"])
    restored, event = apply_action(migrated, {"action":"undo"}, actor="alice",role="reviewer",content="Alloy source claim",next_revision=1,validate_record=validate_record,validate_composition=validate_composition)
    assert restored["compositions"][1]["data"]["inherits_from"] == 1
    assert restored["compositions"][1]["data"]["unrepresented_relations"] == []
    assert restored["compositions"][1]["data"]["composition_name"] == old_child["data"]["composition_name"]
    assert restored["events"] == history and event["undoes_action_id"] == "old-edit"


@pytest.mark.parametrize("failure", ["repeat", "exclude_inherited", "exclude_local", "narrow", "replace", "missing_change", "duplicate_change", "unknown_mode", "bad_ref", "cycle"])
def test_add_only_rejects_modifications_and_invalid_links(failure):
    value = with_add_only_inheritance()
    base, child = value["compositions"]
    link = child["unrepresented_relations"][0]
    if failure in {"repeat", "exclude_inherited"}:
        child["constituents"][0]["constituent_name"] = "C"
        link["changes"][0]["ref"] = "C"
    if failure in {"exclude_inherited", "exclude_local"}: child["constituents"][0]["constituent_status"] = "excluded"
    if failure in {"narrow", "replace"}: link["changes"][0]["operation"] = failure
    if failure == "missing_change": link["changes"] = []
    if failure == "duplicate_change": link["changes"].append(deepcopy(link["changes"][0]))
    if failure == "unknown_mode": link["mode"] = "replace"
    if failure == "bad_ref": link["changes"][0]["ref"] = ["Ti"]
    if failure == "cycle": base["unrepresented_relations"] = [{**deepcopy(link), "base_node_no": 8, "changes": [{"target":"constituent","ref":"C","operation":"add"}]}]
    with pytest.raises(ValueError): validate_record(value, CONTENT)


def test_add_only_chain_protects_ancestor_constituents():
    value = with_add_only_inheritance()
    child = deepcopy(value["compositions"][1])
    child["node_no"] = 9
    child["constituents"][0]["constituent_name"] = "Nb"
    child["unrepresented_relations"][0].update(base_node_no=8,changes=[{"target":"constituent","ref":"Nb","operation":"add"}])
    value["compositions"].append(child)
    assert validate_record(value, CONTENT) == value
    child["constituents"][0]["constituent_name"] = "C"
    child["unrepresented_relations"][0]["changes"][0]["ref"] = "C"
    with pytest.raises(ValueError, match="cannot repeat"):
        validate_record(value, CONTENT)


def test_add_only_rejects_impossible_totals_without_rebalancing():
    value = with_add_only_inheritance()
    base, child = value["compositions"]
    base["constituents"][0].update(amount_unit="wt%", amount_lower_value=100, amount_upper_value=100, amount_upper_endpoint_type="closed")
    child["constituents"][0]["amount_unit"] = "wt%"
    original = deepcopy(value)
    with pytest.raises(ValueError, match="exceed 100"):
        validate_record(value, CONTENT)
    assert original == value


def test_add_only_chain_saves_via_http_and_tracks_base_edits_without_copying_fields(tmp_path, monkeypatch):
    import importlib
    from fastapi.testclient import TestClient
    from backend.tests.test_review_workflow import ENV_KEYS, auth
    for key in ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    root = tmp_path / "review"
    description_save_workspace(root)
    path = root / "documents/source-a.json"
    doc = json.loads(path.read_text(encoding="utf-8"))
    for node, name in [(2, "Ti"), (3, "Nb")]:
        item = deepcopy(doc["compositions"][0])
        item["id"] = f"seed:{node}"
        item["data"]["node_no"] = node
        item["data"]["constituents"] = [{"constituent_name":name,"constituent_status":"included","amount_comparator":"range","amount_upper_value":.04,"amount_upper_endpoint_type":"closed","amount_unit":"wt%"}]
        doc["compositions"].append(item)
    path.write_text(json.dumps(doc),encoding="utf-8")
    monkeypatch.setenv("ANNOTATION_REVIEW_WORKSPACE",str(root))
    monkeypatch.setenv("ANNOTATION_USERS_JSON",json.dumps([{"username":"alice","password":"pass"}]))
    from backend import main
    app = importlib.reload(main).app
    endpoint = "/api/review/records/source-a"
    with TestClient(app,headers=auth("alice")) as client:
        current = client.get(endpoint).json()["document"]
        for node, parent, name in [(2,1,"Ti"),(3,2,"Nb")]:
            changed = deepcopy(current["compositions"][node-1]["data"])
            changed["inherits_from"] = parent
            response = client.post(endpoint+"/actions",json={"action":"edit","action_id":f"link-{node}","revision":current["revision"],"composition_id":f"seed:{node}","data":changed})
            assert response.status_code == 200,response.text
            current = response.json()["document"]
        children = deepcopy(current["compositions"][1:])
        base = deepcopy(current["compositions"][0]["data"])
        base["constituents"][0]["amount_upper_value"] = 18
        response = client.post(endpoint+"/actions",json={"action":"edit","action_id":"change-base","revision":current["revision"],"composition_id":"seed:1","data":base})
        assert response.status_code == 200,response.text
        current = response.json()["document"]
        assert current["compositions"][1:] == children
        assert current["status"] == "in_review"
        stored = json.loads(path.read_text(encoding="utf-8"))
        exported = corrected_record(stored)
        assert exported["compositions"][0]["constituents"][0]["amount_upper_value"] == 18
        assert [v["constituent_name"] for v in exported["compositions"][2]["constituents"]] == ["Nb"]
        assert exported["compositions"][2]["inherits_from"] == 2
        before = path.read_bytes()
        override = deepcopy(current["compositions"][1]["data"])
        override["constituents"][0]["constituent_name"] = "Cu"

        rejected = client.post(endpoint+"/actions",json={"action":"edit","action_id":"override","revision":current["revision"],"composition_id":"seed:2","data":override})
        assert rejected.status_code == 422 and path.read_bytes() == before
        deletion = client.post(endpoint+"/actions",json={"action":"delete","action_id":"delete-base","revision":current["revision"],"composition_id":"seed:1"})
        assert deletion.status_code == 422 and path.read_bytes() == before


def test_existing_scalars_and_labeled_ranges_are_preserved_without_mutation():
    validate_record(description(), CONTENT)
    value = with_ranges()
    original = deepcopy(value)
    assert validate_record(value, CONTENT) == original == value
    assert corrected_record({"baseline": value, "meta": value["meta"], "source_quality": value["source_quality"],
                             "compositions": [{"data": c} for c in value["compositions"]]}) == value


def test_legacy_roles_still_validate_without_rewriting_stored_annotations():
    value = with_ranges()
    for amount, role in zip(value["compositions"][0]["constituents"][0]["amounts"], ["general", "preferred"]):
        del amount["preferred_order"]
        amount["role"] = role
    assert validate_record(value, CONTENT) == value


@pytest.mark.parametrize("orders", [[0, 0], [0, 2], [1, 0], [0, -1], [0, True], [0, 1.0], [0, "1"], [2, 3]])
def test_preference_orders_are_integer_unique_consecutive_and_in_array_order(orders):
    value = with_ranges()
    for amount, order in zip(value["compositions"][0]["constituents"][0]["amounts"], orders):
        amount["preferred_order"] = order
    with pytest.raises(ValueError, match="preferred_order"):
        validate_record(value, CONTENT)


def test_preferred_only_does_not_require_or_invent_a_general_range():
    value = with_ranges()
    amounts = value["compositions"][0]["constituents"][0]["amounts"]
    del amounts[0]
    before = deepcopy(value)
    assert validate_record(value, CONTENT) == before == value
    assert [a["preferred_order"] for a in amounts] == [1]


def test_unstated_base_accepts_null_values_but_does_not_weaken_preferred_validation():
    value = with_ranges()
    amounts = value["compositions"][0]["constituents"][0]["amounts"]
    fields = [key for key in amounts[0] if key.startswith("amount_")]
    amounts[0] = {**{key: None for key in fields}, "preferred_order": 0, "evidence_spans": []}
    assert validate_record(value, CONTENT) == value
    amounts[1] = {**amounts[0], "preferred_order": 1}
    with pytest.raises(ValueError, match="amount_comparator"):
        validate_record(value, CONTENT)


def test_unstated_base_cannot_assert_source_evidence_or_string_dash_numeric_values():
    value = with_ranges()
    amounts = value["compositions"][0]["constituents"][0]["amounts"]
    amounts[0] = {"preferred_order": 0, "evidence_spans": deepcopy(amounts[1]["evidence_spans"])}
    with pytest.raises(ValueError, match="unstated Base"):
        validate_record(value, CONTENT)
    amounts[0] = {"preferred_order": 0, "amount_lower_value": "-", "evidence_spans": []}
    with pytest.raises(ValueError, match="finite number"):
        validate_record(value, CONTENT)


def test_unranked_alternative_is_kept_separate_and_role_cannot_conflict_with_order():
    value = with_ranges()
    amounts = value["compositions"][0]["constituents"][0]["amounts"]
    alternative = {**deepcopy(amounts[1]), "role": "alternative"}
    del alternative["preferred_order"]
    amounts.append(alternative)
    assert validate_record(value, CONTENT) == value
    amounts[1]["role"] = "preferred"
    with pytest.raises(ValueError, match="without role"):
        validate_record(value, CONTENT)


@pytest.mark.parametrize("failure", ["mixed", "evidence", "reversed", "missing_value", "bad_role", "nan"])
def test_invalid_ranges_are_rejected(failure):
    value = with_ranges()
    row = value["compositions"][0]["constituents"][0]
    amount = row["amounts"][1]
    if failure == "mixed": row["amount_lower_value"] = 1
    if failure == "evidence": amount["evidence_spans"][0]["evidence_text"] = "invented"
    if failure == "reversed": amount["amount_lower_value"] = 10
    if failure == "missing_value":
        for field in ["amount_lower_value", "amount_upper_value", "amount_lower_endpoint_type", "amount_upper_endpoint_type"]:
            amount[field] = None
    if failure == "bad_role": amount["role"] = "guessed"
    if failure == "nan": amount["amount_value"] = float("nan")
    with pytest.raises(ValueError): validate_record(value, CONTENT)


def test_claims_cannot_use_description_extensions():
    for value in [with_ranges(), with_inheritance()]:
        value["meta"]["section"] = "claim"
        with pytest.raises(ValueError, match="only for descriptions"):
            validate_record(value, CONTENT)


def test_labeled_amount_identity_ignores_location_but_preserves_preference_and_units():
    base = with_ranges()["compositions"][0]
    moved = deepcopy(base)
    moved["constituents"][0]["amounts"][0]["evidence_spans"] = []
    assert canonical_composition(base) == canonical_composition(moved)
    moved["constituents"][0]["amounts"][0]["amount_unit"] = "at%"
    assert canonical_composition(base) != canonical_composition(moved)
    moved = deepcopy(base)
    del moved["constituents"][0]["amounts"][1]["preferred_order"]
    moved["constituents"][0]["amounts"][1]["role"] = "alternative"
    assert canonical_composition(base) != canonical_composition(moved)
    moved = deepcopy(base)
    moved["constituents"][0]["amounts"].append({**deepcopy(moved["constituents"][0]["amounts"][1]), "preferred_order": 2, "amount_lower_value": .14})
    reordered = deepcopy(moved)
    reordered["constituents"][0]["amounts"][1]["amount_lower_value"] = .14
    reordered["constituents"][0]["amounts"][2]["amount_lower_value"] = .12
    assert canonical_composition(moved) != canonical_composition(reordered)


@pytest.mark.parametrize("failure", ["missing_base", "self", "cycle", "unknown_change", "missing_child_field", "add_existing", "excluded_status"])
def test_invalid_inheritance_is_rejected(failure):
    value = with_inheritance()
    base, child = value["compositions"]
    relation = child["unrepresented_relations"][0]
    if failure == "missing_base": relation["base_node_no"] = 999
    if failure == "self": relation["base_node_no"] = 8
    if failure == "cycle":
        base["unrepresented_relations"] = [{**deepcopy(relation), "base_node_no": 8}]
    if failure == "unknown_change": relation["changes"][0]["ref"] = "Si"
    if failure == "missing_child_field": child["constituents"] = []
    if failure == "add_existing": relation["changes"][0]["operation"] = "add"
    if failure == "excluded_status": relation["changes"][0]["operation"] = "exclude"
    with pytest.raises(ValueError): validate_record(value, CONTENT)


def test_constraints_can_reference_inherited_constituents_through_a_chain():
    value = with_inheritance()
    middle = value["compositions"][1]
    middle["constituents"] = []
    middle["unrepresented_relations"][0]["changes"] = []
    child = deepcopy(middle)
    child["node_no"] = 9
    child["unrepresented_relations"][0]["base_node_no"] = 8
    child["constraints"] = [{"constraint_id": "sum-1", "mode": "sum", "member_refs": ["C"],
                             "constituent_status": "included", "selection": {"min": None, "max": None},
                             "amount_comparator": "range", "amount_upper_value": .19,
                             "amount_upper_endpoint_type": "closed", "amount_unit": "%"}]
    child["unrepresented_relations"][0]["changes"] = [{"target": "constraint", "ref": "sum-1", "operation": "add"}]
    value["compositions"].append(child)
    validate_record(value, CONTENT)
    child["constraints"][0]["member_refs"] = ["invented"]
    with pytest.raises(ValueError, match="unknown constituents"): validate_record(value, CONTENT)


def test_saved_ranges_and_links_survive_reload_and_deleting_a_base_is_blocked(tmp_path):
    make_workspace(tmp_path / "review")
    path = tmp_path / "review/documents/source-a.json"
    doc = json.loads(path.read_text())
    value = with_inheritance()
    # The fixture source text is "Alloy source claim".
    span = {"start": 0, "end": 5, "evidence_text": "Alloy"}
    for comp in value["compositions"]:
        comp["evidence_spans"] = [span]
        for relation in comp["unrepresented_relations"]: relation["evidence_span"] = span
    doc["meta"]["section"] = "description"
    doc["compositions"] = [{"id": f"seed:{i}", "origin": "seed", "decision": "pending", "data": c}
                           for i, c in enumerate(value["compositions"], 1)]
    path.write_text(json.dumps(doc), encoding="utf-8")
    store = ReviewStore(tmp_path / "review")
    updated = deepcopy(doc["compositions"][1]["data"])
    row = with_ranges()["compositions"][0]["constituents"][0]
    for amount in row["amounts"]: amount["evidence_spans"] = [span]
    updated["constituents"] = [row]
    payload = {"action_id": "test-edit", "action": "edit", "composition_id": "seed:2", "data": updated, "reason": "Preferred range"}
    store.commit("source-a", expected_revision=0, action_id=payload["action_id"], request_digest=request_digest(payload),
                 actor="alice", role="reviewer", timestamp="2026-11-20T00:00:00+00:00", mutate=workflow_mutator(payload))
    saved = json.loads(path.read_text())
    assert saved["compositions"][1]["data"] == updated
    assert corrected_record(saved)["compositions"][1] == updated
    before = path.read_bytes()
    deletion = {"action_id": "test-delete", "action": "delete", "composition_id": "seed:1", "reason": "Remove base"}
    with pytest.raises(ValueError, match="existing base_node_no"):
        store.commit("source-a", expected_revision=1, action_id=deletion["action_id"], request_digest=request_digest(deletion),
                     actor="alice", role="reviewer", timestamp="2026-11-20T00:00:00+00:00", mutate=workflow_mutator(deletion))
    assert path.read_bytes() == before
