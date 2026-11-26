from __future__ import annotations

from copy import deepcopy
import math
from typing import Any, Iterator
from .description_ratio import validate_ratio
from .description_schema import inherited_references, validate_description_extensions


SPAN_FIELDS = frozenset({"start", "end", "evidence_text"})
ENDPOINT_TYPES = frozenset({"open", "closed", "approx"})
AMOUNT_COMPARATORS = frozenset(
    {
        "range",
        "balance",
        "equal",
        "greater_than",
        "greater_than_or_equal",
        "less_than",
        "less_than_or_equal",
        "approximate",
        "approx",
        "=",
        ">",
        ">=",
        "<",
        "<=",
        "~",
    }
)
CONSTITUENT_STATUSES = frozenset({"included", "excluded", "optional"})
CONSTRAINT_MODES = frozenset({"sum", "any_of"})


def _require_dict(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def _require_list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise ValueError(f"{label} must be an array")
    return value


def _require_string(value: Any, label: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        raise ValueError(f"{label} must be a non-empty string")
    return value


def iter_evidence_spans(value: Any, path: str = "$.") -> Iterator[tuple[str, dict[str, Any]]]:
    if isinstance(value, dict):
        present = SPAN_FIELDS.intersection(value)
        if present:
            missing = SPAN_FIELDS.difference(value)
            if missing:
                raise ValueError(f"{path} has an incomplete evidence span; missing {sorted(missing)}")
            yield path, value
            return
        for key, item in value.items():
            yield from iter_evidence_spans(item, f"{path}{key}.")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from iter_evidence_spans(item, f"{path}[{index}].")


def _validate_span(span: dict[str, Any], content: str, path: str) -> None:
    start = span["start"]
    end = span["end"]
    evidence_text = span["evidence_text"]
    if isinstance(start, bool) or not isinstance(start, int):
        raise ValueError(f"{path}start must be an integer")
    if isinstance(end, bool) or not isinstance(end, int):
        raise ValueError(f"{path}end must be an integer")
    if start < 0 or end <= start or end > len(content):
        raise ValueError(f"{path} range [{start}, {end}) is outside the source content")
    if not isinstance(evidence_text, str):
        raise ValueError(f"{path}evidence_text must be a string")
    if evidence_text != content[start:end]:
        raise ValueError(f"{path}evidence_text does not equal content[{start}:{end}]")


def _validate_amount_fields(value: dict[str, Any], path: str) -> None:
    comparator = value.get("amount_comparator")
    if comparator is not None and comparator not in AMOUNT_COMPARATORS:
        raise ValueError(f"{path}amount_comparator is unsupported")
    for key in ("amount_lower_value", "amount_upper_value"):
        number = value.get(key)
        if number is not None and (
            isinstance(number, bool)
            or not isinstance(number, (int, float))
            or not math.isfinite(number)
        ):
            raise ValueError(f"{path}{key} must be a finite number or null")
    for key in ("amount_lower_endpoint_type", "amount_upper_endpoint_type"):
        endpoint = value.get(key)
        if endpoint is not None and endpoint not in ENDPOINT_TYPES:
            raise ValueError(f"{path}{key} is unsupported")
    unit = value.get("amount_unit")
    if unit is not None and (not isinstance(unit, str) or not unit.strip()):
        raise ValueError(f"{path}amount_unit must be a non-empty string or null")
    lower = value.get("amount_lower_value")
    upper = value.get("amount_upper_value")
    if lower is not None and upper is not None and lower > upper:
        raise ValueError(f"{path}amount_lower_value cannot exceed amount_upper_value")
    if lower is None and value.get("amount_lower_endpoint_type") is not None:
        raise ValueError(f"{path}amount_lower_endpoint_type requires amount_lower_value")
    if upper is None and value.get("amount_upper_endpoint_type") is not None:
        raise ValueError(f"{path}amount_upper_endpoint_type requires amount_upper_value")


def _validate_constituent(value: Any, path: str) -> None:
    constituent = _require_dict(value, path.rstrip("."))
    _require_string(constituent.get("constituent_name"), f"{path}constituent_name")
    if constituent.get("constituent_status") not in CONSTITUENT_STATUSES:
        raise ValueError(f"{path}constituent_status is unsupported")
    _validate_amount_fields(constituent, path)


def _validate_constraint(value: Any, names: set[str], path: str, *, require_evidence: bool = True) -> None:
    constraint = _require_dict(value, path.rstrip("."))
    _require_string(constraint.get("constraint_id"), f"{path}constraint_id")
    if constraint.get("mode") not in CONSTRAINT_MODES and not (not require_evidence and constraint.get("mode") == "ratio"):
        raise ValueError(f"{path}mode is unsupported")
    refs = _require_list(constraint.get("member_refs"), f"{path}member_refs")
    if not refs or any(not isinstance(ref, str) or not ref.strip() for ref in refs):
        raise ValueError(f"{path}member_refs must contain names")
    if len(set(refs)) != len(refs):
        raise ValueError(f"{path}member_refs must be unique")
    unknown = sorted(set(refs).difference(names))
    if unknown:
        raise ValueError(f"{path}member_refs contains unknown constituents: {unknown}")
    if constraint.get("mode") == "ratio":
        validate_ratio(constraint)
        return
    if constraint.get("constituent_status") not in CONSTITUENT_STATUSES:
        raise ValueError(f"{path}constituent_status is unsupported")
    selection = _require_dict(constraint.get("selection"), f"{path}selection")
    for key in ("min", "max"):
        count = selection.get(key)
        if count is not None and (isinstance(count, bool) or not isinstance(count, int) or count < 0):
            raise ValueError(f"{path}selection.{key} must be a non-negative integer or null")
    if selection.get("min") is not None and selection.get("max") is not None:
        if selection["min"] > selection["max"]:
            raise ValueError(f"{path}selection min cannot exceed max")
    if any(selection.get(key) is not None and selection[key] > len(refs) for key in ("min", "max")):
        raise ValueError(f"{path}selection cannot exceed the member count")
    _validate_amount_fields(constraint, path)
    if require_evidence:
        _require_string(constraint.get("evidence"), f"{path}evidence")
    elif "evidence" in constraint:
        raise ValueError(f"{path}evidence has been removed for descriptions")


def validate_composition(
    comp: dict[str, Any],
    content: str,
    require_evidence: bool = False,
    require_claim: bool | None = None,
    inherited_names: set[str] | None = None,
    require_constraint_evidence: bool = True,
) -> dict[str, Any]:
    composition = deepcopy(_require_dict(comp, "composition"))
    if (
        isinstance(composition.get("node_no"), bool)
        or not isinstance(composition.get("node_no"), int)
        or composition["node_no"] <= 0
    ):
        raise ValueError("composition.node_no must be a positive integer")
    claim_no = composition.get("claim_no")
    if claim_no is not None and (isinstance(claim_no, bool) or not isinstance(claim_no, (int, str))):
        raise ValueError("composition.claim_no must be an integer, string, or null")
    if (require_evidence if require_claim is None else require_claim) and (
        claim_no is None
        or (isinstance(claim_no, int) and claim_no <= 0)
        or (isinstance(claim_no, str) and not claim_no.strip())
    ):
        raise ValueError("composition.claim_no must be a positive integer or non-empty string")
    _require_string(composition.get("composition_name"), "composition.composition_name")
    _require_string(composition.get("composition_type"), "composition.composition_type")
    constituents = _require_list(composition.get("constituents"), "composition.constituents")
    for index, constituent in enumerate(constituents):
        _validate_constituent(constituent, f"composition.constituents[{index}].")
    constituent_names = [constituent["constituent_name"] for constituent in constituents]
    if len(set(constituent_names)) != len(constituent_names):
        raise ValueError("composition constituent names must be unique")
    names = set(constituent_names) | (inherited_names or set())
    constraints = _require_list(composition.get("constraints"), "composition.constraints")
    constraint_ids: set[str] = set()
    for index, constraint in enumerate(constraints):
        _validate_constraint(constraint, names, f"composition.constraints[{index}].", require_evidence=require_constraint_evidence)
        constraint_id = constraint["constraint_id"]
        if constraint_id in constraint_ids:
            raise ValueError("composition constraint IDs must be unique")
        constraint_ids.add(constraint_id)
    evidence_spans = _require_list(composition.get("evidence_spans"), "composition.evidence_spans")
    if require_evidence and not evidence_spans:
        raise ValueError("composition.evidence_spans is required")
    for index, span in enumerate(evidence_spans):
        span = _require_dict(span, f"composition.evidence_spans[{index}]")
        if set(span).intersection(SPAN_FIELDS) != SPAN_FIELDS:
            raise ValueError(f"composition.evidence_spans[{index}] must be an evidence span")
    relations = _require_list(
        composition.get("unrepresented_relations"), "composition.unrepresented_relations"
    )
    for index, relation in enumerate(relations):
        relation = _require_dict(relation, f"composition.unrepresented_relations[{index}]")
        if set(relation).intersection(SPAN_FIELDS) == SPAN_FIELDS:
            continue
        if set(relation).intersection(SPAN_FIELDS):
            raise ValueError(f"composition.unrepresented_relations[{index}] must be an evidence span")
        _require_string(relation.get("kind"), f"composition.unrepresented_relations[{index}].kind")
        if not require_constraint_evidence and relation.get("kind") == "source_note" and "description" in relation:
            _require_string(relation["description"], f"composition.unrepresented_relations[{index}].description")
            if "evidence_span" not in relation:
                continue
        span = _require_dict(
            relation.get("evidence_span"),
            f"composition.unrepresented_relations[{index}].evidence_span",
        )
        if set(span).intersection(SPAN_FIELDS) != SPAN_FIELDS:
            raise ValueError(
                f"composition.unrepresented_relations[{index}].evidence_span must be an evidence span"
            )
    for path, span in iter_evidence_spans(composition, "composition."):
        _validate_span(span, content, path)
    return composition


def validate_record(record: dict[str, Any], content: str) -> dict[str, Any]:
    if not isinstance(content, str):
        raise ValueError("content must be a string")
    validated = deepcopy(_require_dict(record, "record"))
    meta = _require_dict(validated.get("meta"), "record.meta")
    for key in ("source_type", "source_id", "section"):
        _require_string(meta.get(key), f"record.meta.{key}")
    is_description = meta.get("section") == "description"
    if is_description:
        if meta.get("source_type") != "patent":
            raise ValueError("description record.meta.source_type must be patent")
        if "source_sha256" in meta:
            raise ValueError("description record.meta.source_sha256 must be omitted")
    compositions = _require_list(validated.get("compositions"), "record.compositions")
    node_numbers: set[int] = set()
    for index, composition in enumerate(compositions):
        if is_description and isinstance(composition, dict) and "claim_no" in composition:
            raise ValueError(f"record.compositions[{index}].claim_no must be omitted for descriptions")
        checked = validate_composition(composition, content, inherited_names=inherited_references(composition, compositions) if is_description else None, require_constraint_evidence=not is_description)
        node_no = checked["node_no"]
        if node_no in node_numbers:
            raise ValueError(f"record.compositions[{index}].node_no is duplicated")
        node_numbers.add(node_no)
    if is_description:
        validate_description_extensions(compositions, content, _validate_amount_fields, _validate_span)
    elif any("inherits_from" in comp for comp in compositions) or any("amounts" in item for comp in compositions for item in comp["constituents"]) or any(
        relation.get("kind") == "inherits_from" for comp in compositions for relation in comp["unrepresented_relations"]
    ):
        raise ValueError("Multiple amounts and inherits_from are supported only for descriptions")
    source_quality = _require_dict(validated.get("source_quality"), "record.source_quality")
    for key in ("table_presence", "table_quality"):
        _require_string(source_quality.get(key), f"record.source_quality.{key}")
    for key in ("gaps", "corrections"):
        spans = _require_list(source_quality.get(key), f"record.source_quality.{key}")
        for index, span in enumerate(spans):
            span = _require_dict(span, f"record.source_quality.{key}[{index}]")
            if set(span).intersection(SPAN_FIELDS) != SPAN_FIELDS:
                raise ValueError(f"record.source_quality.{key}[{index}] must be an evidence span")
    for path, span in iter_evidence_spans(source_quality, "record.source_quality."):
        _validate_span(span, content, path)
    return validated
