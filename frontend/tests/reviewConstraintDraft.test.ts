import {
  descriptionRestrictionSelectionPatch,
  restrictionSelectionLabel,
  hasCompositionDraftErrors,
  nextConstraintId,
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

console.log("review constraint draft tests passed");
