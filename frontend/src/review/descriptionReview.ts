import type { ReviewDocument, ReviewRecordSummary } from "./types";

export function descriptionSaveFailure(status: number | undefined, message: string): "no_change" | "revision" | "rejected" | "uncertain" {
  if (status === 409 && message === "Edit does not change the composition") return "no_change";
  if (status === 409 && message.startsWith("Revision conflict:")) return "revision";
  return status == null || status >= 500 ? "uncertain" : "rejected";
}

export function descriptionReviewState(record: Pick<ReviewDocument | ReviewRecordSummary, "status" | "review_outcome">): "not_started" | "in_review" | "needs_help" | "done" {
  if (record.review_outcome === "needs_adjudication") return "needs_help";
  if (record.status === "submitted" || record.status === "finalized") return "done";
  return record.status === "not_started" ? "not_started" : "in_review";
}

export function descriptionReviewLabel(record: Pick<ReviewDocument | ReviewRecordSummary, "status" | "review_outcome">) {
  return { not_started: "Not started", in_review: "In review", needs_help: "Flagged for review", done: "Finalized" }[descriptionReviewState(record)];
}

export function descriptionReviewLocked(record: Pick<ReviewDocument | ReviewRecordSummary, "status" | "review_outcome">): boolean {
  return record.status === "submitted" || record.status === "finalized" || record.review_outcome === "needs_adjudication";
}
