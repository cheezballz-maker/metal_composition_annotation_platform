import { normalizeCountDraft } from "./numericDraft";
import type { ReviewCompositionData, ReviewConstraint } from "./types";

export type ConstraintDraftFieldErrors = {
  constraint_id?: string;
  member_refs?: string;
  evidence?: string;
  selection?: string;
};

export type CompositionDraftErrors = {
  constituentNames: Record<number, string>;
  constraints: Record<number, ConstraintDraftFieldErrors>;
};

function counts(values: string[]) {
  const result = new Map<string, number>();
  values.forEach((value) => result.set(value, (result.get(value) || 0) + 1));
  return result;
}

export function selectableConstituentNames(constituents: NonNullable<ReviewCompositionData["constituents"]>): string[] {
  const names = constituents.map((row) => row.constituent_name || "");
  const nameCounts = counts(names);
  return names.filter((name, index) => Boolean(name.trim()) && nameCounts.get(name) === 1 && names.indexOf(name) === index);
}

export function nextConstraintId(rows: ReviewConstraint[]): string {
  const used = new Set(rows.map((row) => row.constraint_id));
  let suffix = 1;
  while (used.has(`constraint-${suffix}`)) suffix += 1;
  return `constraint-${suffix}`;
}

export function toggleConstraintMember(refs: string[], name: string, selected: boolean): string[] {
  if (selected) return refs.includes(name) ? refs : [...refs, name];
  return refs.filter((ref) => ref !== name);
}

/** Select the legacy schema mode from explicit count edits, without rewriting untouched rules. */
export function descriptionRestrictionSelectionPatch(row: ReviewConstraint, field: "min" | "max", value: string): Partial<ReviewConstraint> {
  const selection = { ...row.selection, [field]: value.trim() ? value : null };
  const hasLimit = [selection.min, selection.max].some(count => count != null && String(count).trim() !== "");
  return { selection, mode: hasLimit ? "any_of" : "sum" };
}

export function restrictionSelectionLabel(row: ReviewConstraint): string | null {
  const min = row.selection?.min, max = row.selection?.max;
  const hasMin = min != null && String(min).trim() !== "";
  const hasMax = max != null && String(max).trim() !== "";
  if (hasMin && hasMax) return String(min) === String(max) ? String(min) : `${min}–${max}`;
  if (hasMin) return `At least ${min}`;
  if (hasMax) return `Up to ${max}`;
  return null;
}

/** Removing a constituent must not turn a shared restriction into a different rule. */
export function removeDescriptionConstituent(data: ReviewCompositionData, index: number): ReviewCompositionData {
  const constituent = data.constituents?.[index];
  if (!constituent) throw new Error("This constituent is no longer available. Reopen its editor.");
  return { ...data,
    constituents: data.constituents!.filter((_, i) => i !== index),
    constraints: (data.constraints || []).filter(rule => !rule.member_refs?.includes(constituent.constituent_name)),
  };
}

export function renameConstraintMemberRefs(rows: ReviewConstraint[], before: string, after: string): ReviewConstraint[] {
  if (!before || !after || before === after) return rows;
  return rows.map((row) => ({
    ...row,
    member_refs: (row.member_refs || []).map((ref) => ref === before ? after : ref),
  }));
}

export function validateCompositionDraft(data: ReviewCompositionData, requireConstraintEvidence = true): CompositionDraftErrors {
  const constituents = data.constituents || [];
  const constraints = data.constraints || [];
  const constituentNames = constituents.map((row) => row.constituent_name || "");
  const nameCounts = counts(constituentNames);
  const nameSet = new Set(constituentNames);
  const idCounts = counts(constraints.map((row) => row.constraint_id || ""));
  const errors: CompositionDraftErrors = { constituentNames: {}, constraints: {} };

  constituentNames.forEach((name, index) => {
    if (!name.trim()) errors.constituentNames[index] = "Constituent name is required.";
    else if ((nameCounts.get(name) || 0) > 1) errors.constituentNames[index] = "Constituent names must be unique.";
  });

  constraints.forEach((row, index) => {
    const rowErrors: ConstraintDraftFieldErrors = {};
    const id = row.constraint_id || "";
    const refs = row.member_refs || [];
    if (!id.trim()) rowErrors.constraint_id = "Constraint ID is required.";
    else if ((idCounts.get(id) || 0) > 1) rowErrors.constraint_id = "Constraint IDs must be unique.";

    if (!refs.length) rowErrors.member_refs = "Select at least one constituent.";
    else if (refs.some((ref) => !ref.trim())) rowErrors.member_refs = "Member references cannot be blank.";
    else if (new Set(refs).size !== refs.length) rowErrors.member_refs = "Constraint members must be unique.";
    else {
      const unknown = refs.filter((ref) => !nameSet.has(ref));
      if (unknown.length) rowErrors.member_refs = `Unknown constituent${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`;
    }

    if (requireConstraintEvidence && !(row.evidence || "").trim()) rowErrors.evidence = "Constraint evidence is required.";

    try {
      const min = normalizeCountDraft(row.selection?.min, `Constraint ${index + 1} minimum`);
      const max = normalizeCountDraft(row.selection?.max, `Constraint ${index + 1} maximum`);
      if (min != null && max != null && min > max) rowErrors.selection = "Minimum cannot exceed maximum.";
      else if ([min, max].some((value) => value != null && value > refs.length)) rowErrors.selection = "Selection limits cannot exceed the member count.";
    } catch (error) {
      rowErrors.selection = error instanceof Error ? error.message : "Selection limits are invalid.";
    }

    if (Object.keys(rowErrors).length) errors.constraints[index] = rowErrors;
  });

  return errors;
}

export function hasCompositionDraftErrors(errors: CompositionDraftErrors): boolean {
  return Object.keys(errors.constituentNames).length > 0 || Object.keys(errors.constraints).length > 0;
}
