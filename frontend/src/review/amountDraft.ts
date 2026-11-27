import { normalizeFiniteDraft } from "./numericDraft";

export type AmountMode = "" | "single" | "range" | "balance";
export type SingleValueQualifier = "exact" | "approximate";

export interface EditableAmount {
  amount_comparator?: string | null;
  /** Scalar Single storage for Descriptions; Claims retain equal-bound edits. */
  amount_value?: string | number | null;
  amount_lower_value?: string | number | null;
  amount_upper_value?: string | number | null;
  amount_lower_endpoint_type?: "open" | "closed" | "approx" | null;
  amount_upper_endpoint_type?: "open" | "closed" | "approx" | null;
}

const legacyExactComparators = new Set(["equal", "="]);
const legacyApproximateComparators = new Set(["approximate", "approx", "~"]);

function isSingleEndpointPair(row: EditableAmount) {
  const lower = row.amount_lower_endpoint_type;
  const upper = row.amount_upper_endpoint_type;
  return (lower === "closed" && upper === "closed") || (lower === "approx" && upper === "approx");
}

function hasEqualBounds(row: EditableAmount) {
  return row.amount_lower_value === row.amount_upper_value;
}

/** Derives the editor shape without extending the persisted schema. */
export function amountMode(row: EditableAmount): AmountMode {
  if (row.amount_comparator === "balance") return "balance";
  if (legacyExactComparators.has(row.amount_comparator || "") || legacyApproximateComparators.has(row.amount_comparator || "")) return "single";
  if (row.amount_comparator === "range") return hasEqualBounds(row) && isSingleEndpointPair(row) ? "single" : "range";
  return "";
}

export function singleValueQualifier(row: EditableAmount): SingleValueQualifier {
  if (legacyApproximateComparators.has(row.amount_comparator || "")) return "approximate";
  return row.amount_lower_endpoint_type === "approx" && row.amount_upper_endpoint_type === "approx" ? "approximate" : "exact";
}

export function singleValue(row: EditableAmount): string | number | null {
  if (row.amount_comparator === "range") return row.amount_lower_value ?? null;
  return row.amount_value ?? null;
}

function singleEndpointPatch(qualifier: SingleValueQualifier): Pick<EditableAmount, "amount_lower_endpoint_type" | "amount_upper_endpoint_type"> {
  const endpoint: "approx" | "closed" = qualifier === "approximate" ? "approx" : "closed";
  return { amount_lower_endpoint_type: endpoint, amount_upper_endpoint_type: endpoint };
}

/** Switches the visible editor shape while retaining the first usable value. */
export function amountModePatch(row: EditableAmount, mode: AmountMode): Partial<EditableAmount> {
  if (mode === "single") {
    const value = singleValue(row);
    return {
      amount_comparator: "range",
      amount_value: null,
      amount_lower_value: value,
      amount_upper_value: value,
      ...singleEndpointPatch(singleValueQualifier(row)),
    };
  }
  if (mode === "range") {
    if (amountMode(row) === "single") {
      return {
        amount_comparator: "range",
        amount_value: null,
        amount_lower_value: singleValue(row),
        amount_upper_value: null,
        amount_lower_endpoint_type: row.amount_lower_endpoint_type || (singleValueQualifier(row) === "approximate" ? "approx" : "closed"),
        amount_upper_endpoint_type: null,
      };
    }
    return { amount_comparator: "range", amount_value: null };
  }
  return {
    amount_comparator: mode || null,
    amount_value: null,
    amount_lower_value: null,
    amount_upper_value: null,
    amount_lower_endpoint_type: null,
    amount_upper_endpoint_type: null,
  };
}

export function singleValuePatch(row: EditableAmount, value: string | number | null): Partial<EditableAmount> {
  return {
    amount_comparator: "range",
    amount_value: null,
    amount_lower_value: value,
    amount_upper_value: value,
    ...singleEndpointPatch(singleValueQualifier(row)),
  };
}

export function singleValueQualifierPatch(row: EditableAmount, qualifier: SingleValueQualifier): Partial<EditableAmount> {
  const value = singleValue(row);
  return {
    amount_comparator: "range",
    amount_value: null,
    amount_lower_value: value,
    amount_upper_value: value,
    ...singleEndpointPatch(qualifier),
  };
}

/** Converts numeric drafts and legacy scalar values to the existing range schema. */
export function normalizeAmountDraft(item: EditableAmount, label: string): void {
  const comparator = item.amount_comparator;
  if (legacyExactComparators.has(comparator || "") || legacyApproximateComparators.has(comparator || "")) {
    const amount = normalizeFiniteDraft(item.amount_value, `${label} amount`);
    item.amount_comparator = "range";
    item.amount_value = null;
    item.amount_lower_value = amount;
    item.amount_upper_value = amount;
    Object.assign(item, singleEndpointPatch(legacyApproximateComparators.has(comparator || "") ? "approximate" : "exact"));
    return;
  }
  if (comparator === "range") {
    const lower = normalizeFiniteDraft(item.amount_lower_value, `${label} lower amount`);
    const upper = normalizeFiniteDraft(item.amount_upper_value, `${label} upper amount`);
    if (lower != null && upper != null && lower > upper) throw new Error(`${label} lower amount cannot exceed upper amount`);
    item.amount_value = null;
    item.amount_lower_value = lower;
    item.amount_upper_value = upper;
  } else if (comparator === "balance" || comparator == null) {
    item.amount_value = null;
    item.amount_lower_value = null;
    item.amount_upper_value = null;
    item.amount_lower_endpoint_type = null;
    item.amount_upper_endpoint_type = null;
  }
}

/** Description-only Single serialization; shared Claims normalization stays unchanged. */
export function normalizeDescriptionAmount(item: EditableAmount, label: string): void {
  normalizeAmountDraft(item, label);
  if (amountMode(item) === "single") {
    const qualifier = singleValueQualifier(item);
    const value = singleValue(item);
    item.amount_comparator = qualifier === "approximate" ? "approximate" : "equal";
    item.amount_value = value;
    delete item.amount_lower_value;
    delete item.amount_upper_value;
    delete item.amount_lower_endpoint_type;
    delete item.amount_upper_endpoint_type;
  } else delete item.amount_value;
}
