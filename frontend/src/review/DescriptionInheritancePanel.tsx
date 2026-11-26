import React from "react";
import { restrictionSelectionLabel } from "./constraintDraft";
import { RatioSummary } from "./DescriptionRatio";
import { alphabeticalConstituents } from "./descriptionNavigation";
import { UnrepresentedRestrictions, formatCompositionAmount } from "./CompositionDataView";
import { preferredRangeLabel } from "./descriptionDraft";
import { inheritanceBaseReason, inheritanceBase, inheritedInformation, instanceNumber, setInheritanceBase } from "./descriptionInheritance";
import type { ReviewComposition, ReviewCompositionData } from "./types";

export function InheritanceSelector({ data, records, onChange }: { data: ReviewCompositionData; records: ReviewComposition[]; onChange: (data: ReviewCompositionData) => void }) {
  const link = inheritanceBase(data);
  const options = records.filter(record => !record.deleted && Number(record.data.node_no) !== Number(data.node_no));
  return <label className="review-inherits-selector">Inherits from<select value={link ?? ""} onChange={event => onChange(setInheritanceBase(data, event.target.value ? Number(event.target.value) : null))}>
    <option value="">None</option>
    {options.map(record => {
      const reason = inheritanceBaseReason(data, record, records);
      return <option key={record.id} value={Number(record.data.node_no)} disabled={Boolean(reason)}>Composition Instance {instanceNumber(record)}: {record.data.composition_name}{reason ? ` — ${reason}` : ""}</option>;
    })}
  </select>{options.some(record => inheritanceBaseReason(data, record, records)?.startsWith("Already records")) && <small>Repeated constituents must be removed from this instance before it can inherit them.</small>}</label>;
}

export function InheritanceCaption({ data, records }: { data: ReviewCompositionData; records: ReviewComposition[] }) {
  const link = inheritanceBase(data);
  if (!link) return null;
  const base = records.find(record => Number(record.data.node_no) === link);
  return <p className="review-inheritance-caption">Inherits from Composition Instance {base ? instanceNumber(base) : link}: {base?.data.composition_name || "Unavailable base"}</p>;
}

/** All inherited information is plain text: no buttons, menus, links, or disclosure controls. */
export function InheritedInformation({ data, records }: { data: ReviewCompositionData; records: ReviewComposition[] }) {
  if (!inheritanceBase(data)) return null;
  const inherited = inheritedInformation(data, records);
  return <section className="review-inherited-information" aria-label="Inherited information">
    <header><strong>Inherited</strong><span>Read-only</span></header>
    {inherited.constituents.length > 0 && <div className="review-inherited-constituents" aria-label="Inherited constituents">{alphabeticalConstituents(inherited.constituents).map(({row}) => <div className="review-inherited-row" key={row.constituent_name}>
      <span><strong>{row.constituent_name}</strong><small>{row.constituent_status || "included"}</small></span>
      <span>{row.amounts ? row.amounts.map((amount, i) => <span className="review-inherited-amount" key={i}><small>{preferredRangeLabel(amount)}</small> {formatCompositionAmount(amount)}</span>) : formatCompositionAmount(row)}</span>
    </div>)}</div>}
    {(inherited.constraints.length > 0 || inherited.otherRules.length > 0) && <div className="review-inherited-restrictions" aria-label="Inherited constituent restrictions"><strong>Constituent restrictions</strong>{inherited.constraints.map(row => <div className="review-inherited-restriction" key={row.constraint_id}>{row.mode === "ratio" ? <RatioSummary row={row} constituents={[...inherited.constituents,...(data.constituents || [])]}/> : <><p>Constituents: {row.member_refs?.join(", ")}</p>{formatCompositionAmount(row) !== "—" && <p>Combined constituent concentration: {formatCompositionAmount(row)}</p>}{restrictionSelectionLabel(row) && <p>Number included: {restrictionSelectionLabel(row)}</p>}</>}</div>)}
      {inherited.otherRules.length > 0 && <UnrepresentedRestrictions values={inherited.otherRules} inherited/>}
    </div>}
    {!inherited.constituents.length && !inherited.constraints.length && !inherited.otherRules.length && <p>No inherited constituents or restrictions.</p>}
  </section>;
}
