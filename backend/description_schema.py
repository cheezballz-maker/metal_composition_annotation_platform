"""Optional description extensions. Existing scalar annotations remain valid."""
import math
from copy import deepcopy
from decimal import Decimal

AMOUNT_FIELDS = (
    "amount_comparator", "amount_unit", "amount_value", "amount_lower_value",
    "amount_upper_value", "amount_lower_endpoint_type", "amount_upper_endpoint_type",
)
AMOUNT_ROLES = {"general", "preferred", "more_preferred", "especially_preferred", "alternative"}
CHANGE_OPERATIONS = {"add", "replace", "narrow", "exclude"}


def inheritance_base(comp: dict):
    if "inherits_from" in comp:
        return comp["inherits_from"]
    return next((link.get("base_node_no") for link in comp.get("unrepresented_relations", []) if isinstance(link, dict) and link.get("kind") == "inherits_from"), None)


def lean_inheritance(comp: dict) -> dict:
    """Convert compatible old links; preserve every other field and source span."""
    result = deepcopy(comp)
    links = [r for r in result.get("unrepresented_relations", []) if isinstance(r, dict) and r.get("kind") == "inherits_from"]
    if not links:
        return result
    if len(links) != 1:
        raise ValueError("Use one inherits_from base per composition")
    link = links[0]
    if link.get("mode") not in {None, "add_only"} or any(c.get("operation") != "add" for c in link.get("changes", [])):
        # Retain historical non-additive data rather than reinterpret it.
        return result
    if "inherits_from" in result and result["inherits_from"] != link.get("base_node_no"):
        raise ValueError("Conflicting inheritance bases")
    result["inherits_from"] = link.get("base_node_no")
    result["unrepresented_relations"] = [r for r in result.get("unrepresented_relations", []) if r is not link]
    evidence = link.get("evidence_span")
    if isinstance(evidence, dict) and not any(s.get("start") == evidence.get("start") and s.get("end") == evidence.get("end") for s in result.get("evidence_spans", [])):
        result.setdefault("evidence_spans", []).append(deepcopy(evidence))
    return result


def clean_description_composition(comp: dict) -> dict:
    """Remove retired restriction quotations without touching composition evidence."""
    result = lean_inheritance(comp)
    for rule in result.get("constraints", []):
        rule.pop("evidence", None)
    return result


def migrate_description_document(document: dict) -> dict:
    """Migrate current/baseline compositions only; audit events stay immutable."""
    result = deepcopy(document)
    if result.get("meta", {}).get("section") != "description":
        return result
    for item in result.get("compositions", []):
        item["data"] = clean_description_composition(item["data"])
    for comp in result.get("baseline", {}).get("compositions", []):
        converted = clean_description_composition(comp)
        comp.clear()
        comp.update(converted)
    return result


def _validate_additive_totals(comp: dict, compositions: list[dict]) -> None:
    """Reject only provably impossible percentage totals; never rebalance amounts."""
    by_node = {row["node_no"]: row for row in compositions}
    seen = set()
    rows = {}

    def collect(current):
        if current["node_no"] in seen:
            return
        seen.add(current["node_no"])
        parent = inheritance_base(current)
        if isinstance(parent, int) and parent in by_node:
            collect(by_node[parent])
        rows.update({row["constituent_name"]: row for row in current["constituents"]})

    collect(comp)
    totals = {}
    open_bounds = set()
    balances = 0
    for row in rows.values():
        if row.get("constituent_status") != "included":
            continue
        amount = row
        if "amounts" in row:
            amount = next((a for a in row["amounts"] if a.get("preferred_order") == 0 or a.get("role") == "general"), {})
        comparator = amount.get("amount_comparator")
        if comparator == "balance":
            balances += 1
            continue
        unit = str(amount.get("amount_unit") or "").lower().replace(" ", "").replace(".", "")
        basis = "mass" if unit in {"wt%", "weight%", "mass%"} else "atomic" if unit in {"at%", "atomic%", "mol%", "molar%"} else None
        if basis is None:
            continue
        if comparator in {"equal", "="}:
            lower = amount.get("amount_value")
        elif comparator == "range" and amount.get("amount_lower_endpoint_type") in {"closed", "open"}:
            lower = amount.get("amount_lower_value")
        else:
            continue
        if lower is None:
            continue
        totals[basis] = totals.get(basis, Decimal(0)) + Decimal(str(lower))
        if amount.get("amount_lower_endpoint_type") == "open":
            open_bounds.add(basis)
    if balances > 1:
        raise ValueError("Add-only inheritance cannot introduce a second balance constituent")
    if any(total > 100 or (total == 100 and basis in open_bounds) for basis, total in totals.items()):
        raise ValueError("The inherited composition and additions exceed 100%; base concentrations cannot be adjusted in add-only inheritance")


