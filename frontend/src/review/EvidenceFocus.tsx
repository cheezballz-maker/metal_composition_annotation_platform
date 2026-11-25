import { useReviewTranslation } from "./locale";
import React from "react";
import { Crosshair } from "lucide-react";
import { resolveEvidence } from "./evidence";
import type { RawEvidence } from "./types";

export type EvidenceFocus = { value: unknown; label: string; spans: RawEvidence[] };
export const EvidenceContext = React.createContext<{
  content: string;
  focus: EvidenceFocus | null;
  show: (value: unknown, label: string, scope?: RawEvidence[]) => void;
}>({ content: "", focus: null, show: () => {} });

export function SourceLink({ value, label, scope, children }: { value: unknown; label: string; scope?: RawEvidence[]; children?: React.ReactNode }) {
  const t = useReviewTranslation();
  const { content, focus, show } = React.useContext(EvidenceContext);
  const spans = React.useMemo(() => resolveEvidence(value, content, scope), [value, content, scope]);
  if (!spans.length) return children ? <span title={t("No source range available")}>{children}</span> : null;
  return <button type="button" className="review-source-link" aria-label={`${t("Locate source")}: ${label}`} aria-pressed={focus?.value === value} title={`${t("Source fragments")}: ${spans.length}`} onClick={(event) => { event.stopPropagation(); show(value, label, scope); }}>
    {children || <><Crosshair size={13}/> {t("Source")}</>}
  </button>;
}
