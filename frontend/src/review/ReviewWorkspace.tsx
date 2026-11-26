import { useReviewTranslation, ReviewLocale } from "./locale";
import React from "react";
import { ArrowLeft, Check, ChevronRight, CircleAlert, FileDiff, Plus, RotateCcw, Save, Send, Undo2, X } from "lucide-react";
import { EvidenceContext, SourceLink, type EvidenceFocus } from "./EvidenceFocus";
import { descriptionRestrictionSelectionPatch, hasCompositionDraftErrors, nextConstraintId, removeDescriptionConstituent, renameConstraintMemberRefs, selectableConstituentNames, toggleConstraintMember, validateCompositionDraft, type ConstraintDraftFieldErrors } from "./constraintDraft";
import { resolveEvidence } from "./evidence";
import { JsonNode } from "./JsonNode";
import { evidencePreview, CompositionDataView, UnrepresentedRestrictions } from "./CompositionDataView";
import { RawSourceViewer } from "./RawSourceViewer";
import { DescriptionConstituents } from "./DescriptionFields";
import { DescriptionNavigator } from "./DescriptionNavigator";
import { DescriptionEvidenceSection, DescriptionSpanContext, type DescriptionSpanBridge } from "./DescriptionEvidencePanel";
import { filterOccurrences, fitDescriptionPanels, indexOccurrences, resizeDescriptionPanels, type DescriptionWidths } from "./descriptionNavigation";
import { changeInstanceSpan, instanceSpans, sameSpan } from "./descriptionEvidence";
import { prepareDescriptionConstituent } from "./descriptionDraft";
import { DescriptionReviewControls, FlagReasonPopover } from "./DescriptionReviewControls";
import { AddRestrictionButtons, DescriptionRatioEditor } from "./DescriptionRatio";
import { isLegacyRatio, prepareRatio } from "./ratios";
import { DescriptionEditableItem } from "./DescriptionEditableItem";
import { InheritanceSelector, InheritedInformation } from "./DescriptionInheritancePanel";
import { inheritedInformation, inheritanceBase, instanceNumber, prepareAddOnlyInheritance, setInheritanceBase } from "./descriptionInheritance";
import { descriptionReviewState, descriptionReviewLabel, descriptionSaveFailure, descriptionReviewLocked } from "./descriptionReview";
import { normalizeCountDraft, normalizeFiniteDraft } from "./numericDraft";
import { amountMode, amountModePatch, normalizeAmountDraft, singleValue, singleValuePatch, singleValueQualifier, singleValueQualifierPatch, type AmountMode, type EditableAmount, type SingleValueQualifier } from "./amountDraft";
import type { RawEvidence, ReviewAction, ReviewComposition, ReviewCompositionData, ReviewConstraint, ReviewDocument, ReviewQueuePayload, ReviewRecordSummary, ReviewRole, ReviewWorkspaceInfo } from "./types";

class ReviewApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }

async function reviewRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("annotation-auth-required"));
    throw new ReviewApiError(typeof payload?.detail === "string" ? payload.detail : `Request failed with status ${response.status}`, response.status);
  }
  return payload as T;
}

function unwrapDocument(value: ReviewDocument | { document?: ReviewDocument; content?: string; workflow?: ReviewDocument["workflow"] }, previousContent = ""): ReviewDocument {
  if ("document" in value && value.document) return { ...value.document, content: value.document.content || value.content || previousContent, workflow: value.document.workflow || value.workflow };
  return value as ReviewDocument;
}

function evidenceFor(data: ReviewCompositionData): RawEvidence[] {
  return ((data.evidence || data.evidence_spans || []) as RawEvidence[]).filter((span) => typeof span.start === "number" && typeof span.end === "number");
}

function newActionId() { return globalThis.crypto?.randomUUID?.() || `review-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function titleFor(composition: ReviewComposition) { return composition.data.composition_name || `Composition ${composition.seed_node_no ?? composition.id}`; }
function formatStatus(value: string) { return value.split("_").join(" "); }
function isChecker(role?: ReviewRole) { return role === "checker" || role === "owner" || role === "admin"; }
function normalizeCompositionNumericDraft(data: ReviewCompositionData, scope?: DescriptionEditScope, description = false): ReviewCompositionData {
  const next = clone(data);
  (next.constituents || []).forEach((item, index) => {
    if (scope && (scope.kind !== "constituent" || scope.index !== index)) return;
    if (description) { next.constituents![index] = prepareDescriptionConstituent(item, evidenceFor(next)); return; }
    if (item.amounts) item.amounts.forEach((amount, j) => normalizeAmountDraft(amount, `Constituent ${index + 1}, amount ${j + 1}`));
    else normalizeAmountDraft(item, `Constituent ${index + 1}`);
  });
  (next.constraints || []).forEach((item, index) => {
    if (scope && (scope.kind !== "restriction" || (scope.index != null && scope.index !== index))) return;
    if (description && item.mode === "ratio") {next.constraints![index]=prepareRatio(item);return;}
    normalizeAmountDraft(item, `Constraint ${index + 1}`);
    const selection = item.selection || {};
    const min = normalizeCountDraft(selection.min, `Constraint ${index + 1} minimum`);
    const max = normalizeCountDraft(selection.max, `Constraint ${index + 1} maximum`);
    if (min != null && max != null && min > max) throw new Error(`Constraint ${index + 1} minimum cannot exceed maximum`);
    item.selection = { ...selection, min, max };
  });
  return next;
}
type PendingRetry = { action: ReviewAction; options: { compositionId?: string; data?: unknown; reason?: string; sourceChecked?: boolean; outcome?: string; reviewReason?: string; actionId: string } };

function ReviewWorkspaceContent({ workspace, username, onChooseWorkspace, onLogout }: { workspace: ReviewWorkspaceInfo; username: string | null; onChooseWorkspace: () => void; onLogout?: () => void }) {
  const t = useReviewTranslation();
  const [queue, setQueue] = React.useState<ReviewQueuePayload | null>(null);
  const [document, setDocument] = React.useState<ReviewDocument | null>(null);
  const descriptions = workspace.source_kind === "patent_description";
  const [filter, setFilter] = React.useState<string>("all");
  const [compositionFilter, setCompositionFilter] = React.useState<"all" | "with_compositions" | "without_compositions">("all");
  const [search, setSearch] = React.useState("");
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [dirty, setDirty] = React.useState(false);
  const [selectedEvidence, setSelectedEvidence] = React.useState<RawEvidence[]>([]);
  const [retry, setRetry] = React.useState<PendingRetry | null>(null);
  const [conflict, setConflict] = React.useState<{ latest: ReviewDocument; retry: PendingRetry } | null>(null);
  const draftRef = React.useRef(false);

  const loadQueue = React.useCallback(async () => {
    setError("");
    try { setQueue(await reviewRequest<ReviewQueuePayload>(`/api/review?workspace=${encodeURIComponent(workspace.key)}`)); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : t("Could not load the review queue.")); }
  }, [workspace.key]);
  React.useEffect(() => { void loadQueue(); }, [loadQueue]);
  React.useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty || draftRef.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const openRecord = React.useCallback(async (sourceId: string) => {
    if ((dirty || draftRef.current) && !window.confirm(t("Discard unfinished review changes?"))) return;
    setError(""); setNotice(""); setSelectedEvidence([]);
    try {
      const payload = await reviewRequest<ReviewDocument | { document?: ReviewDocument }>(`/api/review/records/${encodeURIComponent(sourceId)}?workspace=${encodeURIComponent(workspace.key)}`);
      setDocument(unwrapDocument(payload)); setRetry(null); setConflict(null); setDirty(false); draftRef.current = false;
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : t("Could not open this record.")); }
  }, [dirty, workspace.key]);

  const commitAction = React.useCallback(async (action: ReviewAction, options: { compositionId?: string; data?: unknown; reason?: string; sourceChecked?: boolean; outcome?: string; reviewReason?: string; actionId?: string } = {}) => {
    if (!document) return null;
    const actionId = options.actionId || newActionId();
    setError(""); setNotice(t("Saving…"));
    try {
      const payload = await reviewRequest<ReviewDocument | { document?: ReviewDocument }>(`/api/review/records/${encodeURIComponent(document.source_id)}/actions?workspace=${encodeURIComponent(workspace.key)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          action_id: actionId, revision: Number(document.revision), action, composition_id: options.compositionId,
          data: options.data, reason: options.reason, source_checked: options.sourceChecked, review_outcome: options.outcome, review_reason: options.reviewReason
        })
      });
      const updated = unwrapDocument(payload, document.content);
      setDocument(updated); setDirty(false); draftRef.current = false; setSelectedEvidence([]); setNotice(t("Saved"));
      setRetry(null); setConflict(null);
      window.setTimeout(() => setNotice(""), 2400); void loadQueue();
      return updated;
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : t("Could not save the action.");
      const failure = document.meta?.section === "description" ? descriptionSaveFailure(requestError instanceof ReviewApiError ? requestError.status : undefined, message) : "uncertain";
      if (failure === "no_change") {
        setNotice("No changes to save."); setError(""); setRetry(null); setConflict(null); setDirty(false); draftRef.current = false;
        return document;
      }
      setNotice(""); setError(message); setRetry(null); setConflict(null);
      const pending: PendingRetry = { action, options: { ...options, actionId } };
      if (failure === "uncertain") setRetry(pending);
      if (failure === "revision" || (document.meta?.section !== "description" && requestError instanceof ReviewApiError && requestError.status === 409)) {
        try {
          const latestPayload = await reviewRequest<ReviewDocument | { document?: ReviewDocument; content?: string }>(`/api/review/records/${encodeURIComponent(document.source_id)}?workspace=${encodeURIComponent(workspace.key)}`);
          setConflict({ latest: unwrapDocument(latestPayload, document.content), retry: pending }); setError("");
        } catch { /* retain the visible draft and original conflict message */ }
      }
      return null;
    }
  }, [document, loadQueue, workspace.key]);

  const normalizedSearch = search.trim().toLowerCase();
  const queueRecords = (queue?.records || []).filter((record) => {
    const hasCompositions = (descriptions ? record.retained_composition_count ?? 0 : record.total_count ?? record.seeded_count ?? record.seeded_composition_count ?? 0) > 0;
    const matchesStatus = filter === "all" || (descriptions ? descriptionReviewState(record) : record.status) === filter;
    const matchesComposition = compositionFilter === "all" || (compositionFilter === "with_compositions" ? hasCompositions : !hasCompositions);
    const matchesSearch = !normalizedSearch || record.source_id.toLowerCase().includes(normalizedSearch);
    return matchesStatus && matchesComposition && matchesSearch;
  });
  const statusCounts = (['not_started', 'in_review', 'returned', 'submitted', 'finalized'] as const).map((status) => ({
    status,
    count: (queue?.records || []).filter((record) => record.status === status).length,
  }));
  const downloadExport = async (mode: "progress" | "final") => {
    setError("");
    try {
      const response = await fetch(`/api/review/export?mode=${mode}&workspace=${encodeURIComponent(workspace.key)}`, { credentials: "same-origin" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        if (response.status === 401) window.dispatchEvent(new Event("annotation-auth-required"));
        throw new ReviewApiError(typeof payload?.detail === "string" ? payload.detail : `Export failed with status ${response.status}`, response.status);
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") || "";
      const name = disposition.match(/filename="?([^";]+)"?/i)?.[1] || `composition-review-${mode}.zip`;
      const href = URL.createObjectURL(blob); const link = globalThis.document.createElement("a");
      link.href = href; link.download = name; link.click(); URL.revokeObjectURL(href);
      setNotice(t(mode === "final" ? "Final ZIP downloaded." : "Progress ZIP downloaded."));
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : t("Could not create the review export.")); }
  };
  if (!queue || !queue.enabled) return <main className="review-loading">
    <h1>{t("Composition review")}</h1>
    <p role={error ? "alert" : "status"}>{error || (queue ? t("No review dataset is configured. Contact the administrator.") : t("Loading composition review…"))}</p>
    {(error || queue) && <button onClick={() => void loadQueue()}>{t("Retry")}</button>}
    {onLogout && <button onClick={onLogout}>{t("Sign out")}</button>}
  </main>;

  if (!document) return <main className="review-queue-shell">
    <header className="review-queue-header"><div><button className="review-workspace-back" onClick={onChooseWorkspace}><ArrowLeft size={14}/> {t("Workspaces")}</button><h1>{t(workspace.label)}</h1><p>{!descriptions && `${queue.dataset_id || "Review dataset"} · `}{queue.username || username || "Reviewer"}</p></div><div className="review-export-controls">{descriptions ? <details className="review-export-menu"><summary>Export</summary><button onClick={() => void downloadExport("progress")}>Current annotations</button>{isChecker(queue.role) && <button disabled={queue.records.some(record => descriptionReviewState(record) !== "done")} title="Available when every document is finalized" onClick={() => void downloadExport("final")}>Completed dataset</button>}</details> : <><button onClick={() => void downloadExport("progress")}>{t("Export progress ZIP")}</button>{isChecker(queue.role) && <button className="review-primary" onClick={() => void downloadExport("final")}>{t("Export final ZIP")}</button>}</>}{onLogout && <button onClick={onLogout}>{t("Sign out")}</button>}</div></header>
    {!descriptions && <section className="review-status-counts" aria-label={t("Review status counts")}>{statusCounts.map(({ status, count }) => <div className={`review-status-count review-status-count-${status}`} key={status}><span>{t(formatStatus(status))}</span><strong>{count}</strong></div>)}</section>}
    {error && <Banner tone="error" text={error} onClose={() => setError("")}/>}
    <div className="review-queue-toolbar">
      <nav className="review-filter" aria-label={t("Review status filter")}>{(descriptions ? ["all", "not_started", "in_review", "needs_help", "done"] : ["all", "not_started", "in_review", "returned", "submitted", "finalized"]).map((status) => <button key={status} className={filter === status ? "active" : ""} onClick={() => setFilter(status)}>{descriptions ? `${({all:"All",not_started:"Not started",in_review:"In review",needs_help:"Flagged for review",done:"Finalized"} as Record<string,string>)[status]} (${queue.records.filter(r => status === "all" || descriptionReviewState(r) === status).length})` : t(formatStatus(status))}</button>)}</nav>
      <div className="review-queue-tools">
        <label className="review-composition-filter">{t("Composition filter")}<select value={compositionFilter} onChange={(event) => setCompositionFilter(event.target.value as typeof compositionFilter)} aria-label={t("Composition filter")}>
            <option value="all">{t("All patents")}</option>
            <option value="with_compositions">{t("With compositions")}</option>
            <option value="without_compositions">{t("Without compositions")}</option>
          </select>
        </label>
        <label className="review-search">{t("Search")}<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("Patent / document ID")} aria-label={t("Search patent or document identifier")} />
        </label>
      </div>
    </div>
    <section className="review-queue-list">{queueRecords.map((record, index) => <QueueRow description={descriptions} key={record.source_id} index={index + 1} record={record} checker={isChecker(queue.role)} onOpen={() => void openRecord(record.source_id)}/>)}</section>
  </main>;

  return <ReviewRecordScreen document={document} summary={queue.records.find((record) => record.source_id === document.source_id)} role={queue.role} onBack={() => { if (!(dirty || draftRef.current) || window.confirm("Discard unfinished review changes?")) { setDocument(null); setRetry(null); setConflict(null); setDirty(false); draftRef.current = false; } }} onAction={commitAction} retry={retry} conflict={conflict} onRetry={() => { if (retry) void commitAction(retry.action, retry.options); }} onRebase={() => { if (!conflict) return; setDocument(conflict.latest); setNotice("Latest version loaded. Your draft is preserved; review it and save again."); setRetry(null); setError(""); setConflict(null); }} selectedEvidence={selectedEvidence} onSelectEvidence={(span) => { setSelectedEvidence((current) => document.meta?.section === "description" ? [span] : current.some((item) => item.start === span.start && item.end === span.end) ? current : [...current, span]); setDirty(true); }} onClearSelectedEvidence={() => setSelectedEvidence([])} onDraftChange={(next) => { draftRef.current = next; setDirty(next); }} error={error} notice={t(notice)} onClearError={() => setError("")}/>;
}

