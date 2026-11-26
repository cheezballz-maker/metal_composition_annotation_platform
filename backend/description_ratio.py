"""Lean ordered ratios for Patent Descriptions; calculated values are never stored."""
import math
import re


def _number(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value) and value >= 0


def validate_ratio(rule):
    allowed = {"constraint_id", "mode", "member_refs", "ratio_values"}
    if set(rule) - allowed:
        raise ValueError("Ratio restrictions contain only constraint_id, mode, member_refs and optional ratio_values")
    refs = rule["member_refs"]
    if len(refs) < 2:
        raise ValueError("Select at least two constituents for a ratio")
    if "ratio_values" not in rule:
        return
    values = rule["ratio_values"]
    if not isinstance(values, list) or len(values) != len(refs):
        raise ValueError("Ratio values must match the ordered constituent list")
    upper = []
    for value in values:
        if isinstance(value, list) and len(value) == 2 and all(_number(x) for x in value) and value[0] <= value[1]:
            upper.append(value[1])
        elif _number(value):
            upper.append(value)
        else:
            raise ValueError("Ratio values must be non-negative numbers or closed [lower, upper] ranges")
    if not any(x > 0 for x in upper):
        raise ValueError("A ratio cannot contain only zeros")


def effective_constituents(comp, compositions, seen=None):
    seen = set() if seen is None else set(seen)
    node = comp.get("node_no")
    if node in seen:
        return []
    seen.add(node)
    parent_no = comp.get("inherits_from")
    if parent_no is None:
        parent_no = next((link.get("base_node_no") for link in comp.get("unrepresented_relations", []) if link.get("kind") == "inherits_from"), None)
    parent = next((c for c in compositions if c.get("node_no") == parent_no), None)
    rows = {r["constituent_name"]: r for r in effective_constituents(parent, compositions, seen)} if parent else {}
    rows.update({r["constituent_name"]: r for r in comp.get("constituents", [])})
    return list(rows.values())


def concentration_unit(unit):
    key = re.sub(r"[\s._-]", "", str(unit or "").lower())
    if not key:
        raise ValueError("Base concentration units are required to calculate a ratio")
    if key in {"wt%", "weight%", "mass%", "%byweight", "%bymass", "%w/w"}:
        return "mass", 1
    if key in {"at%", "atomic%", "atom%", "%atomic", "%byatom", "%byatoms"}:
        return "atomic", 1
    if key in {"ppmbyweight", "massppm", "wtppm"}:
        return "mass", 0.0001
    if key in {"atomicppm", "atppm", "ppmbyatom", "ppmbyatoms"}:
        return "atomic", 0.0001
    return key, 1


def base_interval(row):
    if row.get("constituent_status") == "excluded":
        raise ValueError(f"{row['constituent_name']} is excluded")
    amount = row
    if "amounts" in row:
        amount = next((a for a in row["amounts"] if a.get("preferred_order") == 0 or ("preferred_order" not in a and a.get("role") == "general")), {})
    if amount.get("amount_comparator") == "balance":
        raise ValueError(f"{row['constituent_name']} has an unresolved balance")
    lo, hi = amount.get("amount_lower_value"), amount.get("amount_upper_value")
    if amount.get("amount_comparator") in {"equal", "=", "approximate", "approx", "~"}:
        lo = hi = amount.get("amount_value")
    if amount.get("amount_comparator") is None or not _number(lo) or not _number(hi) or lo > hi:
        raise ValueError(f"{row['constituent_name']} needs a finite Base value or two-sided range")
    unit, factor = concentration_unit(amount.get("amount_unit"))
    return lo * factor, hi * factor, unit


def calculate_ratio(rule, constituents):
    rows = {r["constituent_name"]: r for r in constituents}
    intervals = []
    for ref in rule["member_refs"]:
        if ref not in rows:
            raise ValueError(f"Unknown ratio constituent: {ref}")
        intervals.append(base_interval(rows[ref]))
    if len({unit for _, _, unit in intervals}) != 1:
        raise ValueError("Ratio concentrations must use compatible units")
    lo, hi, _ = intervals[0]
    if lo <= 0:
        raise ValueError("The first ratio constituent must have a strictly positive Base lower value")
    result = [(1.0, 1.0)]
    for low, high, _ in intervals[1:]:
        lower, upper = low / hi, high / lo
        if not math.isfinite(lower) or not math.isfinite(upper):
            raise ValueError("Calculated ratio exceeds the supported numeric range")
        result.append((lower, upper))
    return result
