/** Keeps partially typed numeric input intact until a committed edit is saved. */
export function normalizeFiniteDraft(value: string | number | null | undefined, label: string): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  const number = Number(trimmed);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number`);
  return number;
}

export function normalizeCountDraft(value: string | number | null | undefined, label: string): number | null {
  const number = normalizeFiniteDraft(value, label);
  if (number == null) return null;
  if (!Number.isInteger(number) || number < 0) throw new Error(`${label} must be a non-negative whole number`);
  return number;
}