function QueueRow({ index, record, checker, onOpen, description = false }: { description?: boolean; index: number; record: ReviewRecordSummary; checker: boolean; onOpen: () => void }) {
  const t = useReviewTranslation();
  const total = record.total_count ?? record.seeded_count ?? record.seeded_composition_count ?? 0;
  const decided = record.decision_count ?? (typeof record.decisions === "number" ? record.decisions : total - (record.pending_count || 0));
  const retained = record.retained_composition_count ?? total;
  const counting = !description && typeof record.unique_composition_count === "number" ? ` · ${retained} ${t("mentions")} · ${record.unique_composition_count} ${t("unique")}` : "";
  return <button className="review-queue-row" onClick={onOpen}><span className="review-queue-index" aria-label={`${t("Patent")} ${index}`}>{index}</span><span className={`review-status ${description ? descriptionReviewState(record) : record.status}`}></span><div><strong>{record.source_id}</strong><small>{description && (retained > 0 || total > 0) ? `${retained} composition instances · ${record.pending_count || 0} left to review` : total ? `${decided}/${total} ${t("decisions")}${counting}` : t("No compositions extracted — inspect source for missed compositions.")}</small><WarningBadges labels={record.warning_labels}/></div><div className="review-row-meta">{checker && record.reviewer && <small>{record.reviewer}</small>}<span>{description ? descriptionReviewLabel(record) : t(formatStatus(record.status))}</span></div><ChevronRight size={17}/></button>;
}

function WarningBadges({ labels = [] }: { labels?: ReviewRecordSummary["warning_labels"] }) {
  const t = useReviewTranslation();
  const names = { ocr_issue: "OCR issue", ambiguous: "Ambiguous", source_gap: "Source gap" } as const;
  return labels.length ? <span className="review-warning-badges" aria-label={t("Review warnings")}>{labels.map((label) => <span key={label}>{t(names[label])}</span>)}</span> : null;
}

function Banner({ tone, text, onClose }: { tone: "error" | "notice"; text: string; onClose: () => void }) {
  const t = useReviewTranslation(); return <div className={`review-banner ${tone}`}><span>{t(text)}</span><button onClick={onClose}><X size={14}/></button></div>; }

