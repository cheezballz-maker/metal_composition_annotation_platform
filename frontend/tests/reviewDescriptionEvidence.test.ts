import { changeInstanceSpan, instanceSpans, nudgeSpan } from "../src/review/descriptionEvidence";
import { codePointSlice } from "../src/review/rawSource";
import type { RawEvidence, ReviewCompositionData } from "../src/review/types";

function expect(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function rejects(action: () => unknown, fragment: string) { try { action(); } catch (e) { expect(String(e).includes(fragment), String(e)); return; } throw new Error("Expected protected-span deletion to fail"); }
const content = "<p>A🧪 &lt; Cu</p><p>Other evidence.</p>";
const span: RawEvidence = {start:3,end:6,evidence_text:codePointSlice(content,3,6)};
const later: RawEvidence = {start:22,end:27,evidence_text:codePointSlice(content,22,27)};
const input: ReviewCompositionData = { evidence_spans:[{...span, seed_tag:"top"} as RawEvidence,later], constituents:[{constituent_name:"Cu",constituent_status:"included",amounts:[{role:"general",amount_comparator:"range",amount_lower_value:3,amount_upper_value:20,evidence_spans:[{...span,seed_tag:"amount"} as RawEvidence]}]}] };
const original = JSON.stringify(input);
const resized = changeInstanceSpan(input,span,{...span,end:10,evidence_text:"incorrect supplied text"},content);
expect(JSON.stringify(input)===original,"Span edits must not mutate current or saved annotations");
expect(resized.evidence_spans?.[0].evidence_text===codePointSlice(content,3,10),"Evidence must be regenerated from exact code-point source bounds");
expect(resized.constituents?.[0].amounts?.[0].evidence_spans[0].end===10,"Shared references must remain aligned");
expect((resized.evidence_spans?.[0] as any).seed_tag==="top" && (resized.constituents?.[0].amounts?.[0].evidence_spans[0] as any).seed_tag==="amount","Each binding preserves its own metadata");
expect(instanceSpans(input).length===2,"Repeated physical spans are shown once");
rejects(()=>changeInstanceSpan(input,span,null,content),"only evidence for an amount");
expect(JSON.stringify(input)===original,"A blocked deletion leaves all data intact");
const removed=changeInstanceSpan({evidence_spans:[span,later]},span,null,content);
expect(removed.evidence_spans?.length===1 && removed.evidence_spans[0].start===later.start,"Deleting a span preserves other spans");
rejects(()=>changeInstanceSpan({evidence_spans:[span]},span,null,content,true),"at least one");
rejects(()=>changeInstanceSpan({unrepresented_relations:[{kind:"inherits_from",evidence_span:span}]},span,null,content),"relationship");

const emoji: RawEvidence = {start:4,end:5,evidence_text:"🧪"};
expect(nudgeSpan(content,emoji,"end",1)?.evidence_text==="🧪 ","Emoji offsets use code points, not UTF-16 units");
const entity:RawEvidence={start:6,end:10,evidence_text:"&lt;"};
expect(nudgeSpan(content,entity,"start",1)===null,"A one-character entity cannot be trimmed into an empty visible span");
expect(nudgeSpan(content,emoji,"end",1)?.end===6,"One-step resizing moves one rendered character");
expect(nudgeSpan(content,{...emoji,end:6},"end",1)?.end===10,"A decoded entity is an indivisible visible character");
const wholeParagraph:RawEvidence={start:0,end:17,evidence_text:codePointSlice(content,0,17)};
expect(nudgeSpan(content,wholeParagraph,"start",1)?.start===4,"Trimming skips opening markup and removes a visible character");
console.log("description span editing, reference protection, and Unicode boundary tests passed");
