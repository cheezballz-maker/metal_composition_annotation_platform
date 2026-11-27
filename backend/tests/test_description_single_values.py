"""Scalar Single migration, workflow preservation and description-only saves."""
from copy import deepcopy
import math
import pytest
from backend.description_schema import migrate_description_document
from backend.description_amount import normalize_description_amount
from backend.composition_export import corrected_record
from backend.composition_schema import validate_composition
from backend.tests.test_composition_schema import composition, CONTENT


def bounded(value, endpoint="closed", **extra):
    return dict(amount_comparator="range", amount_unit="wt%", amount_lower_value=value,
                amount_upper_value=value, amount_lower_endpoint_type=endpoint,
                amount_upper_endpoint_type=endpoint, **extra)


@pytest.mark.parametrize("endpoint,comparator", [("closed", "equal"), ("approx", "approximate")])
def test_single_preserves_value_qualifier_unit_and_evidence(endpoint, comparator):
    value = bounded(0.015, endpoint, evidence_spans=[{"start": 2, "end": 4, "evidence_text": "Cu"}], preferred_order=2)
    original = deepcopy(value)
    normalized = normalize_description_amount(value)
    assert normalized == {"amount_comparator": comparator, "amount_unit": "wt%", "amount_value": 0.015,
                          "preferred_order": 2, "evidence_spans": original["evidence_spans"]}
    assert normalize_description_amount(deepcopy(normalized)) == normalized


def test_zero_alignment_preserves_ranges_blanks_links_decisions_and_history():
    comp = composition(); comp.pop("claim_no")
    comp["constituents"] = [
        {"constituent_name": "C", "constituent_status": None, **bounded(0)},
        {"constituent_name": "Si", "constituent_status": "optional", **bounded(0), "amount_upper_value": 2},
        {"constituent_name": "Fe", "constituent_status": "included", "amount_comparator": None},
        {"constituent_name": "Mn", "constituent_status": None, "amounts": [
            {"preferred_order": 0, "amount_comparator": None, "evidence_spans": []},
            {"preferred_order": 1, **bounded(0, "approx"), "evidence_spans": comp["evidence_spans"]}]}]
    comp["inherits_from"] = 3
    comp["constraints"] = [{"constraint_id": "r", "mode": "ratio", "member_refs": ["C", "Si"], "ratio_values": [1, 2]}]
    doc = dict(meta={"source_type": "patent", "section": "description"}, revision=42, status="submitted", finalized_revision=42,
               compositions=[dict(id="manual-7", origin="human", decision="edited", deleted=False, data=comp)],
               baseline={"compositions": [deepcopy(comp)]}, events=[{"action": "submit", "revision": 42}])
    before = deepcopy(doc); migrated = migrate_description_document(doc)
    assert doc == before
    assert {k: v for k, v in migrated.items() if k not in {"compositions", "baseline"}} == {k: v for k, v in before.items() if k not in {"compositions", "baseline"}}
    item = migrated["compositions"][0]
    assert {k: v for k, v in item.items() if k != "data"} == {k: v for k, v in before["compositions"][0].items() if k != "data"}
    data = item["data"]
    assert data["inherits_from"] == 3 and data["evidence_spans"] == comp["evidence_spans"] and data["constraints"] == comp["constraints"]
    assert data["constituents"][0]["constituent_status"] == "included"
    assert data["constituents"][1] == comp["constituents"][1]
    assert data["constituents"][2] == comp["constituents"][2]
    assert data["constituents"][3]["constituent_status"] == "included"
    assert data["constituents"][3]["amounts"][0] == comp["constituents"][3]["amounts"][0]
    assert migrated["baseline"]["compositions"][0] == data
    assert migrate_description_document(migrated) == migrated
    claims = deepcopy(before); claims["meta"]["section"] = "claim"
    assert migrate_description_document(claims) == claims


@pytest.mark.parametrize("bad", [dict(amount_comparator="equal"), dict(amount_comparator="equal", amount_value="0"),
                                dict(amount_comparator="equal", amount_value=math.nan), dict(amount_comparator="equal", amount_value=-1),
                                dict(amount_comparator="equal", amount_value=1, amount_lower_value=1),
                                dict(amount_comparator="range", amount_value=2, amount_lower_value=1)])
def test_description_rejects_invalid_scalar_and_mixed_shapes(bad):
    with pytest.raises(ValueError): normalize_description_amount(bad)


def test_description_saves_and_exports_scalar_but_claims_keep_equal_bounds():
    comp = composition(); comp["constituents"][0].update(bounded(0)); comp["constituents"][0]["constituent_status"] = None; comp.pop("claim_no")
    saved = validate_composition(comp, CONTENT, require_constraint_evidence=False)
    assert saved["constituents"][0]["amount_comparator"] == "equal" and saved["constituents"][0]["amount_value"] == 0
    assert saved["constituents"][0]["constituent_status"] == "included"
    assert not any(k in saved["constituents"][0] for k in ("amount_lower_value", "amount_upper_value"))
    claim = composition(); claim["constituents"][0].update(bounded(0))
    assert validate_composition(claim, CONTENT) == claim
    doc = dict(meta={"source_type": "patent", "section": "description"}, source_quality={}, baseline={"compositions": []}, compositions=[{"data": comp}])
    assert corrected_record(doc)["compositions"][0] == saved