function ReviewRecordScreen({ document, summary, role, onBack, onAction, retry, conflict, onRetry, onRebase, selectedEvidence, onSelectEvidence, onClearSelectedEvidence, onDraftChange, error, notice, onClearError }: {
  document: ReviewDocument; summary?: ReviewRecordSummary; role?: ReviewRole; onBack: () => void; onAction: (action: ReviewAction, options?: { compositionId?: string; data?: unknown; reason?: string; sourceChecked?: boolean; outcome?: string; reviewReason?: string; actionId?: string }) => Promise<ReviewDocument | null>; retry: PendingRetry | null; conflict: { latest: ReviewDocument; retry: PendingRetry } | null; onRetry: () => void; onRebase: () => void; selectedEvidence: RawEvidence[]; onSelectEvidence: (span: RawEvidence) => void; onClearSelectedEvidence: () => void; onDraftChange: (next: boolean) => void; error: string; notice: string; onClearError: () => void;
}) {
  const t = useReviewTranslation();
  const isDescription = document.meta?.source_type === "patent_description" || document.meta?.section === "description";
  const [activeId, setActiveId] = React.useState<string | null>(document.compositions.find((item) => item.decision === "pending" && !item.deleted)?.id || document.compositions[0]?.id || null);
  const [adding, setAdding] = React.useState(false);
  const [sourceChecked, setSourceChecked] = React.useState(Boolean(document.source_checked));
  const [outcome, setOutcome] = React.useState(document.review_outcome || "");
  const [reviewReason, setReviewReason] = React.useState(document.review_reason || "");
  const [workflowReason, setWorkflowReason] = React.useState("");
  const [draftActive, setDraftActive] = React.useState(false);
  const [metadataDraft, setMetadataDraft] = React.useState(false);
  const [selectionEpoch, setSelectionEpoch] = React.useState(0);
  const [sourceWidth, setSourceWidth] = React.useState(56);
  const [compositionQuery, setCompositionQuery] = React.useState("");
  const [showDeleted, setShowDeleted] = React.useState(false);
  const [spanDraft, setSpanDraft] = React.useState<ReviewCompositionData | null>(null);
  const [spanCandidate, setSpanCandidate] = React.useState<RawEvidence | null>(null);
  const [selectedSpan, setSelectedSpan] = React.useState<RawEvidence | null>(null);
  const [spanMode, setSpanMode] = React.useState<"idle" | "add" | "replace">("idle");
  const [spanEditRequest, setSpanEditRequest] = React.useState({id:null as string | null, sequence:0});
  const [spanError, setSpanError] = React.useState("");
  // Reset navigation state before the mounted editor publishes its initial draft.
  // A passive reset ran after the child effect and disabled capture until an edit.
  React.useLayoutEffect(() => { setSpanDraft(null); setSpanCandidate(null); setSelectedSpan(null); setSpanMode("idle"); }, [activeId, adding, selectionEpoch]);
  const [descriptionWidths, setDescriptionWidths] = React.useState<DescriptionWidths>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("description-review-pane-widths") || "null");
      if (saved && Number.isFinite(saved.source) && Number.isFinite(saved.list) && saved.source >= 1 && saved.list >= 1 && saved.source + saved.list < 100) return saved;
    } catch { /* Use defaults when storage is unavailable. */ }
    return { source: 44, list: 20 };
  });
  const resizeCleanup = React.useRef<(() => void) | null>(null);
  const occurrences = React.useMemo(() => indexOccurrences(document.compositions), [document.compositions]);
  const visibleOccurrences = React.useMemo(() => filterOccurrences(occurrences.filter(entry => showDeleted || !entry.composition.deleted), compositionQuery), [occurrences, compositionQuery, showDeleted]);
  const selectedOccurrence = occurrences.find(entry => entry.composition.id === activeId);
  React.useEffect(() => {
    if (isDescription) { try { localStorage.setItem("description-review-pane-widths", JSON.stringify(descriptionWidths)); } catch { /* Resizing still works without storage. */ } }
  }, [descriptionWidths, isDescription]);
  React.useEffect(() => () => resizeCleanup.current?.(), []);
  const gridRef = React.useRef<HTMLDivElement | null>(null);
  const [availablePaneWidth, setAvailablePaneWidth] = React.useState(() => Math.max(1, window.innerWidth - 16));
  const paneWidths = fitDescriptionPanels(descriptionWidths, availablePaneWidth);
  React.useEffect(() => {
    if (!isDescription || !gridRef.current) return;
    const observer = new ResizeObserver(entries => setAvailablePaneWidth(Math.max(1, entries[0].contentRect.width - 16)));
    observer.observe(gridRef.current);
    return () => observer.disconnect();
  }, [isDescription]);
  const submitActionId = React.useRef(newActionId());
  const workflowActionIds = React.useRef<Record<string, string>>({});
  const quickAcceptId = React.useRef(newActionId());
  const active = document.compositions.find((item) => item.id === activeId) || null;
  const [focus, setFocus] = React.useState<EvidenceFocus | null>(null);
  const sourceNavigation = React.useRef<{compositionId:string;span:RawEvidence}|null>(null);
  const showEvidence = React.useCallback((value: unknown, label: string, scope?: RawEvidence[]) => {
    const spans = resolveEvidence(value, document.content, scope);
    setFocus(spans.length ? { value, label, spans } : null);
  }, [document.content]);
  React.useEffect(() => {
    if (active && !adding) {
      const selected = sourceNavigation.current;
      if (isDescription && selected?.compositionId === active.id && instanceSpans(active.data).some(span => sameSpan(span,selected.span))) showEvidence(selected.span,titleFor(active));
      else {sourceNavigation.current=null;showEvidence(active.data, titleFor(active));}
    }
    else setFocus(null);
  }, [active, document.source_id, adding, showEvidence]);
  const seeded = document.compositions.filter((item) => item.origin === "seed");
  const pending = seeded.filter((item) => item.decision === "pending" && !item.deleted).length;
  const checker = isChecker(role);
  const editable = isDescription ? !descriptionReviewLocked(document) : !checker ? document.status === "not_started" || document.status === "in_review" || document.status === "returned" : document.status !== "finalized";
  React.useEffect(() => {
    if (isDescription && !showDeleted && active?.deleted && !draftActive) setActiveId(occurrences.find(entry => !entry.composition.deleted)?.composition.id || null);
  }, [isDescription, showDeleted, active?.deleted, draftActive, occurrences]);
  const requestSpanEdit = React.useCallback((span?: RawEvidence) => {
    setSelectedSpan(span || null); setSpanCandidate(null); setSpanMode("idle");
    if(span) showEvidence(span,"Evidence being edited");
    if (editable && !active?.deleted && !adding) setSpanEditRequest(current => ({id: active?.id || null, sequence: current.sequence + 1}));
  }, [editable, active?.id, active?.deleted, adding,showEvidence]);
  const descriptionEvidence = React.useMemo(() => [...occurrences.filter(entry => showDeleted || !entry.composition.deleted).flatMap(entry => {
    const original = instanceSpans(entry.composition.data);
    const current = !adding && entry.composition.id === activeId && spanDraft ? instanceSpans(spanDraft) : original;
    return current.map(span => ({...span, compositionId:entry.composition.id, label:`Composition Instance ${entry.occurrence}: ${titleFor(entry.composition)}`, deleted:entry.composition.deleted, intermediate:!original.some(old => sameSpan(old,span))}));
  }), ...(adding ? instanceSpans(spanDraft).map(span => ({...span,compositionId:"",label:"New composition",deleted:false,intermediate:true})) : [])], [occurrences, showDeleted, adding, activeId, spanDraft]);
  const spanBridge: DescriptionSpanBridge = {
    content: document.content, data: spanDraft || (adding ? null : active?.data || null), editable: editable && (adding || !active?.deleted), editing: Boolean(spanDraft), requireEvidence: adding || active?.origin === "added",
    candidate: spanCandidate, setCandidate: setSpanCandidate, selected: selectedSpan, setSelected: setSelectedSpan,
    mode: spanMode, setMode: setSpanMode, setDraft: setSpanDraft, editRequest: spanEditRequest, requestEdit: requestSpanEdit,
    deleteSpan: span => { if (!editable || !active || active.deleted) return; try { const data = changeInstanceSpan(active.data, span, null, document.content, active.origin === "added"); void onAction("edit", { compositionId: active.id, data, actionId: newActionId() }); setSpanError(""); } catch (e) { setSpanError(e instanceof Error ? e.message : "Could not delete this evidence span."); } },
  };
  const sourceHint = spanMode !== "idle" ? spanCandidate ? "Selection ready in details." : "Highlight source text to attach evidence in details." : "Click highlighted text to find its composition.";
  const instanceTitle = `Composition Instance ${adding ? document.compositions.length + 1 : selectedOccurrence?.occurrence ?? ""}: ${spanDraft?.composition_name || (adding ? "New composition" : active ? titleFor(active) : "Select an instance")}`;
  const nextPending = () => {
    const candidates = (isDescription ? visibleOccurrences.map(entry => entry.composition) : document.compositions).filter((item) => item.origin === "seed" && item.decision === "pending" && !item.deleted);
    if (isDescription && !candidates.length) return;
    setActiveId(candidates.find((item) => item.id !== activeId)?.id || candidates[0]?.id || null);
  };
  const selectComposition = (compositionId: string) => {
    if (compositionId === activeId && !adding) { sourceNavigation.current=null; if (isDescription && !visibleOccurrences.some(entry => entry.composition.id === compositionId)) setCompositionQuery(""); if (active) showEvidence(active.data, titleFor(active)); return; }
    if (draftActive && !window.confirm(t("Discard unfinished composition edits?"))) return false;
    sourceNavigation.current=null;
    setSpanEditRequest(current => ({id:null,sequence:current.sequence}));
    if (isDescription) onClearSelectedEvidence();
    if (isDescription && !visibleOccurrences.some(entry => entry.composition.id === compositionId)) setCompositionQuery("");
    setActiveId(compositionId); setAdding(false); setDraftActive(false); setMetadataDraft(false); setSelectionEpoch((value) => value + 1); onDraftChange(false);
    return true;
  };
  const compositionAction = (compositionId: string, action: string) => {
    if (!editable) return;
    const run = async () => {
      if (draftActive && !window.confirm(t("Discard unfinished composition edits?"))) return;
      if (draftActive) { setDraftActive(false); onDraftChange(false); setSpanEditRequest(current=>({...current,id:null})); setSelectionEpoch(value=>value+1); }
      const saved = await onAction(action as ReviewAction, { compositionId, actionId: newActionId() });
      if (saved && action === "delete" && activeId === compositionId) setActiveId(saved.compositions.find(item => !item.deleted)?.id || null);
    };
    void run();
  };
  const beginAdding = () => {
    if (!editable) return;
    if (draftActive && !window.confirm(t("Discard unfinished composition edits?"))) return;
    if (isDescription) onClearSelectedEvidence();
    setAdding(true); setDraftActive(true); setMetadataDraft(false); setSelectionEpoch((value) => value + 1); onDraftChange(true);
  };
  const startResize = (event: React.MouseEvent) => {
    if (event.button !== 0 || !gridRef.current) return;
    const rect = gridRef.current.getBoundingClientRect();
    const move = (moveEvent: MouseEvent) => setSourceWidth(Math.min(76, Math.max(34, (moveEvent.clientX - rect.left) / rect.width * 100)));
    const end = () => { globalThis.document.body.classList.remove("review-resizing"); window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", end); };
    globalThis.document.body.classList.add("review-resizing"); window.addEventListener("mousemove", move); window.addEventListener("mouseup", end);
  };
  const descriptionResize = (boundary: "source" | "details", position: number) => {
    const available = Math.max(1, (gridRef.current?.getBoundingClientRect().width || 1200) - 16);
    setDescriptionWidths(current => resizeDescriptionPanels(current, boundary, position, available));
  };
  const startDescriptionResize = (boundary: "source" | "details", event: React.PointerEvent) => {
    if (event.button !== 0 || !gridRef.current) return;
    event.preventDefault(); resizeCleanup.current?.();
    const rect = gridRef.current.getBoundingClientRect();
    const available = Math.max(1, rect.width - 16);
    const initial = paneWidths;
    const move = (next: PointerEvent) => setDescriptionWidths(resizeDescriptionPanels(initial, boundary, (next.clientX - rect.left - (boundary === "details" ? 8 : 0)) / available * 100, available));
    const end = () => {
      globalThis.document.body.classList.remove("review-resizing");
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); window.removeEventListener("blur", end);
      resizeCleanup.current = null;
    };
    resizeCleanup.current = end;
    globalThis.document.body.classList.add("review-resizing");
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", end); window.addEventListener("blur", end);
  };
  const descriptionDivider = (boundary: "source" | "details") => <div className="review-resize-divider" role="separator" aria-orientation="vertical" aria-label={boundary === "source" ? "Resize source and composition list" : "Resize composition list and details"} tabIndex={0} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(paneWidths[boundary === "source" ? "source" : "list"])} title="Drag to resize. Use arrow keys for small adjustments; double-click to reset widths." onPointerDown={event => startDescriptionResize(boundary, event)} onDoubleClick={() => setDescriptionWidths({ source: 44, list: 20 })} onKeyDown={event => {
    if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") { setDescriptionWidths({ source: 44, list: 20 }); return; }
    const position = boundary === "source" ? paneWidths.source : paneWidths.source + paneWidths.list;
    descriptionResize(boundary, position + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 5 : 1));
  }}><span aria-hidden="true"/></div>;
  const submit = async () => { if (draftActive || pending || !sourceChecked || (outcome === "needs_adjudication" && !reviewReason.trim())) return; const saved = await onAction("submit", { sourceChecked, outcome, reviewReason, actionId: submitActionId.current }); if (saved) submitActionId.current = newActionId(); };
  const workflow = async (action: ReviewAction) => { if (draftActive) return; if ((action === "return" || action === "reopen") && !workflowReason.trim()) return; const actionId = workflowActionIds.current[action] || (workflowActionIds.current[action] = newActionId()); const saved = await onAction(action, { reason: workflowReason, sourceChecked: action === "finalize" ? sourceChecked : undefined, reviewReason: action === "finalize" ? reviewReason : undefined, outcome: action === "finalize" ? outcome : undefined, actionId }); if (saved) { delete workflowActionIds.current[action]; setWorkflowReason(""); } };
  React.useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey) return;
      const textEntry = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || (event.target instanceof HTMLElement && event.target.isContentEditable);
      if (isDescription && editable && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !textEntry && !draftActive) { event.preventDefault(); void onAction("undo", { actionId: newActionId() }); return; }
      if (event.ctrlKey || event.metaKey || textEntry) return;
      if (!isDescription && event.key.toLowerCase() === "a" && active?.decision === "pending" && editable && !draftActive) { event.preventDefault(); void onAction("accept", { compositionId: active.id, actionId: quickAcceptId.current }).then((saved) => { if (saved) { quickAcceptId.current = newActionId(); nextPending(); } }); }
    };
    window.addEventListener("keydown", keyDown); return () => window.removeEventListener("keydown", keyDown);
  }, [active, draftActive, editable, isDescription, onAction, visibleOccurrences]);

  return <DescriptionSpanContext.Provider value={isDescription ? spanBridge : null}><EvidenceContext.Provider value={{ content: document.content, focus, show: showEvidence }}><main className={`review-record-shell${isDescription ? " review-description" : ""}`}>
    <header className={`review-record-header${isDescription ? ` review-document-${descriptionReviewState(document)}` : ""}`}><button onClick={onBack}><ArrowLeft size={15}/> {t("Queue")}</button><div className={isDescription ? "review-record-identity" : undefined}><strong>{document.source_id}</strong>{isDescription && ["done","needs_help"].includes(descriptionReviewState(document)) && <span className={`review-record-state-label ${descriptionReviewState(document)}`} role="status">{descriptionReviewLabel(document)}</span>}{isDescription && descriptionReviewState(document) === "needs_help" && document.review_reason && <FlagReasonPopover key={document.source_id} reason={document.review_reason}/ >}{!isDescription && <span>{t(formatStatus(document.status))}{t(" · revision")} {document.revision}</span>}</div><div className="review-header-actions"><span className="review-save-state" role="status">{t(notice)}</span>{isDescription && <DescriptionReviewControls document={document} pending={pending} disabled={draftActive} onAction={(action, options) => onAction(action, { ...options, actionId: newActionId() })}/>}</div></header>
    {error && <Banner tone="error" text={error} onClose={onClearError}/>}
    {spanError && <Banner tone="error" text={spanError} onClose={() => setSpanError("")}/>}
    {retry && !conflict && <div className="review-banner notice"><span>{isDescription ? "Save could not be confirmed. Your draft is preserved." : `${t("Last")} ${t(retry.action)} ${t("action was not confirmed.")}`}</span><button onClick={onRetry}>{t("Retry same action")}</button></div>}
    {conflict && <section className="review-conflict"><strong>{isDescription ? "This document was updated elsewhere." : `${t("A newer revision is available:")} ${conflict.latest.revision}`}</strong><p>{isDescription ? "Your draft is preserved. Load the latest version, review your edit, then save again." : t("Compare the current and latest records, then load the latest revision before retrying. Your open editor draft remains in the form.")}</p><details><summary>{t("Compare revisions")}</summary><div className="review-composition-data"><JsonNode label={t("Current")} value={document.compositions}/><JsonNode label={t("Latest")} value={conflict.latest.compositions}/></div></details><button onClick={onRebase}>{isDescription ? "Load latest version" : t("Load latest revision and preserve draft")}</button></section>}
    <section ref={gridRef} className="review-record-grid" style={isDescription ? { "--description-columns": `minmax(0, ${paneWidths.source}fr) 8px minmax(0, ${paneWidths.list}fr) 8px minmax(0, ${100 - paneWidths.source - paneWidths.list}fr)` } as React.CSSProperties : { gridTemplateColumns: `${sourceWidth}% 8px minmax(0, 1fr)` }}>
      <section className="review-source-pane"><header>{isDescription ? <div className="review-source-heading"><h2 className="review-panel-title review-title-source">Source</h2><span className="review-source-hint" role="status">{sourceHint}</span></div> : <strong>{t("Claim source")}</strong>}{!isDescription && <div className="review-source-focus-status" aria-live="polite">{focus ? <><span>{focus.label} · {t("Fragments")}: {focus.spans.length}</span><button type="button" onClick={() => setFocus(null)}>{t("Clear highlight")}</button></> : <span>{t("Click an item on the right to locate its evidence.")}</span>}</div>}</header><RawSourceViewer descriptionEvidence={isDescription ? descriptionEvidence : undefined} onEvidenceNavigate={(compositionId,span) => { if(selectComposition(compositionId) === false) return false;sourceNavigation.current={compositionId,span};showEvidence(span,"Selected evidence");return true; }} sourceLabel={t(isDescription ? "Patent description source" : "Patent claim source")} content={document.content} pendingEvidence={selectedEvidence} onSelectEvidence={onSelectEvidence} explicitEvidence={isDescription} captureEnabled={!isDescription || (editable && draftActive && !metadataDraft)} selectionKey={`${activeId}:${adding}:${selectionEpoch}`}/>{!isDescription && selectedEvidence.length > 0 && <div className="review-evidence-tray"><strong>{t("Selected spans")}: {selectedEvidence.length}</strong><button onClick={onClearSelectedEvidence}>{t("Clear selection")}</button></div>}</section>
      {isDescription ? <>{descriptionDivider("source")}<DescriptionNavigator allEntries={occurrences} showDeleted={showDeleted} onShowDeleted={setShowDeleted} entries={visibleOccurrences} total={occurrences.length} deleted={document.compositions.filter(item => item.deleted).length} query={compositionQuery} onQuery={setCompositionQuery} activeId={activeId} adding={adding} onSelect={selectComposition} onAdd={beginAdding} editable={editable} decided={seeded.length - pending} seeds={seeded.length} onCompositionAction={compositionAction}/>{descriptionDivider("details")}</> : <button className="review-resize-divider" onMouseDown={startResize} aria-label={t("Resize source and editor panes")}/>}
      <aside className="review-editor-pane" id={isDescription ? "description-composition-details" : undefined} aria-label={isDescription ? "Composition details" : undefined}>{isDescription ? <header className="review-editor-header"><h2 className="review-panel-title review-title-instance" title={instanceTitle}>{instanceTitle}</h2></header> : <header className="review-editor-header"><div><strong>{t("Compositions")}</strong><span>{seeded.length - pending}/{seeded.length} {t("seeded decisions")}</span></div><div className="review-editor-controls"><button type="button" title={t("Keyboard shortcut: N")} disabled={!pending || draftActive} onClick={nextPending}>{t("Next pending (N)")}</button>{editable && <button onClick={beginAdding}><Plus size={14}/> {t("Add composition")}</button>}</div></header>}
        <ReviewDetailsBody description={isDescription}>
        {!isDescription && <SourceMetadata key={selectionEpoch} document={document} editable={editable && (!draftActive || metadataDraft)} onAction={onAction} onDraftChange={(next) => { setMetadataDraft(next); setDraftActive(next); onDraftChange(next); }}/>}
        {checker && !isDescription && <CheckerInspection document={document} summary={summary} onSelect={selectComposition}/>}
        {!isDescription && document.workflow?.has_blocking_source_gaps && <div className="review-banner error"><span>{t("Blocking source-quality gaps need adjudication before finalization.")}</span></div>}
        {!isDescription && <div className="review-composition-list">{document.compositions.map((composition, index) => <button key={composition.id} className={`review-composition-item ${activeId === composition.id ? "active" : ""} ${composition.deleted ? "deleted" : ""}`} onClick={() => selectComposition(composition.id)}><span>{t(composition.decision)}</span><strong>{titleFor(composition)}</strong><small>{isDescription ? `${t("Occurrence")} ${index + 1}` : `${t("Claim")} ${String(composition.data.claim_no ?? "—")}`}</small></button>)}</div>}
        {isDescription && active && !adding && compositionQuery && !visibleOccurrences.some(entry => entry.composition.id === activeId) && <div className="review-filtered-selection" role="status">The open composition instance is outside this filter.<button type="button" onClick={() => setCompositionQuery("")}>Clear search</button></div>}
        {isDescription && !active && !adding && <p className="review-details-empty">Select a composition instance to view its details, or add one.</p>}
        {active && !adding && <CompositionCard isDescription={isDescription} key={`${active.id}:${selectionEpoch}`} composition={active} editable={editable && !metadataDraft} inheritOptions={document.compositions.map((item, index) => ({...item, instance_index:index+1})).filter((item) => item.id !== active.id && !item.deleted)} selectedEvidence={selectedEvidence} onAction={onAction} onDraftChange={(next) => { setDraftActive(next); if (isDescription && !next) { onClearSelectedEvidence(); setSpanEditRequest(current => ({id:null,sequence:current.sequence})); } onDraftChange(next); }} onAcceptedNext={nextPending} onSelectBase={selectComposition}/>}
        {adding && <CompositionEditor
          showClaimNumber={!isDescription}
          key="new-composition"
          initial={{ composition_name: "New composition", composition_type: "alloy", constituents: [], constraints: [], evidence_spans: selectedEvidence, unrepresented_relations: [] }}
          inheritOptions={document.compositions.map((item, index) => ({...item, instance_index:index+1})).filter((item) => !item.deleted)}
          selectedEvidence={selectedEvidence}
          requiredReason={false}
          submitLabel={t("Add composition")}
          onCancel={() => { setAdding(false); setDraftActive(false); if (isDescription) onClearSelectedEvidence(); onDraftChange(false); }}
          onSave={async (data, reason, actionId) => { const saved = await onAction("add", { data, reason, actionId }); if (saved) { setAdding(false); setDraftActive(false); if (isDescription) { setActiveId(`added:${actionId}`); setCompositionQuery(""); } onDraftChange(false); } return saved; }}
          onDraftChange={(next) => { setDraftActive(next); onDraftChange(next); }}
        />}
        {!isDescription && <DocumentReviewSection description={isDescription} status={document.status}><section className="review-submit-panel"><label><input type="checkbox" checked={sourceChecked} onChange={(event) => setSourceChecked(event.target.checked)} disabled={!editable}/> {t("I checked the source for missed compositions.")}</label><label>{t("Review outcome")}<select value={outcome} disabled={!editable} onChange={(event) => setOutcome(event.target.value)}><option value="">{t("Select outcome")}</option><option value="compositions_found">{t("Compositions found")}</option><option value="no_compositions_found">{t("Reviewed — no compositions found")}</option><option value="needs_adjudication">{t("Needs adjudication")}</option></select></label>{outcome === "needs_adjudication" && <label>{t("Reason for adjudication")}<textarea value={reviewReason} disabled={!editable} onChange={(event) => setReviewReason(event.target.value)} placeholder={t("Explain why this record needs adjudication (required)")} required /></label>}{editable && (!checker || (role === "admin" && document.status !== "submitted")) && <button className="review-primary" disabled={draftActive || pending > 0 || !sourceChecked || (outcome === "needs_adjudication" && !reviewReason.trim())} onClick={() => void submit()}><Send size={14}/> {t("Submit review")}</button>}{checker && <><button className="review-primary" disabled={!editable || draftActive || !sourceChecked || !outcome || (outcome === "needs_adjudication" && !reviewReason.trim())} onClick={() => void onAction("save_review", { sourceChecked, outcome, reviewReason, actionId: newActionId() })}><Save size={14}/> {t("Save review")}</button><CheckerControls admin={role === "admin"} canFinalize={Boolean(sourceChecked && !pending && outcome && outcome !== "needs_adjudication" && !document.workflow?.has_blocking_source_gaps)} disabled={draftActive} status={document.status} reason={workflowReason} setReason={setWorkflowReason} onAction={workflow}/></>}</section></DocumentReviewSection>}
        {!isDescription && <History events={document.events}/>}
        </ReviewDetailsBody>
      </aside>
    </section>
  </main></EvidenceContext.Provider></DescriptionSpanContext.Provider>;
}

