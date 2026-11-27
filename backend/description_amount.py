"""Canonical amount storage for Patent Descriptions; Claims retain their format."""
import math

BOUND_FIELDS = ("amount_lower_value", "amount_upper_value", "amount_lower_endpoint_type", "amount_upper_endpoint_type")
EXACT = {"equal", "="}
APPROXIMATE = {"approximate", "approx", "~"}


def _number(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


def single_amount(amount):
    """Read scalar and historical equal-bound singles without inventing values."""
    comparator = amount.get("amount_comparator")
    if comparator in EXACT | APPROXIMATE and _number(amount.get("amount_value")):
        return ("equal" if comparator in EXACT else "approximate", amount["amount_value"])
    lower, upper = amount.get("amount_lower_value"), amount.get("amount_upper_value")
    endpoint = amount.get("amount_lower_endpoint_type")
    if (comparator == "range" and _number(lower) and lower == upper
            and endpoint == amount.get("amount_upper_endpoint_type") and endpoint in {"closed", "approx"}):
        return ("equal" if endpoint == "closed" else "approximate", lower)
    return None


def normalize_description_amount(amount):
    validate_description_amount(amount)
    single = single_amount(amount)
    if single is not None:
        amount["amount_comparator"], amount["amount_value"] = single
        for field in BOUND_FIELDS:
            amount.pop(field, None)
    elif amount.get("amount_value") is None:
        amount.pop("amount_value", None)
    return amount


def normalize_description_composition(composition):
    """Mutate only amount representation and reported-zero constituent inclusion."""
    for row in composition.get("constituents", []):
        amounts = row.get("amounts", [row])
        for amount in amounts:
            normalize_description_amount(amount)
        if any((single := single_amount(amount)) is not None and single[1] == 0 for amount in amounts):
            row["constituent_status"] = "included"
    for rule in composition.get("constraints", []):
        if rule.get("mode") != "ratio":
            normalize_description_amount(rule)
    return composition


def validate_description_amount(amount, path="amount"):
    comparator = amount.get("amount_comparator")
    if comparator in EXACT | APPROXIMATE:
        if not _number(amount.get("amount_value")) or amount["amount_value"] < 0:
            raise ValueError(f"{path}: Single value must be a finite non-negative number")
        if any(amount.get(field) is not None for field in BOUND_FIELDS):
            raise ValueError(f"{path}: Single value cannot also carry bounds or endpoints")
    elif amount.get("amount_value") is not None:
        raise ValueError(f"{path}: amount_value requires a Single comparator")
