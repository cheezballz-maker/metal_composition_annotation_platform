import type { InheritanceRelation, RawEvidence, ReviewAmount, ReviewComposition, ReviewCompositionData, ReviewConstituent } from "./types";
import { normalizeAmountDraft } from "./amountDraft";

const amountFields = ["amount_comparator", "amount_unit", "amount_value", "amount_lower_value", "amount_upper_value", "amount_lower_endpoint_type", "amount_upper_endpoint_type"] as const;

export function preferredRangeLabel(amount: ReviewAmount): string {
  if (amount.preferred_order != null) return amount.preferred_order === 0 ? "Base" : `Preferred range ${amount.preferred_order}`;
  return amount.role === "general" || !amount.role ? "Base" : amount.role.split("_").join(" ");
}

/** A missing Base is a placeholder, not an asserted source concentration. */
export function emptyBaseAmount(): ReviewAmount {
  return { ...Object.fromEntries(amountFields.map(key => [key, null])), preferred_order: 0, evidence_spans: [] };
}

/** Convert a constituent only when its ranges are edited; never invent a general value. */
export function descriptionAmounts(row: ReviewConstituent, evidence: RawEvidence[]): ReviewAmount[] {
  if (!row.amounts) {
    const fields = Object.fromEntries(amountFields.filter(key => row[key] !== undefined).map(key => [key, row[key]]));
    if (row.amount_comparator == null && [row.amount_value, row.amount_lower_value, row.amount_upper_value].every(v => v == null || v === "")) return [emptyBaseAmount()];
    return [{ ...fields, preferred_order: 0, evidence_spans: evidence.map(span => ({ ...span })) }];
  }
  const legacyOrder = { general: 0, preferred: 1, more_preferred: 2, especially_preferred: 3 };
  const amounts = row.amounts.map(amount => {
    if (amount.preferred_order != null || amount.role === "alternative") return { ...amount };
    const { role, ...rest } = amount;
    return { ...rest, preferred_order: legacyOrder[role as keyof typeof legacyOrder] ?? 0 };
  });
  amounts.sort((a, b) => (a.preferred_order ?? Infinity) - (b.preferred_order ?? Infinity));
  if (amounts.some(a => (a.preferred_order ?? 0) > 0) && !amounts.some(a => a.preferred_order === 0)) amounts.unshift(emptyBaseAmount());
  return renumberPreferredRanges(amounts);
}

export function renumberPreferredRanges(amounts: ReviewAmount[]): ReviewAmount[] {
  let order = 0;
  return amounts.map(amount => amount.preferred_order == null || amount.preferred_order === 0 ? { ...amount } : { ...amount, preferred_order: ++order });
}

/** Range edits replace scalar amount fields; other constituent metadata is retained. */
export function constituentWithAmounts(row: ReviewConstituent, amounts: ReviewAmount[]): ReviewConstituent {
  const next = { ...row };
  for (const key of amountFields) delete next[key];
  const withBase = amounts.some(a => (a.preferred_order ?? 0) > 0) && !amounts.some(a => a.preferred_order === 0) ? [emptyBaseAmount(), ...amounts] : amounts;
  return { ...next, amounts: renumberPreferredRanges(withBase) };
}

export function movePreferredRange(amounts: ReviewAmount[], from: number, to: number): ReviewAmount[] {
  if (from === to || (amounts[from]?.preferred_order ?? 0) <= 0 || (amounts[to]?.preferred_order ?? 0) <= 0) return amounts;
  const next = [...amounts];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return renumberPreferredRanges(next);
}