function ReviewDetailsBody({ description, children }: { description: boolean; children: React.ReactNode }) {
  return description ? <div className="review-details-body">{children}</div> : <>{children}</>;
}
function DocumentReviewSection({ description, status, children }: { description: boolean; status: string; children: React.ReactNode }) {
  return description ? <details className="review-document-controls"><summary>Document review · {formatStatus(status)}</summary>{children}</details> : <>{children}</>;
}

function useConstituentDeletion(commit: (data:ReviewCompositionData)=>void, onPendingChange?: (pending:boolean)=>void) {
  const [pending,setPending] = React.useState<{data:ReviewCompositionData;name:string;count:number}|null>(null);
  const cancel = () => {setPending(null);onPendingChange?.(false);};
  React.useEffect(() => {
    if (!pending) return;
    const escape=(event:KeyboardEvent)=>{if(event.key === "Escape"){event.preventDefault();event.stopImmediatePropagation();cancel();}};
    window.addEventListener("keydown",escape,true);return()=>window.removeEventListener("keydown",escape,true);
  },[pending,onPendingChange]);
  const request = (data:ReviewCompositionData,index:number) => {
    const next=removeDescriptionConstituent(data,index);
    const count=(data.constraints?.length || 0)-(next.constraints?.length || 0);
    if (!count) {commit(next);return;}
    setPending({data:next,name:data.constituents![index].constituent_name,count});onPendingChange?.(true);
  };
  const confirmation = pending && <div className="review-delete-confirmation" role="alertdialog" aria-label="Confirm constituent deletion"><p>Delete <strong>{pending.name}</strong> and the {pending.count} constituent restriction{pending.count === 1 ? "" : "s"} that use{pending.count === 1 ? "s" : ""} it?</p><div className="review-action-row"><button type="button" className="review-danger" aria-label="Confirm delete constituent and restrictions" onClick={()=>{const next=pending.data;cancel();commit(next);}}>Delete</button><button type="button" autoFocus onClick={cancel}>Cancel deletion</button></div></div>;
  return {request,confirmation,pending:Boolean(pending)};
}

type DescriptionEditScope = { kind: "details" | "constituent" | "restriction" | "evidence"; index?: number; field?: "composition_name" | "composition_type" | "inherits_from" };

