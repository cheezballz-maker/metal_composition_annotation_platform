import React from "react";
import { Plus } from "lucide-react";
import type { ReviewConstraint, ReviewConstituent } from "./types";
import { ratioBase, ratioIntervals, ratioIntervalText, toggleRatioMember } from "./ratios";

export function AddRestrictionButtons({onAdd}:{onAdd:(ratio?:boolean)=>void}) {
  return <span className="review-add-restrictions"><button type="button" onClick={()=>onAdd()}><Plus size={13}/>Add restriction</button><button type="button" onClick={()=>onAdd(true)}><Plus size={13}/>Add ratio</button></span>;
}
export function RatioSummary({row,constituents}:{row:ReviewConstraint;constituents:ReviewConstituent[]}) {
  try {const values=ratioIntervals(row,constituents);return <><strong>Constituent ratio · {row.ratio_values===undefined?"Calculated":"Entered"}</strong><span className="review-ratio-equation">{row.member_refs?.join(" : ")} = {values.map(ratioIntervalText).join(" : ")}</span></>;}catch(error){return <><strong>Constituent ratio</strong><span>{row.member_refs?.join(" : ")}</span><small className="review-inline-error">{error instanceof Error?error.message:"Unavailable ratio"}</small></>;}
}
export function DescriptionRatioEditor({row,constituents,onChange}:{row:ReviewConstraint;constituents:ReviewConstituent[];onChange:(next:ReviewConstraint)=>void}) {
  const refs=row.member_refs || [],entered=row.ratio_values!==undefined;
  const cache=React.useRef(new Map<string,number|string|[number|string,number|string]>());
  if(entered)refs.forEach((name,i)=>cache.current.set(name,row.ratio_values![i] ?? ""));
  const names=[...new Set(constituents.map(c=>c.constituent_name))].sort((a,b)=>a.localeCompare(b,"en",{sensitivity:"base"}));
  const switchInput=(manual:boolean)=>onChange(manual?{...row,ratio_values:refs.map(name=>cache.current.get(name)??"")}:{...row,ratio_values:undefined});
  const valueChange=(index:number,value:number|string|[number|string,number|string])=>{const values=[...(row.ratio_values || [])];values[index]=value;onChange({...row,ratio_values:values});};
  let error="",values:ReturnType<typeof ratioIntervals>=[];
  try {values=ratioIntervals(row,constituents);}catch(e){error=e instanceof Error?e.message:"Invalid ratio.";}
  const ranged=values.some(v=>v.lower!==v.upper);
  return <div className="review-ratio-editor"><strong>Constituent ratio</strong>
    <fieldset className="review-member-selector"><legend>Constituents · select in ratio order</legend><div className="review-member-options">{names.map(name=>{const index=refs.indexOf(name);return <label key={name}><input type="checkbox" aria-label={name} checked={index>=0} onChange={event=>{let next=toggleRatioMember(row,name,event.target.checked);if(entered && event.target.checked && index<0 && cache.current.has(name))next={...next,ratio_values:[...next.ratio_values!.slice(0,-1),cache.current.get(name)!]};onChange(next);}}/><span>{name}{index>=0 && <small className="review-ratio-order" aria-hidden="true">{index+1}</small>}</span></label>;})}</div></fieldset>
    <div className="review-ratio-input-choice" role="group" aria-label="Ratio input"><button type="button" aria-pressed={entered} onClick={()=>switchInput(true)}>Enter ratio</button><button type="button" aria-pressed={!entered} onClick={()=>switchInput(false)}>Use concentrations</button></div>
    <div className="review-ratio-values">{refs.map((name,i)=>{const value=row.ratio_values?.[i]??"",range=Array.isArray(value);return <div key={name} className="review-ratio-value"><strong>{i+1}. {name}</strong>{entered ? <><select aria-label={`${name} ratio format`} value={range?"range":"single"} onChange={event=>valueChange(i,event.target.value==="range"?[Array.isArray(value)?value[0]:value,Array.isArray(value)?value[1]:value]:Array.isArray(value)?value[0]:value)}><option value="single">Value</option><option value="range">Range</option></select>{range?<div className="review-ratio-range"><input inputMode="decimal" aria-label={`${name} lower ratio`} placeholder="Lower" value={value[0]} onChange={event=>valueChange(i,[event.target.value,value[1]])}/><span>–</span><input inputMode="decimal" aria-label={`${name} upper ratio`} placeholder="Upper" value={value[1]} onChange={event=>valueChange(i,[value[0],event.target.value])}/></div>:<input inputMode="decimal" aria-label={`${name} ratio value`} placeholder="Value" value={value} onChange={event=>valueChange(i,event.target.value)}/>}</> : <span>{(()=>{try{const base=ratioBase(constituents.find(c=>c.constituent_name===name)!);return `Base: ${ratioIntervalText(base)} ${constituents.find(c=>c.constituent_name===name)?.amounts?.find(a=>a.preferred_order===0)?.amount_unit || constituents.find(c=>c.constituent_name===name)?.amount_unit || ""}`;}catch{return "Base concentration unavailable";}})()}</span>}</div>;})}</div>
    {error ? <small className="review-ratio-guidance">{error}</small>:<div className="review-ratio-preview" aria-live="polite">{refs.join(" : ")} = {values.map(ratioIntervalText).join(" : ")}</div>}
    {!entered && <small className="review-ratio-guidance">Calculated from Base concentrations; the first selected constituent is 1.{ranged?" Bounds assume independently varying concentrations; shared-reference bounds are not independent combinations.":""}</small>}
  </div>;
}
