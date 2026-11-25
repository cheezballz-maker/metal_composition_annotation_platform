from __future__ import annotations

from copy import deepcopy

import pytest

from backend.composition_schema import validate_composition, validate_record


CONTENT = "prefix <sub>2</sub> suffix"


def composition() -> dict:
    return {
        "node_no": 7,
        "claim_no": 2,
        "composition_name": "Steel",
        "composition_type": "alloy",
        "constituents": [
            {
                "constituent_name": "C",
                "constituent_status": "included",
                "amount_comparator": "range",
                "amount_unit": "%",
                "amount_lower_value": 0.1,
                "amount_lower_endpoint_type": "closed",
                "amount_upper_value": 0.2,
                "amount_upper_endpoint_type": "open",
                "seed_extension": {"kept": True},
            }
        ],
        "constraints": [],
        "evidence_spans": [
            {"start": 7, "end": 19, "evidence_text": "<sub>2</sub>", "seed_tag": "kept"}
        ],
        "unrepresented_relations": [],
        "seed_extension": [None, 0, ""],
    }


def record() -> dict:
    return {
        "meta": {
            "source_type": "patent",
            "source_id": "source-1",
            "section": "claim",
            "seed_extension": "kept",
        },
        "compositions": [composition()],
        "source_quality": {
            "table_presence": "not_applicable",
            "table_quality": "not_applicable",
            "gaps": [],
            "corrections": [],
        },
        "seed_extension": {"null": None},
    }


def test_validate_record_preserves_every_input_field_and_does_not_mutate() -> None:
    original = record()
    snapshot = deepcopy(original)
    validated = validate_record(original, CONTENT)
    assert validated == snapshot
    assert original == snapshot
    assert validated is not original


def test_description_contract_uses_patent_and_omits_claim_fields() -> None:
    candidate = record()
    candidate["meta"] = {
        "source_type": "patent",
        "source_id": "source-1",
        "section": "description",
    }
    candidate["compositions"][0].pop("claim_no")
    validate_record(candidate, CONTENT)

    wrong_source = deepcopy(candidate)
    wrong_source["meta"]["source_type"] = "patent_description"
    with pytest.raises(ValueError, match="source_type must be patent"):
        validate_record(wrong_source, CONTENT)

    hashed = deepcopy(candidate)
    hashed["meta"]["source_sha256"] = "0" * 64
    with pytest.raises(ValueError, match="source_sha256 must be omitted"):
        validate_record(hashed, CONTENT)

    claim_located = deepcopy(candidate)
    claim_located["compositions"][0]["claim_no"] = None
    with pytest.raises(ValueError, match="claim_no must be omitted"):
        validate_record(claim_located, CONTENT)


def test_raw_slice_and_nested_evidence_are_enforced() -> None:
    invalid = record()
    invalid["compositions"][0]["evidence_spans"][0]["evidence_text"] = "2"
    with pytest.raises(ValueError, match="does not equal"):
        validate_record(invalid, CONTENT)

    malformed = composition()
    malformed["evidence_spans"] = ["fake"]
    with pytest.raises(ValueError, match="must be an object"):
        validate_composition(malformed, CONTENT, require_evidence=True)

    malformed = composition()
    malformed["unrepresented_relations"] = [{"start": 7, "end": 19}]
    with pytest.raises(ValueError, match="must be an evidence span"):
        validate_composition(malformed, CONTENT)


def test_added_composition_requires_claim_and_evidence() -> None:
    added = composition()
    added["claim_no"] = "  "
    with pytest.raises(ValueError, match="claim_no"):
        validate_composition(added, CONTENT, require_evidence=True)

    added = composition()
    added["evidence_spans"] = []
    with pytest.raises(ValueError, match="evidence_spans"):
        validate_composition(added, CONTENT, require_evidence=True)


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_amounts_must_be_finite(value: float) -> None:
    invalid = composition()
    invalid["constituents"][0]["amount_lower_value"] = value
    with pytest.raises(ValueError, match="finite"):
        validate_composition(invalid, CONTENT)


def test_lower_amount_cannot_exceed_upper_amount() -> None:
    invalid = composition()
    invalid["constituents"][0]["amount_lower_value"] = 0.3
    with pytest.raises(ValueError, match="cannot exceed"):
        validate_composition(invalid, CONTENT)


def test_editor_comparator_values_are_supported() -> None:
    for comparator in ("=", ">", ">=", "<", "<=", "~", "approx", "approximate"):
        candidate = composition()
        candidate["constituents"][0]["amount_comparator"] = comparator
        validate_composition(candidate, CONTENT)


def test_ambiguous_names_constraints_and_endpoints_are_rejected() -> None:
    candidate = composition()
    candidate["constituents"].append(deepcopy(candidate["constituents"][0]))
    with pytest.raises(ValueError, match="names must be unique"):
        validate_composition(candidate, CONTENT)

    candidate = composition()
    candidate["constituents"][0]["amount_lower_value"] = None
    with pytest.raises(ValueError, match="requires amount_lower_value"):
        validate_composition(candidate, CONTENT)

    candidate = composition()
    constraint = {
        "constraint_id": "k1",
        "mode": "any_of",
        "member_refs": ["C"],
        "constituent_status": "included",
        "selection": {"min": 2, "max": 2},
        "amount_comparator": None,
        "amount_unit": None,
        "amount_lower_value": None,
        "amount_lower_endpoint_type": None,
        "amount_upper_value": None,
        "amount_upper_endpoint_type": None,
        "evidence": "C is selected",
    }
    candidate["constraints"] = [constraint]
    with pytest.raises(ValueError, match="member count"):
        validate_composition(candidate, CONTENT)