function DescriptionInstance({ composition, editable: documentEditable, inheritOptions, selectedEvidence, onAction, onDraftChange }: { composition: ReviewComposition; editable: boolean; inheritOptions: ReviewComposition[]; selectedEvidence: RawEvidence[]; onAction: (action:ReviewAction, options?: {compositionId?:string;data?:unknown;reason?:string;actionId?:string}) => Promise<ReviewDocument|null>; onDraftChange:(next:boolean)=>void }) {
  const bridge = React.useContext(DescriptionSpanContext)!;
  const [editor, setEditor] = React.useState<{scope:DescriptionEditScope;initial:ReviewCompositionData;base:ReviewCompositionData;key:number}|null>(null);
  const [busy,setBusy] = React.useState(false);
  const [mutationError,setMutationError] = React.useState("");
  const consumedEvidence = React.useRef(0);
  const editable = documentEditable && !composition.deleted;
  const open = (scope:DescriptionEditScope, initial = composition.data) => {if(!editable || editor || busy) return;setMutationError("");setEditor({scope,initial:clone(initial),base:clone(composition.data),key:Date.now()});onDraftChange(true);};
  const close = () => {setEditor(null);onDraftChange(false);bridge.setSelected(null);bridge.setMode("idle");bridge.setCandidate(null);window.getSelection()?.removeAllRanges();};
  React.useEffect(() => {
    if (bridge.editRequest.id === composition.id && bridge.editRequest.sequence > consumedEvidence.current && !composition.deleted) {consumedEvidence.current=bridge.editRequest.sequence;open({kind:"evidence"});bridge.setMode(bridge.selected ? "replace" : "add");}
  }, [bridge.editRequest.id,bridge.editRequest.sequence]);
  const save = async (data:ReviewCompositionData, reason = "", actionId: string = newActionId()) => {
    if (!editable) return null;
    if (editor && JSON.stringify(editor.base) !== JSON.stringify(composition.data)) throw new Error("This composition changed while you were editing. Cancel and reopen its editor to use the latest version. Your draft has not been saved.");
    setBusy(true);
    try {const result = await onAction("edit",{compositionId:composition.id,data:prepareAddOnlyInheritance(data,inheritOptions),reason,actionId});if(result) close();return result;}
    finally {setBusy(false);}
  };
  const remove = (next:ReviewCompositionData) => {setMutationError("");void save(next).catch(error=>setMutationError(error instanceof Error ? error.message : "Could not save this change."));};
  const sectionAction = (kind:"restriction", index:number|undefined, action:"edit"|"delete", ratio=false) => {
    const next = clone(composition.data);
    if (action === "delete") {next.constraints=(next.constraints || []).filter((_,i)=>i!==index);remove(next);return;}
    if (index == null) {
      const rows = next.constraints || [];
      next.constraints=[...rows,{constraint_id:nextConstraintId([...rows,...inheritedInformation(next,inheritOptions).constraints]),...(ratio ? {mode:"ratio",member_refs:[],ratio_values:[]} : {mode:"sum",member_refs:[],constituent_status:"included",selection:{min:null,max:null},amount_comparator:null})}];index=rows.length;
    }
    open({kind,index},next);
  };
  const deletion=useConstituentDeletion(remove,onDraftChange);
  const deleteConstituent = (index:number) => deletion.request(composition.data,index);
  const editorView = editor && editable ? <CompositionEditor key={editor.key} inlineSection inlineConstituent={editor.scope.kind === "constituent"} showClaimNumber={false} initial={editor.initial} editScope={editor.scope} inheritOptions={inheritOptions} selectedEvidence={selectedEvidence} requiredReason={false} submitLabel="Save changes" onCancel={close} onSave={save} onDraftChange={onDraftChange}/> : null;
  const viewEditable = editable && !editor && !busy && !deletion.pending;
  const parent = inheritOptions.find(record => Number(record.data.node_no) === inheritanceBase(composition.data));
  return <DescriptionSpanContext.Provider value={{...bridge,editable:viewEditable}}><section className="review-composition-card review-description-instance">
    <section className={`review-instance-section review-instance-details${inheritanceBase(composition.data) ? " review-derived-instance" : ""}`}><header><h3>Instance details</h3></header><div className="review-instance-fields">
      {([['composition_name','Name',composition.data.composition_name || 'Unnamed composition'],['composition_type','Material type',composition.data.composition_type || '—'],['inherits_from','Inherits from',parent ? `Composition Instance ${instanceNumber(parent)}: ${titleFor(parent)}` : inheritanceBase(composition.data) ? `Composition Instance ${inheritanceBase(composition.data)}` : 'None']] as const).map(([field,label,value]) => editor?.scope.kind === "details" && editor.scope.field === field ? <div className={`review-inline-slot review-instance-field-${field}`} key={field}>{editorView}</div> : <DescriptionEditableItem key={field} className={`review-instance-field review-instance-field-${field}`} label={`Edit ${label.toLowerCase()}`} onEdit={viewEditable ? () => open({kind:"details",field}) : undefined} onDelete={viewEditable && field === "inherits_from" && inheritanceBase(composition.data) ? () => remove(setInheritanceBase(clone(composition.data),null)) : undefined} deleteLabel="Clear inheritance link"><small>{label}</small><span>{value}</span></DescriptionEditableItem>)}
    </div></section>
    <InheritedInformation data={editor?.scope.field === "inherits_from" && bridge.data ? bridge.data : composition.data} records={inheritOptions}/>
    {mutationError && <p className="review-inline-error" role="alert">{mutationError}</p>}
    {deletion.confirmation}
    <CompositionDataView data={composition.data} description bases={inheritOptions} editable={viewEditable} constituentEditor={editor?.scope.kind === "constituent" && editor.scope.index != null ? {index:editor.scope.index,row:editor.initial.constituents?.[editor.scope.index],content:editorView} : undefined} restrictionEditor={editor?.scope.kind === "restriction" && editor.scope.index != null ? {index:editor.scope.index,content:editorView} : undefined} onEditConstituent={index=>{const next=clone(composition.data);if(index === (next.constituents || []).length) next.constituents=[...(next.constituents || []),{constituent_name:"",constituent_status:"included"}];open({kind:"constituent",index},next);}} onDeleteConstituent={deleteConstituent} onSectionAction={sectionAction}/>
    <DescriptionEvidenceSection data={composition.data} editing={false} inlineEditor={editor?.scope.kind === "evidence" ? {span:bridge.selected || undefined,content:editorView} : undefined}/>
  </section></DescriptionSpanContext.Provider>;
}

function CompositionCard({ isDescription, composition, editable, inheritOptions, selectedEvidence, onAction, onDraftChange, onAcceptedNext, onSelectBase }: { onSelectBase: (id: string) => void; isDescription: boolean; composition: ReviewComposition; editable: boolean; inheritOptions: ReviewComposition[]; selectedEvidence: RawEvidence[]; onAction: (action: ReviewAction, options?: { compositionId?: string; data?: unknown; reason?: string; actionId?: string }) => Promise<ReviewDocument | null>; onDraftChange: (next: boolean) => void; onAcceptedNext: () => void }) {
  const t = useReviewTranslation();
  const [editing, setEditing] = React.useState(false);
  const actionIds = React.useRef<Record<string, string>>({});
  const run = async (action: "accept" | "restore" | "reverse") => { const actionId = actionIds.current[action] || (actionIds.current[action] = newActionId()); const saved = await onAction(action, { compositionId: composition.id, actionId }); if (saved) delete actionIds.current[action]; return saved; };
  const accept = async (next = false) => { const saved = await run("accept"); if (saved && next) onAcceptedNext(); };
  if (isDescription) return <DescriptionInstance composition={composition} editable={editable} inheritOptions={inheritOptions} selectedEvidence={selectedEvidence} onAction={onAction} onDraftChange={onDraftChange}/>;
  if (editing) return <CompositionEditor showClaimNumber={!isDescription} initial={composition.data} inheritOptions={inheritOptions} selectedEvidence={selectedEvidence} requiredReason={!isDescription} submitLabel={t("Save edit")} onCancel={() => { setEditing(false); onDraftChange(false); }} onSave={async (data, reason, actionId) => { const saved = await onAction("edit", { compositionId: composition.id, data, reason, actionId }); if (saved) { setEditing(false); onDraftChange(false); } return saved; }} onDraftChange={onDraftChange}/>;
  return <section className="review-composition-card">{isDescription ? <section className="review-instance-section"><header><h3>Instance details</h3></header><dl className="review-instance-facts"><div><dt>Material type</dt><dd>{composition.data.composition_type || "—"}</dd></div></dl></section> : <header><div><strong><SourceLink value={composition.data} label={titleFor(composition)}>{titleFor(composition)}</SourceLink></strong><span>{`${t("Claim")} ${String(composition.data.claim_no ?? "—")}`} · {t(composition.origin)}</span></div><span className={`review-decision ${t(composition.decision)}`}>{t(composition.decision)}</span></header>}<CompositionDataView data={composition.data} description={isDescription} bases={inheritOptions} onSelectBase={onSelectBase}/>{isDescription ? <DescriptionEvidenceSection data={composition.data} editing={false}/> : <EvidenceList evidence={evidenceFor(composition.data)} />}
    {composition.deleted ? <button disabled={!editable} onClick={() => void run("restore")}><RotateCcw size={14}/> {t("Restore")}</button> : <div className="review-action-row">{editable && <>{composition.decision === "pending" && <>{!isDescription && <button onClick={() => void accept(false)}><Check size={14}/> {t("Accept")}</button>}<button onClick={() => void accept(true)}>{t("Accept & next")}</button></>}<button onClick={() => { setEditing(true); onDraftChange(true); }}><FileDiff size={14}/> {t("Edit")}</button>{isDescription ? <button className="review-danger" title="Remove this instance; restore it through Show deleted" onClick={() => { void onAction("delete", {compositionId: composition.id, actionId: newActionId()}); }}>Delete</button> : <ReasonAction label={t("Delete")} onSubmit={(reason, actionId) => onAction("delete", { compositionId: composition.id, reason, actionId })}/>}{composition.origin === "seed" && composition.decision !== "pending" && (isDescription ? <details className="review-instance-more"><summary>More</summary><button onClick={() => void run("reverse")}>Mark unreviewed</button></details> : <button onClick={() => void run("reverse")}><Undo2 size={14}/> {t("Reverse decision")}</button>)}</>}</div>}</section>;
}

function ReasonAction({ label, onSubmit }: { label: string; onSubmit: (reason: string, actionId: string) => Promise<unknown> }) {
  const t = useReviewTranslation();
  const [open, setOpen] = React.useState(false); const [reason, setReason] = React.useState(""); const actionId = React.useRef(newActionId());
  if (!open) return <button className="review-danger" onClick={() => setOpen(true)}>{label}</button>;
  return <form className="review-reason-form" onSubmit={(event) => { event.preventDefault(); if (reason.trim()) void onSubmit(reason, actionId.current).then((saved) => { if (saved) { setOpen(false); setReason(""); actionId.current = newActionId(); } }); }}><input autoFocus value={reason} onChange={(event) => setReason(event.target.value)} placeholder={`${label}: ${t("Reason (required)")}`}/><button type="submit" disabled={!reason.trim()}>{label}</button><button type="button" onClick={() => setOpen(false)}>{t("Cancel")}</button></form>;
}