def inherited_references(comp: dict, compositions: list[dict], key: str = "constituents") -> set[str]:
    """Collect ancestor field names without changing or expanding stored annotations.

    Missing bases and cycles are rejected by record validation, after shape checks.
    """
    field = "constituent_name" if key == "constituents" else "constraint_id"
    if not isinstance(comp, dict):
        return set()
    relations = comp.get("unrepresented_relations", [])
    has_legacy = isinstance(relations, list) and any(isinstance(r, dict) and r.get("kind") == "inherits_from" for r in relations)
    if "inherits_from" not in comp and not has_legacy:
        return set()
    by_node = {c.get("node_no"): c for c in compositions if isinstance(c, dict) and isinstance(c.get("node_no"), int)}
    seen = set()
    refs: set[str] = set()

    def collect(current):
        parent = current.get("inherits_from")
        if isinstance(parent, int) and not isinstance(parent, bool) and parent not in seen and parent in by_node:
            seen.add(parent)
            base = by_node[parent]
            refs.update(x[field] for x in base.get(key, []) if isinstance(x, dict) and isinstance(x.get(field), str))
            collect(base)
        relations = current.get("unrepresented_relations", [])
        for relation in relations if isinstance(relations, list) else []:
            if not isinstance(relation, dict) or relation.get("kind") != "inherits_from":
                continue
            node = relation.get("base_node_no")
            if not isinstance(node, int) or node in seen or node not in by_node:
                continue
            seen.add(node)
            base = by_node[node]
            fields = base.get(key, [])
            if isinstance(fields, list):
                refs.update(x[field] for x in fields if isinstance(x, dict) and isinstance(x.get(field), str))
            collect(base)

    collect(comp)
    return refs


