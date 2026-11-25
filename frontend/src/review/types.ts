export type ReviewRole = "reviewer" | "checker" | "owner" | "admin";
export type ReviewWorkspaceInfo = {
  key: string;
  label: string;
  source_kind: string;
  dataset_id: string;
  role: ReviewRole;
  record_count: number;
};
export type ReviewStatus = "not_started" | "in_review" | "submitted" | "returned" | "finalized";
export type ReviewDecision = "pending" | "accepted" | "edited" | "deleted" | "added";
export type RawEvidence = { start: number; end: number; evidence_text: string };

export type ReviewAmount = Pick<ReviewConstituent, "amount_comparator" | "amount_unit" | "amount_value" | "amount_lower_value" | "amount_upper_value" | "amount_lower_endpoint_type" | "amount_upper_endpoint_type"> & {
  /** 0 is Base (null amounts if unstated); positive integers increase in preference. */
  preferred_order?: number;
  /** Legacy labels remain readable; unranked alternatives keep their separate role. */
  role?: "general" | "preferred" | "more_preferred" | "especially_preferred" | "alternative";
  variant_ref?: string;
  evidence_spans: RawEvidence[];
};
export type InheritanceRelation = {
  kind: "inherits_from";
  mode?: "add_only";
  base_node_no: number;
  changes: Array<{ target: "constituent" | "constraint"; ref: string; operation: "add" | "replace" | "narrow" | "exclude" }>;
  evidence_span: RawEvidence;
};

export type ReviewConstituent = {
  constituent_name: string;
  amounts?: ReviewAmount[];
  constituent_status?: string | null;
  amount_comparator?: string | null;
  amount_unit?: string | null;
  amount_value?: string | number | null;
  amount_lower_value?: string | number | null;
  amount_upper_value?: string | number | null;
  amount_lower_endpoint_type?: "open" | "closed" | "approx" | null;
  amount_upper_endpoint_type?: "open" | "closed" | "approx" | null;
  [key: string]: unknown;
};

export type ReviewConstraint = {
  constraint_id?: string;
  mode?: "sum" | "any_of" | string;
  member_refs?: string[];
  constituent_status?: string | null;
  selection?: { min?: number | string | null; max?: number | string | null };
  amount_comparator?: string | null;
  amount_lower_value?: string | number | null;
  amount_upper_value?: string | number | null;
  amount_unit?: string | null;
  amount_lower_endpoint_type?: "open" | "closed" | "approx" | null;
  amount_upper_endpoint_type?: "open" | "closed" | "approx" | null;
  evidence?: string;
  [key: string]: unknown;
};

export type ReviewCompositionData = {
  node_no?: number | string;
  inherits_from?: number;
  claim_no?: number | string | null;
  composition_name?: string;
  composition_type?: string;
  constituents?: ReviewConstituent[];
  constraints?: ReviewConstraint[];
  evidence?: RawEvidence[];
  evidence_spans?: RawEvidence[];
  unrepresented_relations?: unknown[];
  [key: string]: unknown;
};

export type ReviewComposition = {
  /** UI position in the complete document, unaffected by filtering or family grouping. */
  instance_index?: number;
  id: string;
  seed_node_no?: number | string | null;
  origin: "seed" | "added";
  decision: ReviewDecision;
  deleted?: boolean;
  data: ReviewCompositionData;
  creator?: string | null;
};

export type ReviewEvent = {
  id?: string;
  action_id?: string;
  undoes_action_id?: string;
  action: string;
  composition_id?: string | null;
  actor?: string;
  role?: string;
  reason?: string | null;
  created_at?: string | number;
  timestamp?: string | number;
  revision?: string | number;
  before?: unknown;
  after?: unknown;
  note?: string | null;
};

export type ReviewRecordSummary = {
  source_id: string;
  status: ReviewStatus;
  reviewer?: string | null;
  seeded_count?: number;
  seeded_composition_count?: number;
  retained_composition_count?: number;
  unique_composition_count?: number;
  pending_count?: number;
  accepted_count?: number;
  decision_count?: number;
  decisions?: Record<string, unknown> | number;
  total_count?: number;
  source_checked?: boolean;
  review_outcome?: string | null;
  review_reason?: string | null;
  canonical_groups?: Array<{ group_id: string; signature_sha256: string; mention_ids: string[] }>;
  ambiguous_candidate_groups?: string[][];
  warning_labels?: Array<"ocr_issue" | "ambiguous" | "source_gap">;
};

export type ReviewDocument = {
  dataset_id: string;
  source_id: string;
  revision: string | number;
  status: ReviewStatus;
  reviewer?: string | null;
  meta?: Record<string, unknown>;
  source_quality?: Record<string, unknown>;
  baseline?: unknown;
  compositions: ReviewComposition[];
  events: ReviewEvent[];
  source_checked?: boolean;
  review_outcome?: string | null;
  review_reason?: string | null;
  finalized_revision?: string | number | null;
  workflow?: { has_source_gaps?: boolean; has_blocking_source_gaps?: boolean };
  content: string;
};

export type ReviewQueuePayload = {
  enabled: boolean;
  dataset_id?: string;
  role?: ReviewRole;
  username?: string | null;
  workspace_key?: string;
  workspace_label?: string;
  source_kind?: string;
  records: ReviewRecordSummary[];
};

export type ReviewAction = "accept" | "edit" | "delete" | "add" | "restore" | "reverse" | "metadata" | "save_review" | "submit" | "return" | "finalize" | "reopen" | "admin_move_to_in_review" | "mark_done" | "request_help" | "reopen_review" | "undo";