function CompositionEditor({ showClaimNumber = true, inlineConstituent = false, inlineSection = false, editScope, initial, inheritOptions = [], selectedEvidence = [], requiredReason, submitLabel, onCancel, onSave, onDraftChange }: { showClaimNumber?: boolean; inlineConstituent?: boolean; inlineSection?: boolean; editScope?: DescriptionEditScope; initial: ReviewCompositionData; inheritOptions?: ReviewComposition[]; selectedEvidence?: RawEvidence[]; requiredReason: boolean; submitLabel: string; onCancel: () => void; onSave: (data: ReviewCompositionData, reason: string, actionId: string) => Promise<unknown>; onDraftChange: (next: boolean) => void }) {
  const t = useReviewTranslation();
  const [inheritSourceId, setInheritSourceId] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [data, setData] = React.useState<ReviewCompositionData>(() => clone(initial)); const [reason, setReason] = React.useState(""); const [relationsText, setRelationsText] = React.useState(() => JSON.stringify(initial.unrepresented_relations || [], null, 2)); const [relationsError, setRelationsError] = React.useState(""); const [submitError, setSubmitError] = React.useState(""); const [showValidation, setShowValidation] = React.useState(false); const actionId = React.useRef(newActionId()); const renameOrigins = React.useRef(new Map<number, string>());
  const set = (patch: Partial<ReviewCompositionData>) => { setData((current) => ({ ...current, ...patch })); onDraftChange(true); };
  const spanBridge = React.useContext(DescriptionSpanContext);
  const publishDraft = spanBridge?.setDraft;
  const resetMode = spanBridge?.setMode;
  const resetCandidate = spanBridge?.setCandidate;
  const evidenceEditor = !showClaimNumber && editScope?.kind === "evidence";
  React.useEffect(() => {
    if (showClaimNumber) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || saving) return;
      event.preventDefault();window.getSelection()?.removeAllRanges();
      if (!evidenceEditor && spanBridge?.mode !== "idle") {resetMode?.("idle");resetCandidate?.(null);}
      else onCancel();
    };
    window.addEventListener("keydown",escape);
    return () => window.removeEventListener("keydown",escape);
  }, [showClaimNumber,evidenceEditor,spanBridge?.mode,onCancel,resetMode,resetCandidate,saving]);
  React.useEffect(() => { if (!showClaimNumber) publishDraft?.(data); }, [data, showClaimNumber, publishDraft]);
  React.useEffect(() => () => { if (!showClaimNumber) { publishDraft?.(null); resetMode?.("idle"); resetCandidate?.(null); } }, [showClaimNumber, publishDraft, resetMode, resetCandidate]);
  const constituents = data.constituents || []; const constraints = data.constraints || [];
  const showSection = (kind:DescriptionEditScope["kind"]) => !editScope || editScope.kind === kind;
  const inheritConstituents = () => {
    const source = inheritOptions.find((item) => item.id === inheritSourceId);
    if (!source) return;
    const existing = new Set(constituents.map((item) => item.constituent_name).filter(Boolean));
    const inherited = (source.data.constituents || []).filter((item) => item.constituent_name && !existing.has(item.constituent_name)).map((item) => clone(item));
    if (!inherited.length) { setSubmitError(t("All source constituents are already present.")); return; }
    set({ constituents: [...constituents, ...inherited] });
    setSubmitError("");
  };
  const updateConstituents = (next: typeof constituents) => {
    if (next.length !== constituents.length) renameOrigins.current.clear();
    const renamed = !showClaimNumber && next.length === constituents.length;
    set({constituents:next,...(renamed ? {constraints:next.reduce((rows,row,i)=>row.constituent_name ? renameConstraintMemberRefs(rows,constituents[i].constituent_name,row.constituent_name) : rows,constraints)} : {})});
  };
  const beginConstituentRename = (index: number) => {
    if (!renameOrigins.current.has(index)) renameOrigins.current.set(index, constituents[index]?.constituent_name || "");
  };
  const finishConstituentRename = (index: number) => {
    const before = renameOrigins.current.get(index);
    const after = constituents[index]?.constituent_name || "";
    const valid = Boolean(after.trim()) && constituents.every((row, rowIndex) => rowIndex === index || row.constituent_name !== after);
    if (!valid) return;
    renameOrigins.current.delete(index);
    if (before && before !== after) set({ constraints: renameConstraintMemberRefs(constraints, before, after) });
  };
  React.useEffect(() => {
    if (showClaimNumber || !selectedEvidence.length) return;
    setData(current => {
      const existing = evidenceFor(current);
      const extra = selectedEvidence.filter(span => !existing.some(p => p.start === span.start && p.end === span.end));
      return extra.length ? { ...current, evidence_spans: [...existing, ...extra] } : current;
    });
  }, [selectedEvidence, showClaimNumber]);
  const evidence = evidenceFor(data);
  const constituentReferenceNames = constituents.map((row, index) => renameOrigins.current.get(index) || row.constituent_name || "");
  const inheritedData = inheritedInformation(data, inheritOptions);
  const inherited = showClaimNumber ? [] : inheritedData.constituents;
  const draftErrors = React.useMemo(() => validateCompositionDraft({ ...data, constituents: [...(data.constituents || []), ...inherited] }, showClaimNumber), [data, inheritOptions, showClaimNumber]);
  const draftInvalid = hasCompositionDraftErrors(draftErrors);
  const persist = async (next:ReviewCompositionData, skipNumeric = false) => {
    setSaving(true);
    try {
      let prepared = skipNumeric ? next : normalizeCompositionNumericDraft(next, showClaimNumber ? undefined : editScope, !showClaimNumber);
      if (!showClaimNumber) prepared = prepareAddOnlyInheritance(prepared, inheritOptions);
      if (!showClaimNumber) actionId.current = newActionId();
      return await onSave(prepared,reason,actionId.current);
    } catch (error) { setSubmitError(error instanceof Error ? error.message : "Could not save this section."); return null; }
    finally { setSaving(false); }
  };
  const deletion=useConstituentDeletion(next=>{void persist(next,true);});
  const savedLegacyRatio = !showClaimNumber && editScope?.kind === "restriction" && editScope.index != null && isLegacyRatio(constraints[editScope.index] || {});
  const scopedConstituent = editScope?.kind === "constituent" && editScope.index != null ? constituents[editScope.index] : null;
  const canDeleteConstituent = scopedConstituent && Boolean(initial.constituents?.[editScope!.index!]?.constituent_name);
  const deleteSection = () => {
    if(saving) return;
    setSubmitError("");
    try {
      let next = data;
      if (evidenceEditor && spanBridge?.selected) next=changeInstanceSpan(data,spanBridge.selected,null,spanBridge.content,spanBridge.requireEvidence);
      else if (canDeleteConstituent) {deletion.request(data,editScope!.index!);return;}
      else return;
      void persist(next, true);
    } catch(error) {setSubmitError(error instanceof Error ? error.message : "Could not delete this item.");}
  };
  const submit = () => {
    if(saving) return;
    if (requiredReason && !reason.trim()) return;
    setSubmitError("");
    let relations: unknown;
    if (!showClaimNumber && showSection("details") && (!data.composition_name?.trim() || !data.composition_type?.trim())) { setSubmitError("Enter a name and material type."); return; }
    try {
      relations = showClaimNumber ? JSON.parse(relationsText) : data.unrepresented_relations || [];
      if (!Array.isArray(relations)) throw new Error();
      setRelationsError("");
    } catch { setRelationsError(t("Unrepresented relations must be a valid JSON array before saving.")); return; }
    if (draftInvalid) { setShowValidation(true); return; }
    try {
      let next:ReviewCompositionData={...data,unrepresented_relations:relations as unknown[]};
      if(evidenceEditor && spanBridge?.candidate) {
        if(spanBridge.mode === "replace" && spanBridge.selected) next=changeInstanceSpan(next,spanBridge.selected,spanBridge.candidate,spanBridge.content,spanBridge.requireEvidence);
        else next={...next,evidence_spans:[...(next.evidence_spans || []),spanBridge.candidate]};
      }
      void persist(next);
    } catch (error) { setSubmitError(error instanceof Error ? error.message : t("The composition contains an invalid value.")); }
  };

  return <form className={`review-composition-editor${!showClaimNumber ? " review-description-form" : ""}${editScope ? " review-scoped-editor" : ""}${inlineSection ? " review-inline-editor" : ""}${inlineConstituent ? " review-inline-constituent-editor" : ""}`} onSubmit={(event) => { event.preventDefault(); submit(); }}>
    {showClaimNumber && <h3>{submitLabel}</h3>}
    {!editScope?.field && (!editScope || (!showClaimNumber && editScope.kind === "details")) && (showClaimNumber ? <div className="review-fields"><label>{t("Name")}<input value={data.composition_name || ""} onChange={(event) => set({ composition_name: event.target.value })}/></label>{showClaimNumber && <label>{t("Claim no.")}<input value={String(data.claim_no ?? "")} onChange={(event) => set({ claim_no: event.target.value })}/></label>}<label>{t("Type")}<input value={data.composition_type || ""} onChange={(event) => set({ composition_type: event.target.value })}/></label></div> : <section className={`review-instance-section review-instance-details${inheritanceBase(data) ? " review-derived-instance" : ""}`}><header><h3>Instance details</h3></header><div className="review-fields"><label>{t("Name")}<input value={data.composition_name || ""} onChange={(event) => set({ composition_name: event.target.value })}/></label>{showClaimNumber && <label>{t("Claim no.")}<input value={String(data.claim_no ?? "")} onChange={(event) => set({ claim_no: event.target.value })}/></label>}<label>Material type<input value={data.composition_type || ""} onChange={(event) => set({ composition_type: event.target.value })}/></label></div><InheritanceSelector data={data} records={inheritOptions} onChange={next => {setData(next);onDraftChange(true);}}/></section>)}
    {!showClaimNumber && editScope?.field && (editScope.field === "inherits_from" ? <InheritanceSelector data={data} records={inheritOptions} onChange={next => {setData(next);onDraftChange(true);}}/> : <label>{editScope.field === "composition_name" ? "Name" : "Material type"}<input autoFocus value={data[editScope.field] || ""} onChange={event => set({[editScope.field!]:event.target.value})}/></label>)}
    {!showClaimNumber && !inlineSection && !inlineConstituent && (!editScope || ["details","constituent","restriction"].includes(editScope.kind)) && <InheritedInformation data={data} records={inheritOptions}/>}
    {showClaimNumber && inheritOptions.length > 0 && <div className="review-inherit-controls"><label>{t("Inherit constituents from")}<select value={inheritSourceId} onChange={(event) => setInheritSourceId(event.target.value)}><option value="">{t("Select a composition")}</option>{inheritOptions.map((item) => <option key={item.id} value={item.id}>{titleFor(item)}{showClaimNumber ? ` · ${t("Claim")} ${String(item.data.claim_no ?? "—")}` : ""}</option>)}</select></label><button type="button" disabled={!inheritSourceId} onClick={inheritConstituents}>{t("Inherit constituents")}</button></div>}
    {showClaimNumber ? <ConstituentEditor rows={constituents} constraints={constraints} referenceNames={constituentReferenceNames} errors={showValidation ? draftErrors.constituentNames : {}} onNameFocus={beginConstituentRename} onNameBlur={finishConstituentRename} onChange={updateConstituents}/> : showSection("constituent") && <DescriptionConstituents inline={inlineConstituent} onlyIndex={editScope?.index} rows={constituents} evidence={instanceSpans(data)} errors={showValidation ? draftErrors.constituentNames : {}} protectedNames={constraints.flatMap(c => c.member_refs || [])} change={updateConstituents} renderAmount={(row, label, change) => <AmountControls row={row} label={label} labelled compact onChange={change}/>}/>}{(showClaimNumber || showSection("restriction")) && <ConstraintEditor inline={inlineSection} reservedIds={showClaimNumber ? [] : inheritedData.constraints.map(row => String(row.constraint_id))} description={!showClaimNumber} unrepresented={data.unrepresented_relations || []} onlyIndex={editScope?.kind === "restriction" ? editScope.index : undefined} rows={constraints} constituents={[...constituents, ...inherited]} errors={showValidation ? draftErrors.constraints : {}} onChange={next => set({constraints:next})}/>}


    {showClaimNumber && selectedEvidence.length > 0 && <div className="review-action-row"><button type="button" onClick={() => set({ evidence_spans: [...evidence, ...selectedEvidence.filter((span) => !evidence.some((current) => current.start === span.start && current.end === span.end))] })}>{t("Add")}{t("Selected spans")}: {selectedEvidence.length}</button><button type="button" onClick={() => set({ evidence_spans: selectedEvidence })}>{t("Replace evidence with selection")}</button></div>}
    {showClaimNumber && <EditableEvidenceList evidence={evidence} onRemove={(index) => set({ evidence_spans: evidence.filter((_, evidenceIndex) => evidenceIndex !== index) })}/>}
    {!showClaimNumber && showSection("evidence") && <DescriptionEvidenceSection data={data} editing simpleCapture={evidenceEditor} onlySpan={editScope?.kind === "evidence" ? spanBridge?.selected || undefined : undefined} change={next => set(next)}/>}
    {showClaimNumber && <details><summary>{t("Unrepresented relations")}</summary><div className="review-composition-data"><JsonNode label={t("Relations in source")} value={data.unrepresented_relations}/></div><textarea value={relationsText} onChange={(event) => { setRelationsText(event.target.value); setRelationsError(""); onDraftChange(true); }} aria-label={t("Unrepresented relations JSON")}/>{relationsError && <span className="review-inline-error">{relationsError}</span>}</details>}
    {showClaimNumber && <label>{t("Reason")}{requiredReason && <em>{t("required")}</em>}<textarea value={reason} onChange={(event) => { setReason(event.target.value); onDraftChange(true); }} placeholder={t("Explain the change")}/></label>}
    {showClaimNumber && <details><summary>{t("Before / after preview")}</summary><div className="review-composition-data"><JsonNode label={t("Before")} value={initial}/><JsonNode label={t("After")} value={data}/></div></details>}
    {showValidation && !showSection("restriction") && Object.values(draftErrors.constraints).map((errors,index)=>errors.ratio ? <span key={index} className="review-inline-error" role="alert">{errors.ratio}</span> : null)}
    {submitError && <span className="review-inline-error" role="alert">{t(submitError)}</span>}
    {deletion.confirmation}
    <div className="review-action-row">{!savedLegacyRatio && <button className="review-primary" type="submit" disabled={saving || (requiredReason && !reason.trim()) || (showValidation && draftInvalid) || (evidenceEditor && (!spanBridge?.candidate || sameSpan(spanBridge.candidate,spanBridge.selected)))}><Save size={14}/>{saving ? "Saving…" : submitLabel}</button>}{(canDeleteConstituent || (evidenceEditor && spanBridge?.selected)) && <button type="button" className="review-delete-button" disabled={saving} onClick={deleteSection}>{evidenceEditor ? "Delete span" : "Delete constituent"}</button>}<button type="button" disabled={saving} onClick={onCancel} title="Esc">{t("Cancel")}</button></div>
  </form>;
}