def validate_description_extensions(compositions: list[dict], content: str, amount_validator, span_validator) -> None:
    by_node = {c["node_no"]: c for c in compositions}
    parents: dict[int, set[int]] = {}
    for comp in compositions:
        names = {c["constituent_name"] for c in comp["constituents"]}
        for constituent in comp["constituents"]:
            if "amounts" not in constituent:
                continue
            if any(constituent.get(field) is not None for field in AMOUNT_FIELDS):
                raise ValueError("Use either amounts or scalar amount fields, not both")
            amounts = constituent["amounts"]
            if not isinstance(amounts, list) or not amounts:
                raise ValueError("constituent.amounts must be a non-empty array")
            ordered = []
            legacy = False
            for amount in amounts:
                if not isinstance(amount, dict):
                    raise ValueError("Each amount must be an object")
                if "preferred_order" in amount:
                    order = amount["preferred_order"]
                    if isinstance(order, bool) or not isinstance(order, int) or order < 0:
                        raise ValueError("preferred_order must be a non-negative integer")
                    if "role" in amount:
                        raise ValueError("Use preferred_order without role for ranked amounts")
                    ordered.append(order)
                elif amount.get("role") not in AMOUNT_ROLES:
                    raise ValueError("Each amount requires preferred_order or a supported legacy role")
                elif amount["role"] != "alternative":
                    legacy = True
                amount_validator(amount, "constituent.amounts.")
                empty_base = amount.get("preferred_order") == 0 and all(amount.get(field) is None for field in AMOUNT_FIELDS)
                if empty_base:
                    if amount.get("evidence_spans") != []:
                        raise ValueError("An unstated Base must have empty evidence_spans")
                    continue
                if amount.get("amount_comparator") is None:
                    raise ValueError("Each amount requires amount_comparator")
                value = amount.get("amount_value")
                if value is not None and (isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value)):
                    raise ValueError("Amount value must be a finite number")
                if amount["amount_comparator"] != "balance" and all(amount.get(field) is None for field in ("amount_value", "amount_lower_value", "amount_upper_value")):
                    raise ValueError("Each quantitative amount requires a value or bound")
                variant = amount.get("variant_ref")
                if variant is not None and (not isinstance(variant, str) or not variant.strip()):
                    raise ValueError("variant_ref must be a non-empty string")
                spans = amount.get("evidence_spans")
                if not isinstance(spans, list) or not spans:
                    raise ValueError("Each amount requires evidence_spans")
                for span in spans:
                    if not isinstance(span, dict) or not {"start", "end", "evidence_text"} <= span.keys():
                        raise ValueError("Amount evidence must be a complete span")
                    span_validator(span, content, "constituent.amounts.evidence.")
            if ordered:
                if legacy:
                    raise ValueError("Do not mix preferred_order and legacy preference roles within a constituent")
                expected = ([0] if 0 in ordered else []) + list(range(1, sum(n > 0 for n in ordered) + 1))
                if ordered != expected:
                    raise ValueError("preferred_order must be unique, consecutive and stored from least to most preferred; general 0 is optional")
        links = [r for r in comp["unrepresented_relations"] if r.get("kind") == "inherits_from"]
        if "inherits_from" in comp:
            base = comp["inherits_from"]
            if isinstance(base, bool) or not isinstance(base, int) or base <= 0 or base not in by_node:
                raise ValueError("inherits_from requires an existing positive node_no")
            if base == comp["node_no"]:
                raise ValueError("A composition cannot inherit from itself")
            if links:
                raise ValueError("Use inherits_from without a legacy inheritance relation")
            parents.setdefault(comp["node_no"], set()).add(base)
            ancestor_names = {x["constituent_name"] for x in by_node[base]["constituents"]} | inherited_references(by_node[base], compositions)
            ancestor_ids = {x["constraint_id"] for x in by_node[base]["constraints"]} | inherited_references(by_node[base], compositions, "constraints")
            if names & ancestor_names:
                raise ValueError("Add-only inheritance cannot repeat, replace or exclude inherited constituents")
            if any(x.get("constituent_status") == "excluded" for x in comp["constituents"]):
                raise ValueError("Add-only inheritance supports added constituents, not exclusions")
            if ancestor_ids & {x["constraint_id"] for x in comp["constraints"]}:
                raise ValueError("Add-only inheritance cannot override inherited restrictions")
        if len(links) > 1:
            raise ValueError("Use one inherits_from base per composition")
        for relation in links:
            if relation.get("kind") != "inherits_from":
                continue
            base = relation.get("base_node_no")
            if isinstance(base, bool) or not isinstance(base, int) or base not in by_node:
                raise ValueError("inherits_from requires an existing base_node_no")
            if base == comp["node_no"]:
                raise ValueError("A composition cannot inherit from itself")
            parents.setdefault(comp["node_no"], set()).add(base)
            changes = relation.get("changes")
            if not isinstance(changes, list):
                raise ValueError("inherits_from requires a changes array (empty for an unchanged reference)")
            mode = relation.get("mode")
            if mode is not None and mode != "add_only":
                raise ValueError("Unsupported inheritance mode")
            if mode == "add_only":
                ancestor_names = {x["constituent_name"] for x in by_node[base]["constituents"]} | inherited_references(by_node[base], compositions)
                ancestor_constraints = {x["constraint_id"] for x in by_node[base]["constraints"]} | inherited_references(by_node[base], compositions, "constraints")
                if names & ancestor_names:
                    raise ValueError("Add-only inheritance cannot repeat, replace or exclude inherited constituents")
                if any(x.get("constituent_status") == "excluded" for x in comp["constituents"]):
                    raise ValueError("Add-only inheritance supports added constituents, not exclusions")
                if ancestor_constraints & {x["constraint_id"] for x in comp["constraints"]}:
                    raise ValueError("Add-only inheritance cannot override inherited restrictions")
                expected = {("constituent", x["constituent_name"], "add") for x in comp["constituents"]} | {("constraint", x["constraint_id"], "add") for x in comp["constraints"]}
                if any(not isinstance(x, dict) or not all(isinstance(x.get(field), str) for field in ("target", "ref", "operation")) for x in changes):
                    raise ValueError("Add-only inheritance changes require string target, ref and operation")
                actual = {(x["target"], x["ref"], x["operation"]) for x in changes}
                if len(changes) != len(expected) or actual != expected:
                    raise ValueError("Add-only inheritance changes must record each local addition exactly once")
                ancestor = by_node[base]
                seen_ancestors = set()
                while ancestor["node_no"] not in seen_ancestors:
                    seen_ancestors.add(ancestor["node_no"])
                    ancestor_links = [x for x in ancestor.get("unrepresented_relations", []) if x.get("kind") == "inherits_from"]
                    if not ancestor_links:
                        break
                    parent = ancestor_links[0]
                    if parent.get("mode") != "add_only":
                        raise ValueError("Add-only inheritance cannot extend a different inheritance type")
                    if parent.get("base_node_no") not in by_node:
                        raise ValueError("inherits_from requires an existing base_node_no")
                    ancestor = by_node[parent["base_node_no"]]
            for change in changes:
                if not isinstance(change, dict) or change.get("operation") not in CHANGE_OPERATIONS:
                    raise ValueError("Inheritance changes require a supported operation")
                target = change.get("target")
                if target not in {"constituent", "constraint"}:
                    raise ValueError("Inheritance target must be constituent or constraint")
                key = "constituents" if target == "constituent" else "constraints"
                field = "constituent_name" if target == "constituent" else "constraint_id"
                base_refs = {x[field] for x in by_node[base][key]} | inherited_references(by_node[base], compositions, key)
                child_refs = names if target == "constituent" else {x[field] for x in comp[key]}
                ref = change.get("ref")
                if not isinstance(ref, str) or ref not in base_refs | child_refs:
                    raise ValueError("Inheritance change refers to an unknown field")
                if change["operation"] != "add" and ref not in base_refs:
                    raise ValueError("Inheritance change must refer to a field in the base")
                if change["operation"] == "add" and ref in base_refs:
                    raise ValueError("Use replace or narrow for a field already in the base")
                if ref not in child_refs:
                    raise ValueError("Record the changed field in the child composition")
                if change["operation"] == "exclude" and not any(x[field] == ref and x.get("constituent_status") == "excluded" for x in comp[key]):
                    raise ValueError("An exclude change requires excluded status on the child field")
    visiting: set[int] = set()
    done: set[int] = set()

    def visit(node: int) -> None:
        if node in visiting:
            raise ValueError("Composition inheritance must not contain cycles")
        if node in done:
            return
        visiting.add(node)
        for base in parents.get(node, ()):
            visit(base)
        visiting.remove(node)
        done.add(node)

    for node in parents:
        visit(node)
    for comp in compositions:
        if "inherits_from" in comp or any(link.get("kind") == "inherits_from" and link.get("mode") == "add_only" for link in comp.get("unrepresented_relations", [])):
            _validate_additive_totals(comp, compositions)
