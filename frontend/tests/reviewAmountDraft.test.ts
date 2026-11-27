import { amountMode, amountModePatch, normalizeAmountDraft, normalizeDescriptionAmount, singleValue, singleValuePatch, singleValueQualifier, singleValueQualifierPatch, type EditableAmount } from "../src/review/amountDraft";

function expect(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

const exactSingle: EditableAmount = {
  amount_comparator: "range",
  amount_value: null,
  amount_lower_value: 7,
  amount_upper_value: 7,
  amount_lower_endpoint_type: "closed",
  amount_upper_endpoint_type: "closed",
};
expect(amountMode(exactSingle) === "single", "equal closed bounds are edited as one value");
expect(singleValueQualifier(exactSingle) === "exact", "closed single values are exact");
expect(singleValue(exactSingle) === 7, "single value is read from the existing lower bound");

const approximateSingle: EditableAmount = { ...exactSingle, amount_lower_endpoint_type: "approx", amount_upper_endpoint_type: "approx" };
expect(amountMode(approximateSingle) === "single", "equal approximate bounds are edited as one value");
expect(singleValueQualifier(approximateSingle) === "approximate", "approximate semantics are retained");

const openRange: EditableAmount = { ...exactSingle, amount_lower_endpoint_type: "open", amount_upper_endpoint_type: "open" };
expect(amountMode(openRange) === "range", "equal open bounds remain a range");

const changedValue: EditableAmount = { ...exactSingle, ...singleValuePatch(exactSingle, "7.5") };
expect(changedValue.amount_lower_value === "7.5" && changedValue.amount_upper_value === "7.5", "one input updates both stored bounds");
normalizeAmountDraft(changedValue, "Constituent 1");
expect(Number(changedValue.amount_lower_value) === 7.5 && Number(changedValue.amount_upper_value) === 7.5, "single value bounds normalize to finite numbers");

const changedQualifier: EditableAmount = { ...exactSingle, ...singleValueQualifierPatch(exactSingle, "approximate") };
expect(changedQualifier.amount_lower_endpoint_type === "approx" && changedQualifier.amount_upper_endpoint_type === "approx", "qualifier updates both endpoints");
expect(changedQualifier.amount_lower_value === 7 && changedQualifier.amount_upper_value === 7, "qualifier changes retain the value");

const expandedRange: EditableAmount = { ...exactSingle, ...amountModePatch(exactSingle, "range") };
expect(amountMode(expandedRange) === "range", "switching to range keeps the range editor visible");
expect(expandedRange.amount_lower_value === 7 && expandedRange.amount_upper_value === null, "switching to range retains one bound for editing");

const legacyExact: EditableAmount = { amount_comparator: "equal", amount_value: "8", amount_lower_value: null, amount_upper_value: null, amount_lower_endpoint_type: null, amount_upper_endpoint_type: null };
normalizeAmountDraft(legacyExact, "Constituent 1");
expect(legacyExact.amount_comparator === "range" && legacyExact.amount_value === null, "legacy scalar storage is removed on save");
expect(legacyExact.amount_lower_value === 8 && legacyExact.amount_upper_value === 8, "legacy exact values become equal closed bounds");
expect(legacyExact.amount_lower_endpoint_type === "closed" && legacyExact.amount_upper_endpoint_type === "closed", "legacy exact values retain exact semantics");

const balance = amountModePatch(exactSingle, "balance");
expect(balance.amount_comparator === "balance" && balance.amount_lower_value === null && balance.amount_upper_value === null, "balance clears bounded values");

console.log("review amount draft tests passed");

for (const [endpoint, comparator] of [["closed", "equal"], ["approx", "approximate"]] as const) {
  const row: EditableAmount = {...exactSingle,amount_lower_value:0,amount_upper_value:0,amount_lower_endpoint_type:endpoint,amount_upper_endpoint_type:endpoint};
  normalizeDescriptionAmount(row,"Mn");
  expect(row.amount_comparator===comparator && row.amount_value===0,"description Single retains zero and its qualifier");
  expect(!("amount_lower_value" in row) && !("amount_upper_endpoint_type" in row),"description Single omits interval fields");
  expect(amountMode(row)==="single" && singleValue(row)===0,"canonical Single reloads in Single editor");
  const edited={...row,...singleValuePatch(row,"2.5")};normalizeDescriptionAmount(edited,"Mn");
  expect(edited.amount_value===2.5 && edited.amount_comparator===comparator,"canonical Single remains scalar after an edit");
  const range={...row,...amountModePatch(row,"range")};normalizeDescriptionAmount(range,"Mn");
  expect(range.amount_comparator==="range" && range.amount_lower_value===0 && range.amount_upper_value===null && !("amount_value"in range),"switching Single to range retains its lower zero");
}