function finiteNumberOrNull(value: string) { return value === "" ? null : value; }

function EndpointSelect({ value, onChange, label }: { value: string | null | undefined; onChange: (value: "open" | "closed" | "approx" | null) => void; label?: string }) {
  const t = useReviewTranslation(); return <select aria-label={label} value={value || ""} onChange={(event) => onChange((event.target.value || null) as "open" | "closed" | "approx" | null)}><option value="">{t("Endpoint")}</option><option value="closed">{t("closed")}</option><option value="open">{t("open")}</option><option value="approx">{t("approx")}</option></select>; }

function BoundaryOptions({ value, onChange, label, disabled }: { value: "open" | "closed" | "approx" | null | undefined; onChange: (value:"open"|"closed"|"approx")=>void; label:string; disabled:boolean }) {
  return <div className="review-boundary-options" role="group" aria-label={label}>{(["closed","open","approx"] as const).map(option => <button type="button" key={option} disabled={disabled} aria-pressed={value === option} onClick={() => onChange(option)}>{option === "closed" ? "Closed" : option === "open" ? "Open" : "Approx"}</button>)}</div>;
}

function AmountControls({ row, label, labelled = false, compact = false, onChange, unitControl }: { row: EditableAmount; label: string; labelled?: boolean; compact?: boolean; onChange: (patch: Partial<EditableAmount>) => void; unitControl?: React.ReactElement }) {
  const t = useReviewTranslation();
  const mode = amountMode(row);
  const qualifier = singleValueQualifier(row);
  const field = (caption: string, control: React.ReactElement) => labelled ? <label data-amount-field={caption}>{caption}{control}</label> : control;
  return <>
    {field(t("Amount"), <select aria-label={`${label}: ${t("amount shape")}`} value={mode} onChange={(event) => onChange(amountModePatch(row, event.target.value as AmountMode))}><option value="">{t("None")}</option><option value="single">{t("Single value")}</option><option value="range">{t("Range")}</option><option value="balance">{t("Balance")}</option></select>)}
    {unitControl}
    {mode === "single" && <>
      {field(t("Value"), <input aria-label={`${label}: ${t("amount value")}`} value={String(singleValue(row) ?? "")} onChange={(event) => onChange(singleValuePatch(row, finiteNumberOrNull(event.target.value)))} placeholder={t("Value")}/>)}
      {field(t("Qualifier"), <select aria-label={`${label}: ${t("value qualifier")}`} value={qualifier} onChange={(event) => onChange(singleValueQualifierPatch(row, event.target.value as SingleValueQualifier))}><option value="exact">{t("Exact")}</option><option value="approximate">{t("Approximate")}</option></select>)}
    </>}
    {mode === "range" && <>
      {field(t("Lower bound"), <input aria-label={`${label}: ${t("lower amount")}`} value={String(row.amount_lower_value ?? "")} onChange={(event) => onChange({ amount_lower_value: finiteNumberOrNull(event.target.value) })} placeholder={t("Lower")}/>)}
      {!compact && field(t("Lower endpoint"), <EndpointSelect label={`${label}: ${t("lower endpoint")}`} value={row.amount_lower_endpoint_type} onChange={(value) => onChange({ amount_lower_endpoint_type: value })}/>)}
      {field(t("Upper bound"), <input aria-label={`${label}: ${t("upper amount")}`} value={String(row.amount_upper_value ?? "")} onChange={(event) => onChange({ amount_upper_value: finiteNumberOrNull(event.target.value) })} placeholder={t("Upper")}/>)}
      {!compact && field(t("Upper endpoint"), <EndpointSelect label={`${label}: ${t("upper endpoint")}`} value={row.amount_upper_endpoint_type} onChange={(value) => onChange({ amount_upper_endpoint_type: value })}/>)}
      {compact && <div className="review-boundary-rules"><div className="review-boundary-field"><span>Lower limit</span><BoundaryOptions label={`${label}: lower boundary`} disabled={row.amount_lower_value == null || row.amount_lower_value === ""} value={row.amount_lower_endpoint_type} onChange={value => onChange({amount_lower_endpoint_type:value})}/></div><div className="review-boundary-field"><span>Upper limit</span><BoundaryOptions label={`${label}: upper boundary`} disabled={row.amount_upper_value == null || row.amount_upper_value === ""} value={row.amount_upper_endpoint_type} onChange={value => onChange({amount_upper_endpoint_type:value})}/></div></div>}
    </>}
  </>;
}

