import { prepareRatio, ratioIntervals, ratioIntervalText, ratioProblem, isLegacyRatio, simpleRatioFromValues } from "../src/review/ratios";
import {
  descriptionRestrictionSelectionPatch,
  restrictionSelectionLabel,
  hasCompositionDraftErrors,
  nextConstraintId,
  removeDescriptionConstituent,
  renameConstraintMemberRefs,
  selectableConstituentNames,
  toggleConstraintMember,
  validateCompositionDraft,
} from "../src/review/constraintDraft";
import type { ReviewCompositionData, ReviewConstraint } from "../src/review/types";

function expect(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

const constituent = (name: string) => ({ constituent_name: name, constituent_status: "included" });
const constraint = (patch: Partial<ReviewConstraint> = {}): ReviewConstraint => ({
  constraint_id: "k1",
  mode: "any_of",
  member_refs: ["cerium", "lanthanum", "yttrium"],
  constituent_status: "included",
  selection: { min: "1", max: "3" },
  amount_comparator: "range",
  amount_unit: "%",
  amount_lower_value: "0.05",
  amount_upper_value: "0.2",
  amount_lower_endpoint_type: "closed",
  amount_upper_endpoint_type: "closed",
  evidence: "rare earth metal is one or more selected from cerium, lanthanum, and yttrium",
  ...patch,
});

const claimEight: ReviewCompositionData = {
  composition_name: "copper alloy wire",
  composition_type: "alloy",
  constituents: ["silver", "zirconium", "cerium", "lanthanum", "yttrium", "copper"].map(constituent),
  constraints: [constraint()],
};

expect(!hasCompositionDraftErrors(validateCompositionDraft(claimEight)), "claim 8 draft is valid");
expect(selectableConstituentNames(claimEight.constituents || []).join("|") === "silver|zirconium|cerium|lanthanum|yttrium|copper", "members come from exact constituent names");
expect(toggleConstraintMember(["cerium"], "lanthanum", true).join("|") === "cerium|lanthanum", "member is selected once");
expect(toggleConstraintMember(["cerium", "lanthanum"], "cerium", false).join("|") === "lanthanum", "member is removed exactly");

const punctuated = "rare earth, metal ";
expect(toggleConstraintMember([], punctuated, true)[0] === punctuated, "punctuation and whitespace are preserved");
expect(renameConstraintMemberRefs([constraint({ member_refs: ["cerium"] })], "cerium", "Cerium")[0].member_refs?.[0] === "Cerium", "valid rename propagates exactly");

expect(nextConstraintId([{ constraint_id: "constraint-1" }, { constraint_id: "constraint-3" }]) === "constraint-2", "deleted constraint IDs are reused without collision");

const invalid: ReviewCompositionData = {
  ...claimEight,
  constituents: [constituent("cerium"), constituent("cerium"), constituent("")],
  constraints: [constraint({ constraint_id: "", member_refs: ["Cerium"], evidence: "", selection: { min: "2", max: "1" } })],
};
const invalidErrors = validateCompositionDraft(invalid);
expect(Boolean(invalidErrors.constituentNames[0] && invalidErrors.constituentNames[1] && invalidErrors.constituentNames[2]), "blank and duplicate constituent names are rejected");
expect(Boolean(invalidErrors.constraints[0]?.constraint_id), "blank constraint ID is rejected");
expect(Boolean(invalidErrors.constraints[0]?.member_refs), "unknown member is rejected");
expect(Boolean(invalidErrors.constraints[0]?.evidence), "blank evidence is rejected");
const noEvidence = {...claimEight,constraints:[constraint({evidence:undefined})]};
expect(!hasCompositionDraftErrors(validateCompositionDraft(noEvidence,false)), "description restrictions can omit evidence");
expect(Boolean(validateCompositionDraft(noEvidence).constraints[0]?.evidence), "claims retain required restriction evidence");
expect(Boolean(invalidErrors.constraints[0]?.selection), "invalid selection limits are rejected");

const duplicateIdErrors = validateCompositionDraft({ ...claimEight, constraints: [constraint(), constraint()] });
expect(Boolean(duplicateIdErrors.constraints[0]?.constraint_id && duplicateIdErrors.constraints[1]?.constraint_id), "duplicate constraint IDs are rejected");
const duplicateMemberErrors = validateCompositionDraft({ ...claimEight, constraints: [constraint({ member_refs: ["cerium", "cerium"] })] });
expect(Boolean(duplicateMemberErrors.constraints[0]?.member_refs), "duplicate constraint members are rejected");

const concentrationOnly = constraint({mode:"sum",member_refs:["Cu","Ni"],selection:{min:null,max:null},amount_upper_value:5,amount_lower_value:null});
const counted = {...concentrationOnly,...descriptionRestrictionSelectionPatch(concentrationOnly,"max","1")};
expect(counted.mode === "any_of" && counted.selection?.max === "1", "adding a count sets the compatible schema mode");
expect(counted.amount_upper_value === 5 && counted.member_refs === concentrationOnly.member_refs, "count edits preserve combined amount and membership");
expect(concentrationOnly.mode === "sum" && concentrationOnly.selection?.max === null, "count edits never mutate stored rules");
const cleared = {...counted,...descriptionRestrictionSelectionPatch(counted,"max","")};
expect(cleared.mode === "sum" && cleared.selection?.max === null, "clearing the last count restores a concentration-only rule");
const zero = {...concentrationOnly,...descriptionRestrictionSelectionPatch(concentrationOnly,"max","0")};
expect(zero.mode === "any_of" && restrictionSelectionLabel(zero) === "Up to 0", "zero is a meaningful selection limit");
expect(restrictionSelectionLabel(concentrationOnly) === null, "no count is invented when the source gives none");
expect(restrictionSelectionLabel(constraint({selection:{min:1,max:2}})) === "1–2", "both bounds are shown");
expect(restrictionSelectionLabel(constraint({selection:{min:2,max:2}})) === "2", "exact count is shown once");
expect(restrictionSelectionLabel(constraint({selection:{min:1,max:null}})) === "At least 1", "minimum-only count is clear");
expect(restrictionSelectionLabel(constraint({mode:"sum",selection:{min:1,max:2}})) === "1–2", "legacy counts remain visible irrespective of mode");

const deletionInput: ReviewCompositionData = {...claimEight, inherits_from: 12, constraints:[constraint({constraint_id:"dependent",member_refs:["silver","copper"]}),constraint({constraint_id:"kept",member_refs:["cerium"]})],evidence_spans:[{start:0,end:5,evidence_text:"alloy"}],unrepresented_relations:[{kind:"complex_expression",description:"kept"}]};
const originalDeletion = JSON.stringify(deletionInput);
const deleted = removeDescriptionConstituent(deletionInput,0);
expect(deleted.constituents?.length === deletionInput.constituents!.length-1 && !deleted.constituents?.some(row=>row.constituent_name === "silver"), "deletion targets the original index, not sorted display position");
expect(deleted.constraints?.length === 1 && deleted.constraints[0] === deletionInput.constraints![1], "dependent restrictions are removed whole, unrelated restrictions are preserved exactly");
expect(deleted.inherits_from === 12 && deleted.evidence_spans === deletionInput.evidence_spans && deleted.unrepresented_relations === deletionInput.unrepresented_relations, "deletion preserves inheritance, evidence and unrepresented restrictions");
expect(JSON.stringify(deletionInput) === originalDeletion, "deletion does not mutate the confirmed record");
expect(removeDescriptionConstituent(deletionInput,1).constraints?.length === 2, "unreferenced deletion leaves restrictions intact");
let missingDeletionFailed=false;try {removeDescriptionConstituent(deletionInput,99);} catch {missingDeletionFailed=true;}
expect(missingDeletionFailed,"a stale index cannot delete an unrelated row");

const ratioRows=[{constituent_name:"A",constituent_status:"included",amount_comparator:"range",amount_unit:"wt%",amount_lower_value:2,amount_upper_value:4,amount_lower_endpoint_type:"closed" as const,amount_upper_endpoint_type:"closed" as const},{constituent_name:"B",constituent_status:"included",amount_comparator:"equal",amount_unit:"wt%",amount_value:6},{constituent_name:"C",constituent_status:"included",amount_comparator:"equal",amount_unit:"wt%",amount_value:12}];
const calculatedRatio:ReviewConstraint={constraint_id:"ratio",mode:"ratio",member_refs:["A","B","C"]};
expect(JSON.stringify(ratioIntervals(calculatedRatio,ratioRows).map(v=>[v.lower,v.upper])) === JSON.stringify([[1,1],[1.5,3],[3,6]]),"ratio range bounds cross lower/upper concentration endpoints");
expect(ratioIntervals({...calculatedRatio,ratio_values:[1,[2,3],4]},ratioRows)[1].upper===3,"entered multi-member ranges retain their supplied values");
expect(!("ratio_values" in prepareRatio(calculatedRatio)),"calculated ratios store references only");
expect(Boolean(ratioProblem({...calculatedRatio,ratio_values:[0,0,0]},ratioRows)),"all-zero entered ratios are rejected");
expect(Boolean(ratioProblem(calculatedRatio,[{...ratioRows[0],amount_lower_value:0},...ratioRows.slice(1)])),"zero reference bounds cannot be divided");
expect(Boolean(ratioProblem(calculatedRatio,[ratioRows[0],{...ratioRows[1],amount_unit:"at%"},ratioRows[2]])),"incompatible concentration units cannot be mixed");
expect(Boolean(ratioProblem(calculatedRatio,[{...ratioRows[0],amount_comparator:"balance"},...ratioRows.slice(1)])),"balance values are not invented for ratio calculations");
expect(Boolean(ratioProblem(calculatedRatio,[{...ratioRows[0],amounts:[{preferred_order:0,amount_comparator:null,evidence_spans:[]},{preferred_order:1,amount_comparator:"range",amount_lower_value:2,amount_upper_value:4,amount_unit:"wt%",evidence_spans:[]}]},...ratioRows.slice(1)])),"preferred-only concentrations cannot substitute for missing Base values");
expect(ratioIntervalText({lower:1,upper:2,lowerEndpoint:"open",upperEndpoint:"closed"})===">1 to ≤2","calculated open endpoints remain explicit");
expect(ratioIntervals(calculatedRatio,[{...ratioRows[0],amount_lower_value:"4",amount_upper_value:"4"},...ratioRows.slice(1)])[1].lower===1.5,"in-progress numeric concentration drafts remain calculable before save normalization");
expect(!hasCompositionDraftErrors(validateCompositionDraft({constituents:ratioRows,constraints:[calculatedRatio]},false)),"ratio draft validation accepts description ratios");
expect(hasCompositionDraftErrors(validateCompositionDraft({constituents:ratioRows,constraints:[calculatedRatio]})),"claims draft validation rejects description-only ratio mode");

const simpleStart:ReviewConstraint={constraint_id:"ratio",mode:"ratio",member_refs:[],ratio_values:[]};
const simpleRow=simpleRatioFromValues(simpleStart,["A","B","C"],{A:1,B:2,C:0});
expect(JSON.stringify(simpleRow.member_refs)==='["A","B"]' && JSON.stringify(simpleRow.ratio_values)==='[1,2]',"zero-valued constituents are omitted without changing the entered ratio");
expect(simpleRatioFromValues(simpleRow,["A","B","C"],{A:0,B:2,C:3}).member_refs?.join() === "B,C","clearing a value to zero removes only that member");
expect(simpleRatioFromValues(simpleRow,["A","B","C"],{A:"",B:2,C:"0.0"}).member_refs?.join() === "B","blank and numeric-zero drafts are unused markers");
expect(Boolean(ratioProblem(simpleRatioFromValues(simpleStart,["A","B"],{A:0,B:0}),ratioRows)),"all-zero input cannot be saved");
expect(Boolean(ratioProblem(simpleRatioFromValues(simpleStart,["A","B"],{A:-1,B:2}),ratioRows)),"negative values cannot be silently dropped");
expect(Boolean(ratioProblem(simpleRatioFromValues(simpleStart,["A","B"],{A:"oops",B:2}),ratioRows)),"invalid numeric text is rejected instead of being treated as zero");
expect(!isLegacyRatio(simpleRow) && !isLegacyRatio(simpleStart),"new scalar ratios use the simplified editor");
expect(isLegacyRatio(calculatedRatio) && isLegacyRatio({...calculatedRatio,ratio_values:[1,[2,3],4]}) && isLegacyRatio({...calculatedRatio,ratio_values:[0,1,2]}),"earlier calculations, intervals and explicit zero members are preserved rather than reinterpreted");

console.log("review constraint draft tests passed");