/** Prepare only the constituent being saved; empty preferred rows fail before a request. */
export function prepareDescriptionConstituent(row: ReviewConstituent, evidence: RawEvidence[]): ReviewConstituent {
  const next = JSON.parse(JSON.stringify(row)) as ReviewConstituent;
  if (!next.amounts) { normalizeAmountDraft(next, next.constituent_name || "Constituent"); return next; }
  const amounts = descriptionAmounts(next, evidence).map(amount => {
    const label = `${preferredRangeLabel(amount)} for ${next.constituent_name || "constituent"}`;
    normalizeAmountDraft(amount, label);
    const hasValue = [amount.amount_value, amount.amount_lower_value, amount.amount_upper_value].some(v => v != null && v !== "");
    if (amount.preferred_order === 0 && amount.amount_comparator !== "balance" && !hasValue) return emptyBaseAmount();
    if (amount.amount_comparator == null || (amount.amount_comparator !== "balance" && !hasValue)) throw new Error(`${label}: enter a value or at least one bound.`);
    if (!amount.evidence_spans.length) throw new Error(`${label}: attach composition evidence before saving.`);
    return amount;
  });
  return constituentWithAmounts(next, amounts);
}

/** Reference choices only: inherited quantities are never copied into the saved child. */
export function inheritedConstituents(data: ReviewCompositionData, bases: ReviewComposition[]): ReviewConstituent[] {
  const seen = new Set<number>();
  const rows = new Map<string, ReviewConstituent>();
  const collect = (current: ReviewCompositionData) => {
    for (const raw of current.unrepresented_relations || []) {
      const link = raw as InheritanceRelation;
      if (link.kind !== "inherits_from" || seen.has(link.base_node_no)) continue;
      seen.add(link.base_node_no);
      const base = bases.find(b => Number(b.data.node_no) === link.base_node_no);
      if (!base) continue;
      collect(base.data);
      for (const row of base.data.constituents || []) rows.set(row.constituent_name, row);
    }
  };
  collect(data);
  for (const row of data.constituents || []) rows.delete(row.constituent_name);
  return [...rows.values()];
}

/** Draft suggestions only. A reviewer confirms the relationship and operation. */
export function suggestedInheritanceChanges(data: ReviewCompositionData, base: ReviewComposition, bases: ReviewComposition[]): InheritanceRelation["changes"] {
  const effective = (current: ReviewCompositionData, seen = new Set<number>()): ReviewCompositionData => {
    const rows = new Map<string, ReviewConstituent>();
    const constraints = new Map<string, NonNullable<ReviewCompositionData["constraints"]>[number]>();
    for (const raw of current.unrepresented_relations || []) {
      const link = raw as InheritanceRelation;
      if (link.kind !== "inherits_from" || seen.has(link.base_node_no)) continue;
      seen.add(link.base_node_no);
      const parent = bases.find(b => Number(b.data.node_no) === link.base_node_no);
      if (!parent) continue;
      const inherited = effective(parent.data, seen);
      inherited.constituents?.forEach(row => rows.set(row.constituent_name, row));
      inherited.constraints?.forEach(row => constraints.set(String(row.constraint_id), row));
    }
    current.constituents?.forEach(row => rows.set(row.constituent_name, row));
    current.constraints?.forEach(row => constraints.set(String(row.constraint_id), row));
    return {...current, constituents: [...rows.values()], constraints: [...constraints.values()]};
  };
  const signature = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(signature).join(",")}]`;
    if (value && typeof value === "object") return JSON.stringify(Object.entries(value).filter(([key]) => !["evidence", "evidence_spans", "evidence_text", "start", "end"].includes(key)).sort(([a],[b]) => a.localeCompare(b)).map(([key,v]) => [key,signature(v)]));
    return JSON.stringify(value);
  };
  const inherited = effective(base.data);
  const result: InheritanceRelation["changes"] = [];
  for (const target of ["constituent", "constraint"] as const) {
    const key = target === "constituent" ? "constituents" : "constraints";
    const refKey = target === "constituent" ? "constituent_name" : "constraint_id";
    for (const row of data[key] || []) {
      const ref = String(row[refKey] || "");
      if (!ref) continue;
      const prior = inherited[key]?.find(item => item[refKey] === ref);
      if (!prior || signature(prior) !== signature(row)) result.push({ target, ref, operation: prior ? row.constituent_status === "excluded" ? "exclude" : "replace" : "add" });
    }
  }
  return result;
}