function ConstituentEditor({ rows, constraints, referenceNames, errors, onNameFocus, onNameBlur, onChange }: { rows: NonNullable<ReviewCompositionData["constituents"]>; constraints: ReviewConstraint[]; referenceNames: string[]; errors: Record<number, string>; onNameFocus: (index: number) => void; onNameBlur: (index: number) => void; onChange: (rows: NonNullable<ReviewCompositionData["constituents"]>) => void }) {
  const t = useReviewTranslation();
  const update = (index: number, patch: Record<string, unknown>) => onChange(rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  return <section className="review-structured-section"><header><strong>{t("Constituents")}</strong><button type="button" onClick={() => onChange([...rows, { constituent_name: "", constituent_status: "included", amount_comparator: null, amount_unit: null, amount_lower_value: null, amount_upper_value: null, amount_lower_endpoint_type: null, amount_upper_endpoint_type: null }])}><Plus size={13}/> {t("Add")}</button></header>{rows.map((row, index) => {
    const protectedNames = new Set([row.constituent_name, referenceNames[index]].filter(Boolean));
    const referencedBy = constraints.filter((constraint) => (constraint.member_refs || []).some((ref) => protectedNames.has(ref))).map((constraint) => constraint.constraint_id || "unnamed constraint");
    const label = row.constituent_name || `Constituent ${index + 1}`;
    return <div key={index} className="review-constituent-entry"><div className="review-constituent-row"><input aria-label={t("Constituent name")} aria-invalid={Boolean(errors[index])} value={row.constituent_name || ""} onFocus={() => onNameFocus(index)} onBlur={() => onNameBlur(index)} onChange={(event) => update(index, { constituent_name: event.target.value })} placeholder={t("Name")}/><select aria-label={`${label}: ${t("status")}`} value={String(row.constituent_status || "included")} onChange={(event) => update(index, { constituent_status: event.target.value })}><option value="included">{t("included")}</option><option value="excluded">{t("excluded")}</option><option value="optional">{t("optional")}</option></select><AmountControls row={row} label={label} onChange={(patch) => update(index, patch)}/><input aria-label={`${label}: ${t("amount unit")}`} value={String(row.amount_unit || "")} onChange={(event) => update(index, { amount_unit: event.target.value || null })} placeholder={t("Unit")}/><button type="button" disabled={referencedBy.length > 0} title={referencedBy.length ? `Remove from ${referencedBy.join(", ")} first` : undefined} onClick={() => onChange(rows.filter((_, rowIndex) => rowIndex !== index))}>{t("Remove")}</button></div>{errors[index] && <span className="review-inline-error" role="alert">{t(errors[index] || "")}</span>}{referencedBy.length > 0 && <small className="review-reference-note">{t("Used by")}{referencedBy.join(", ")}{t(". Remove its membership before deleting this constituent.")}</small>}</div>;
  })}</section>;
}

function ConstraintEditor({ inline = false, description = false, unrepresented = [], rows, constituents, errors, onChange, onlyIndex, reservedIds = [] }: { inline?: boolean; reservedIds?: string[]; onlyIndex?: number; description?: boolean; unrepresented?:unknown[]; rows: ReviewConstraint[]; constituents: NonNullable<ReviewCompositionData["constituents"]>; errors: Record<number, ConstraintDraftFieldErrors>; onChange: (rows: ReviewConstraint[]) => void }) {
  const t = useReviewTranslation();
  const update = (index: number, patch: Partial<ReviewConstraint>) => onChange(rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  const names = selectableConstituentNames(constituents);
  if (description) names.sort((a,b) => a.localeCompare(b,"en",{sensitivity:"base",numeric:true}));
  const add=(ratio=false)=>onChange([...rows,{constraint_id:nextConstraintId([...rows,...reservedIds.map(constraint_id=>({constraint_id}))]),...(description && ratio ? {mode:"ratio",member_refs:[],ratio_values:[]} : {mode:"sum",member_refs:[],constituent_status:"included",selection:{min:null,max:null},amount_comparator:null,amount_unit:null,amount_lower_value:null,amount_upper_value:null,amount_lower_endpoint_type:null,amount_upper_endpoint_type:null,...(!description?{evidence:""}:{})})}]);
  return <section className={inline ? "review-inline-restriction-fields" : `review-structured-section${description ? " review-restrictions" : ""}`} >{!inline && <header><strong>{description ? "Constituent restrictions" : t("Constraints")}</strong>{onlyIndex == null && (description ? <AddRestrictionButtons onAdd={add}/> : <button type="button" onClick={()=>add()}><Plus size={13}/>{t("Add")}</button>)}</header>}{rows.map((row, index) => {
    if (onlyIndex != null && onlyIndex !== index) return null;
    const rowErrors = errors[index] || {};
    if(description && row.mode === "ratio")return <div className="review-constraint-row" key={index}><DescriptionRatioEditor row={row} constituents={constituents} onChange={next=>onChange(rows.map((current,i)=>i===index?next:current))}/>{rowErrors.ratio && <span className="review-inline-error" role="alert">{rowErrors.ratio}</span>}<button type="button" className="review-constraint-remove" onClick={()=>onChange(rows.filter((_,i)=>i!==index))}>Delete restriction</button></div>;

    const refs = row.member_refs || [];
    const invalidRefs = refs.map((ref, refIndex) => ({ ref, refIndex })).filter(({ ref }) => !names.includes(ref));
    return <div className="review-constraint-row" key={index}>
      {!description && <div className="review-constraint-fields"><label>{t("Constraint ID")}<input aria-invalid={Boolean(rowErrors.constraint_id)} value={row.constraint_id || ""} onChange={(event) => update(index, { constraint_id: event.target.value })} placeholder={t("Constraint ID")}/></label><label>{t("Mode")}<select value={row.mode || "sum"} onChange={(event) => update(index, { mode: event.target.value })}><option value="sum">{t("sum")}</option><option value="any_of">{t("any of")}</option></select></label><label>{t("Status")}<select value={row.constituent_status || "included"} onChange={(event) => update(index, { constituent_status: event.target.value })}><option value="included">{t("included")}</option><option value="excluded">{t("excluded")}</option><option value="optional">{t("optional")}</option></select></label><label>{t("Selection min")}<input aria-invalid={Boolean(rowErrors.selection)} value={String(row.selection?.min ?? "")} onChange={(event) => update(index, { selection: { ...(row.selection || {}), min: event.target.value || null } })} placeholder={t("Min")}/></label><label>{t("Selection max")}<input aria-invalid={Boolean(rowErrors.selection)} value={String(row.selection?.max ?? "")} onChange={(event) => update(index, { selection: { ...(row.selection || {}), max: event.target.value || null } })} placeholder={t("Max")}/></label><AmountControls row={row} label={row.constraint_id || `Constraint ${index + 1}`} labelled compact={description} onChange={(patch) => update(index, patch)}/><label>{t("Unit")}<input value={row.amount_unit || ""} onChange={(event) => update(index, { amount_unit: event.target.value || null })}/></label></div>}
      {rowErrors.constraint_id && <span className="review-inline-error" role="alert">{t(rowErrors.constraint_id || "")}</span>}
      <fieldset className="review-member-selector" aria-invalid={Boolean(rowErrors.member_refs)}><legend>{description ? "Constituents" : t("Members")}</legend>{names.length ? <div className="review-member-options">{names.map((name) => <label key={name}><input type="checkbox" checked={refs.includes(name)} onChange={(event) => update(index, { member_refs: toggleConstraintMember(refs, name, event.target.checked) })}/><span>{name}</span></label>)}</div> : <small>{t("Add unique constituent names before selecting members.")}</small>}{invalidRefs.length > 0 && <div className="review-invalid-members"><span>{t("Unresolved references:")}</span>{invalidRefs.map(({ ref, refIndex }) => <button type="button" key={`${ref}:${refIndex}`} onClick={() => update(index, { member_refs: refs.filter((_, indexToKeep) => indexToKeep !== refIndex) })}>{ref || "(blank)"} <X size={12}/></button>)}</div>}{rowErrors.member_refs && <span className="review-inline-error" role="alert">{t(rowErrors.member_refs || "")}</span>}</fieldset>
      {!description && rowErrors.selection && <span className="review-inline-error" role="alert">{t(rowErrors.selection || "")}</span>}
      {description && <div className="review-restriction-amount">
        <strong>Combined constituent concentration</strong>
        <div className="review-constraint-fields"><AmountControls row={row} label={row.constraint_id || `Restriction ${index + 1}`} labelled compact onChange={patch => update(index,patch)} unitControl={<label>Unit<input value={row.amount_unit || ""} onChange={event => update(index,{amount_unit:event.target.value || null})} placeholder="e.g. wt%"/></label>}/></div>
      </div>}
      {description && <fieldset className="review-restriction-counts"><legend>Number included <small>(optional)</small></legend><div className="review-constraint-fields review-restriction-selection">
        <label>Minimum<input aria-label="Minimum included" aria-invalid={Boolean(rowErrors.selection)} inputMode="numeric" value={String(row.selection?.min ?? "")} onChange={event => update(index,descriptionRestrictionSelectionPatch(row,"min",event.target.value))} placeholder="No minimum"/></label>
        <label>Maximum<input aria-label="Maximum included" aria-invalid={Boolean(rowErrors.selection)} inputMode="numeric" value={String(row.selection?.max ?? "")} onChange={event => update(index,descriptionRestrictionSelectionPatch(row,"max",event.target.value))} placeholder="No maximum"/></label>
      </div>{rowErrors.selection && <span className="review-inline-error" role="alert">{t(rowErrors.selection || "")}</span>}</fieldset>}
      {!description && <label className="review-constraint-evidence">{t("Constraint evidence")}<em>{t("required")}</em><textarea aria-invalid={Boolean(rowErrors.evidence)} value={row.evidence || ""} onChange={(event) => update(index, { evidence: event.target.value })} placeholder={t("Source wording for this relationship")}/></label>}
      {!description && rowErrors.evidence && <span className="review-inline-error" role="alert">{t(rowErrors.evidence || "")}</span>}
      <button className="review-constraint-remove" type="button" onClick={() => onChange(rows.filter((_, rowIndex) => rowIndex !== index))}>{description ? "Delete restriction" : t("Remove constraint")}</button>
    </div>;
  })}{description && !inline && <UnrepresentedRestrictions values={unrepresented}/>}</section>;
}

function EvidenceList({ evidence }: { evidence: RawEvidence[] }) {
  const t = useReviewTranslation();
  return evidence.length ? <details className="review-evidence-details"><summary>{t("Composition evidence (")}{evidence.length})</summary><div className="review-evidence-list">{evidence.map((span, index) => <SourceLink key={`${span.start}:${span.end}:${index}`} value={span} label={`${t("Composition evidence")} ${index + 1}`}><span>{index + 1}. {evidencePreview(span.evidence_text)}</span></SourceLink>)}</div></details> : null;
}
function EditableEvidenceList({ evidence, onRemove }: { evidence: RawEvidence[]; onRemove: (index: number) => void }) {
  const t = useReviewTranslation();
  return <div className="review-evidence-list">{evidence.length ? evidence.map((span, index) => <div className="review-editable-evidence" key={`${span.start}:${span.end}:${index}`}><SourceLink value={span} label={`${t("Evidence")} ${index + 1}`}><span>{index + 1}. {evidencePreview(span.evidence_text)}</span></SourceLink><button type="button" onClick={() => onRemove(index)}>{t("Remove span")}</button></div>) : <small>{t("No evidence spans attached.")}</small>}</div>;
}


function SourceMetadata({ document, editable, onAction, onDraftChange }: { document: ReviewDocument; editable: boolean; onAction: (action: ReviewAction, options?: { data?: unknown; reason?: string; actionId?: string }) => Promise<unknown>; onDraftChange: (next: boolean) => void }) {
  const t = useReviewTranslation();
  const original = JSON.stringify({ meta: document.meta || {}, source_quality: document.source_quality || {} }, null, 2);
  const [open, setOpen] = React.useState(false); const [value, setValue] = React.useState(original); const [reason, setReason] = React.useState(""); const [parseError, setParseError] = React.useState(""); const actionId = React.useRef(newActionId());
  const save = async () => {
    let data: unknown;
    try { data = JSON.parse(value); setParseError(""); } catch { setParseError(t("Metadata must be valid JSON before it can be saved.")); return; }
    const saved = await onAction("metadata", { data, reason, actionId: actionId.current });
    if (saved) { setReason(""); actionId.current = newActionId(); onDraftChange(false); }
  };
  return <details className="review-metadata" open={open} onToggle={(event) => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}><summary>{t("Source quality and unrepresented metadata")}{document.source_quality && <CircleAlert size={14}/>}</summary>{open && <><div className="review-composition-data"><JsonNode label={t("Source metadata")} value={{ meta: document.meta, source_quality: document.source_quality }}/></div>{editable && <div className="review-metadata-edit"><textarea value={value} onChange={(event) => { setValue(event.target.value); onDraftChange(true); }} aria-label={t("Source metadata JSON")}/><input value={reason} onChange={(event) => { setReason(event.target.value); onDraftChange(true); }} placeholder={t("Reason required for metadata changes")}/>{parseError && <span className="review-inline-error">{parseError}</span>}<button disabled={!reason.trim()} onClick={() => void save()}>{t("Save metadata")}</button></div>}</>}</details>;
}

function CheckerControls({ status, reason, setReason, onAction, disabled = false, admin = false, canFinalize = false }: { disabled?: boolean; admin?: boolean; canFinalize?: boolean; status: ReviewDocument["status"]; reason: string; setReason: (value: string) => void; onAction: (action: ReviewAction) => void }) {
  const t = useReviewTranslation();
  const finalizableStatus = status === "submitted" || (admin && ["not_started", "in_review", "returned"].includes(status));
  return <div className="review-checker-controls">
    <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t("Return or reopen note")}/>
    {finalizableStatus && <button className="review-primary" disabled={disabled || !canFinalize} onClick={() => onAction("finalize")}>{t("Finalize")}</button>}
    {status === "submitted" && <button disabled={disabled || !reason.trim()} onClick={() => onAction("return")}>{t("Return")}</button>}
    {status === "finalized" && <button disabled={disabled || !reason.trim()} onClick={() => onAction("reopen")}>{t("Reopen")}</button>}
    {finalizableStatus && !canFinalize && <small>{t("Complete all decisions and the source check, and select a non-adjudication outcome before finalizing. Blocking source gaps must be resolved.")}</small>}
  </div>;
}

function CheckerInspection({ document, summary, onSelect }: { document: ReviewDocument; summary?: ReviewRecordSummary; onSelect: (compositionId: string) => void }) {
  const t = useReviewTranslation();
  const current = { meta: document.meta, source_quality: document.source_quality, compositions: document.compositions.map((entry) => ({ id: entry.id, origin: entry.origin, decision: entry.decision, deleted: entry.deleted, data: entry.data })) };
  const groups = summary?.canonical_groups || [];
  const ambiguous = summary?.ambiguous_candidate_groups || [];
  const compositionFor = (id: string) => document.compositions.find((entry) => entry.id === id);
  return <section className="review-checker-inspection">
    <details><summary>{t("Seed / current comparison")}</summary><div className="review-composition-data"><JsonNode label={t("Seed")} value={document.baseline}/><JsonNode label={t("Current")} value={current}/></div></details>
    <details><summary>{t("Duplicate candidate inspection (")}{ambiguous.length})</summary>{ambiguous.length ? ambiguous.map((candidate, index) => <section className="review-duplicate-candidate" key={`${candidate.join(":")}:${index}`}><strong>{t("Candidate")}{index + 1} · {candidate.length} {t("canonical groups")}</strong>{candidate.map((signature) => { const group = groups.find((item) => item.signature_sha256 === signature); return <div key={signature}><small>{group?.group_id || signature}</small><div>{(group?.mention_ids || []).map((id) => { const composition = compositionFor(id); return <button type="button" key={id} onClick={() => onSelect(id)}>{id} · {composition ? `${titleFor(composition)} · ${t("Claim")} ${String(composition.data.claim_no ?? "—")}` : t("Missing mention")}</button>; })}</div></div>; })}</section>) : <p>{t("No ambiguous duplicate candidates reported by the shared normalizer.")}</p>}</details>
  </section>;
}

function History({ events }: { events: ReviewDocument["events"] }) {
  const t = useReviewTranslation(); return <details className="review-history"><summary>{t("Action history (")}{events.length})</summary>{events.length ? <ol>{[...events].reverse().map((event, index) => <li key={event.id || event.action_id || index}><strong>{t(event.action)}</strong> {event.actor && <>{t("by")}{event.actor}</>} {event.reason && <span>— {event.reason}</span>}<small>{event.timestamp || event.created_at ? String(event.timestamp || event.created_at) : ""}</small>{(event.before !== undefined || event.after !== undefined) && <details><summary>{t("Before / after")}</summary><div className="review-composition-data"><JsonNode label={t("Before")} value={event.before}/><JsonNode label={t("After")} value={event.after}/></div></details>}</li>)}</ol> : <p>{t("No committed actions yet.")}</p>}</details>; }

export function ReviewWorkspace(props: React.ComponentProps<typeof ReviewWorkspaceContent>) { const chinese = props.workspace.key === "patent-claims-cn"; return <ReviewLocale.Provider value={chinese}><div lang={chinese ? "zh-CN" : "en"}><ReviewWorkspaceContent key={props.workspace.key} {...props}/></div></ReviewLocale.Provider>; }
