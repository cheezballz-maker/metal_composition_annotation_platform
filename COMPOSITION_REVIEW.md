# Composition review workspace

Composition review is the application's only workflow. It stores raw-source Unicode-code-point evidence, individual review decisions, and attributed action history. Set `ANNOTATION_REVIEW_WORKSPACE` to an imported review workspace and configure authenticated accounts.

## Review workspaces

Each collection has a manifest, exact source snapshots and mutable review
documents. Supply datasets independently; this repository contains no live data.
Manifest assignments and checker permissions must match authenticated usernames.

Create new claims/description workspaces with the import scripts and explicit
input/output paths. Importers refuse an existing output directory. Preserve live
review state rather than reimporting over it.

## Local activation or later rollout

Set `ANNOTATION_REVIEW_WORKSPACE` to the absolute imported workspace path in the server environment. Configure existing application authentication (`ANNOTATION_USERS_JSON` and, for session login, `ANNOTATION_SESSION_SECRET`) with individual accounts. Then build the frontend and start the backend:

```sh
cd frontend
npm run build
cd ..
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --workers 1
```

Signing in opens the composition review queue directly. Review storage uses locks within one process, so run one backend worker. Multiple workers or replicas require shared locking or transactional storage first.

For upgrades, back up existing work and retain the shared review workspace and credentials. Do not rerun the importer over live data. The current Build Hub deployment has the `admin` application account; reviewer assignments do not imply that their login accounts have been provisioned.

## Review and checking (claims)

Every seed composition begins pending and needs an accept, edit, or delete decision. Edits and deletions require reasons. Added compositions require claim association and exact raw-source evidence. Select source text to collect multiple separate spans, or open the add form first and collect evidence while editing.

Submission requires all seed decisions and an explicit acknowledgment that the source was checked for missed compositions. Empty results require **Reviewed — no compositions found**. Source-quality gaps remain visible; missing images display their raw tags. Missing or unreadable source material requires adjudication and blocks normal finalization. Other extraction warnings remain accessible without automatically blocking finalization; a reviewer can explicitly request adjudication for them.

Checkers can inspect all records, return submitted work with a note, make attributed corrections, and explicitly finalize the current revision. A finalized record must be reopened before further corrections. Stale saves fail instead of overwriting newer work; retrying a committed request does not duplicate its history.

The authenticated `admin` account, when listed among the dataset checkers, has the administrator role. It can review and submit any assigned record, finalize completed records directly from not-started, in-review, returned, or submitted status, and return or reopen records through the existing workflow. Reviewer assignments are preserved. Finalization still requires valid annotations, all seed decisions, the source-check acknowledgment, and a non-adjudication outcome with no blocking source gaps. Finalized records must be reopened before editing, and all admin actions are attributed in the audit history. Ordinary reviewer and checker permissions are unchanged.

## Export contract

The API provides `GET /api/review/export?mode=progress` and `?mode=final`. Reviewers receive only their assigned records in progress exports. Final exports require checker access. Claims require every dataset record finalized at its current revision; descriptions require every document complete, valid annotations, and a completion event matching its current revision. Legacy submitted description records with a matching submission event are accepted without rewriting stored reviews.

## Multiple source collections

Set `ANNOTATION_REVIEW_WORKSPACES_JSON` to a JSON array of workspace descriptors with `key`, `label`, `source_kind`, and `path`. The application lists authorized collections at `GET /api/review/workspaces`; queue, record, action, and export requests select one with the `workspace` query parameter. `ANNOTATION_REVIEW_WORKSPACE` remains supported for a single legacy workspace.

The current interface treats claims and descriptions according to their source structure. Claim records retain claim numbers. Description records use evidence occurrence order and exact source spans without assuming stable paragraph or section numbering. Queue warnings use only three compact indicators: OCR issue, ambiguous, and source gap.

Both collections identify their source as a patent and use `meta.section` to distinguish `claim` from `description`. Description annotation records omit `meta.source_sha256` because source and snapshot hashes are held in the workspace manifest, and they omit `claim_no` from every composition. Claims continue to require `claim_no`. Description extraction and review coordinates refer directly to the raw retrieved description; no rendered-to-raw projection artifact is created.

Create a description review workspace with `scripts/import_description_review.py`. It verifies source hashes and every half-open Unicode evidence span, maps `occurrence_no` to the platform's stable internal `node_no`, and refuses to overwrite an existing workspace.

Each ZIP contains:

- `gold.jsonl`: retained composition mentions and source-quality metadata in the supplied schema.
- `sources/`: exact source JSON snapshots.
- `summary.json` and `per-source.csv`: mention counts, per-source unique counts, coverage, workflow state, and stable mention-to-canonical-group mappings.
- `audit.jsonl`: attributed actions, reasons, prior/new revisions, and deleted data.
- `manifest.json`: source hashes, seed/projection hashes, exported revisions, and raw-offset contract.

Offsets are half-open Unicode-code-point ranges in the exact decoded source `content`. Each `evidence_text` equals `content[start:end]`. Display coordinates are transient and never exported.

Normalization version `composition-conservative-v1` ignores mention location, evidence multiplicity, and nonsemantic ordering. It preserves case, constituent multiplicity, null versus zero, endpoint semantics, constraints, and unit bases. No chemical aliases or unit conversions are approved in this version. Dataset-wide distinct signatures are reported separately from the sum of per-source unique counts. Candidate groups that differ in name or unrepresented relation meaning remain separate for checker inspection.

## Verification

Install `pytest` and `httpx` in the backend test environment in addition to the backend runtime requirements.

```sh
python -m pytest backend/tests
cd frontend
npm run test:review-mapper
npm run build
```

Software tests validate application behavior; they do not establish annotation completeness.

## Description ranges and inheritance

These optional extensions apply only to `meta.section: "description"`. Existing
scalar annotations remain valid and are not automatically rewritten. Claims
retain their existing schema and controls.

For multiple amounts on one constituent, use `amounts` instead of the constituent's
scalar `amount_*` fields. Each entry keeps the existing comparator, unit, numeric
bounds and endpoint types, plus:

| Field | Meaning |
|---|---|
| `preferred_order` | Integer: `0` = Base; `1`, `2`, ... = increasingly preferred within this constituent. Ranked amounts omit `role`. |
| `role` | Retained for existing legacy annotations and unranked `alternative` entries. Alternatives do not receive `preferred_order`. |
| `evidence_spans` | Exact supporting source spans. An unstated Base uses an empty list; stated amounts require evidence. |
| `variant_ref` | Optional shared label linking amounts across constituents that must be interpreted together. Do not mix amounts from different variants into an invented composition. |

For example, a constituent may have a general 3–20 wt% range and a preferred
5–18 wt% range. Both keep their own units, endpoints and evidence. These are two
qualifications of one constituent, not two independently counted composition
occurrences. Narrower numbers alone do not prove preference: follow the source.

Preferred orders are unique and consecutive and the array stores them in that
order. Base is fixed at order `0`. When only preferred concentrations are stated,
Base is shown with no values and saved as null amount fields with empty evidence;
it is a placeholder, not an extracted concentration. The UI displays missing
values as "—", not the literal string "-" in numeric fields. Existing preferred-only
and scalar annotations remain readable without a bulk migration. Preference
numbers apply within one constituent, not across different constituents.

In Patent Descriptions, use the **Add preferred range N** button, then enter the
stated concentration. **Move up** and **Move down** change preference order;
Base stays fixed. Deletion renumbers the preferred rows. Base cannot be relabeled as preferred
through a dropdown. New preferred rows reuse composition evidence, without
additional source or formulation selectors.

Click a local constituent to edit it inline at its alphabetical position; other
confirmed constituents remain visible. Hover over an item to reveal its delete X.
Deleting a constituent used by local restrictions opens an inline confirmation
to remove the constituent and those restrictions together. Cancel keeps both;
Ctrl+Z restores the complete change. Unreferenced constituents delete directly.
Preferred amounts retain their individual delete controls. Local and inherited
lists display alphabetically without rewriting stored order. Cancel/Esc discards
the open draft. Existing instances have no whole-record editor; the form used to
create a new composition remains available through Add composition.

**Save changes** in a section editor saves that section's changes to its containing
composition; it does not finalize the document. Unrelated constituents and
restriction amounts are not normalized or rewritten. Validation errors preserve
the draft, no-op saves show "No changes to save", and only actual revision
mismatches show the update-conflict panel. Transport/server failures may offer a
retry because their persistence outcome is uncertain. Cancel/Esc discards drafts.

### Constituent ratios in Patent Descriptions

Use **+ Ratio restriction** under Constituent restrictions. All local and inherited
constituent names appear in alphabetical order, each with a single value starting
at 0. Enter coefficients directly: A=1, B=2, C=0 saves A:B = 1:2. Zero (or a cleared
field) means unused; it is omitted from the saved ratio. At least two positive
finite values are required. The preview follows display order, keeping names and
values paired. No selection checkboxes, ordering controls, concentration
calculation, value/range selector or ratio range inputs are presented.

```json
{"constraint_id":"k3","mode":"ratio","member_refs":["A","B"],"ratio_values":[1,2]}
```

The existing ratio schema remains compatible. New UI entries save only nonzero
scalar values. Earlier calculated, ranged or explicitly zero-containing ratios
remain readable/exportable exactly as stored; their old editor controls are not
shown. To replace one, delete that restriction and add a new ratio restriction.
Opening or cancelling an editor never converts existing data. Inherited ratios
remain read-only. Inline save/cancel/Esc, delete and Ctrl+Z retain their behavior.
The companion **+ Concentration restriction** action retains the concentration
and optional member-count editor. Claims controls and stored inheritance links
are unchanged.

### Add-only inheritance in Patent Descriptions

An inherited instance is a separate composition with the same editable fields as
an ordinary instance. Click **Instance details → Inherits from** and select a
retained instance by its number and name. Its constituents, preferred amounts and
restrictions appear in a gray **Inherited / Read-only** section with no interactive
controls. Enter only the child's additions in its ordinary editable sections.
The details card has a dotted border and names its base. Navigation groups each
base and its descendants with dotted arrows while retaining original instance
numbers. A parent with one child has a direct downward badge-to-badge arrow. A
parent with multiple children has one shared left-side trunk and horizontal
arrows into each child's badge. Nested branching families use separate gutter
lanes; badges and names shift right to make room. The list displays only the index and composition
name. Hover actions provide delete, recover and acceptance for pending seeds;
there is no composition Edit/Delete menu. Search still filters by evidence fragments.
A hidden parent does not get a substitute badge or dangling connector. Filtering
does not renumber instances.

The child stores one optional field directly on its composition object:

```json
{
  "node_no": 8,
  "inherits_from": 7
}
```

This example shows only the relevant fields. `inherits_from` references the
stable `node_no` of a retained composition in the same description. Omit the
field for an independent instance. The child's existing `constituents` and
`constraints` contain only additions; follow the parent chain to obtain the
complete composition. Exports retain these local additions and the reference,
without duplicating inherited fields.

Add-only behavior is a schema rule. No `kind`, `mode`, `changes`, or separate
link `evidence_span` is created. Existing composition-level evidence remains;
link evidence from older annotations is retained there if it was not already
present. Other source notes remain in `unrepresented_relations`.

Validation rejects repeated or overridden inherited constituents/restrictions,
local exclusions, unavailable/deleted bases, self-links, cycles and provably
impossible percentage totals. Inherited values stay read-only and update when
the base changes; no concentrations are automatically recalculated. Preferred
amounts remain a separate feature. Choosing None removes `inherits_from` and
keeps local additions, without copying the former base.

The deployment migrates existing add-only links while preserving annotations,
parent references, revisions, assignments, review states and historical events.
Undo can read older event snapshots and save their links in the lean format.
Claims are unchanged and reject the new field.

Combined restrictions continue to use separate constraints with stable IDs and
explicit `member_refs` (for example, Cu+Zn <= 25 wt% and Cu+Sn <= 12 wt%). A child
can add a separately identified restriction while preserving the inherited ones.
The description UI calls this section **Constituent restrictions**, including
inherited read-only rules. Its Add restriction button is available when empty and
when creating a composition. Restriction edits stay inline among the confirmed
rules. Description editors use one form with **Constituents**, **Combined constituent
concentration** and optional **Number included** limits. There is no type selector;
internal IDs remain automatic. Restriction `evidence` is removed from descriptions in both the
platform and extraction profile. Current/baseline description rules omit the field;
composition evidence remains intact. Historical action snapshots remain immutable,
and undo strips the retired field before restoring an older annotation. Claims
retain their original editor and evidence requirement.
The **Unrepresented restrictions** subsection displays stored
`unrepresented_relations` as `kind: description`. It is read-only in normal,
inline editors and inherited views, with no Add, Edit or Delete controls. Empty
Unrepresented restrictions subsections are hidden.
Existing entries and their fields remain unchanged when other sections are saved.
The extraction skill supplies these entries; this UI change does not create or
reclassify them. Legacy entries without a description display their source wording.

The unified editor uses a **Constituents** checkbox list and optional combined
concentration and minimum/maximum counts. Leave counts blank unless the source
specifies them. Existing schema modes remain compatible: explicit count edits
set `any_of` when a count is present and `sum` when both counts are cleared.
Untouched legacy modes and counts are preserved. View and inherited summaries
show the same fields without the old mode labels. The redundant group-level Inclusion
control is hidden; existing stored values are preserved. **Balance** remains available
for restrictions describing a shared remainder.

In an existing instance, click an Evidence item to replace it inline, or **Add
span** to open an inline capture editor. Original evidence and New evidence stay
visible together; select text in Source, then **Save changes** or Cancel. The Undo
icon beside New evidence reverses the latest selection within the open editor.
Hover X deletes a span. Shared references remain aligned; required evidence cannot
be removed without replacement. In a new-composition draft, use Add span, select
text in Source and Attach selected span before saving the new composition.
Clicking a source highlight only navigates to its composition, without editing.

Instance details show compact side-by-side Name and Material type fields, with
Inherits from below (None when unset). Each field keeps its width when edited.
The constituent/restriction heading counts are hidden; restriction details align left. Inheritance previews remain
read-only, and saving a field preserves unrelated data. Hover X clears an optional
base link subject to validation; required names/material types cannot be cleared.
Action history remains stored and exported, and is hidden from this UI.

Description review uses three adjacent panes: raw source, an occurrence list, and
the selected record's details. Search filters the list by evidence fragments
(including constituent and relationship evidence), ignoring case, markup and
extra whitespace. Occurrence numbers stay unchanged when filtering. The open
record and any unsaved edit remain available when a search hides that occurrence.
Two draggable dividers adjust the adjacent pane widths; arrow keys also resize,
and double-click or Home restores defaults. Width preferences are remembered in
the browser and fitted to the available screen. Each pane scrolls independently;
small screens stack the panes. Document submission/checking controls are grouped
under **Document review** in the details pane. Headers use Source, Compositions,
and Composition Instance N: name with aligned, equally sized, distinct colors.
The details panel groups instance fields, evidence, constituents, restrictions,
relationships, and review notes without source-quality/origin metadata. Claims
retain their existing view.

## Simplified Patent Descriptions review

Descriptions use **Not started → In review → Finalized**, with **Flagged for review** for unresolved questions. Reviewers inspect each seeded instance and the source for missed instances, then choose **Finalize annotation** from the document menu beside the patent ID. This action records the source-check acknowledgment and determines whether compositions remain. There is no separate checker finalization step for descriptions.

Finalized and flagged descriptions are read-only until the reviewer explicitly chooses **Unlock to review** in the document menu. Viewing, evidence navigation, filtering and exports remain available; adding, editing, deleting, recovering and undoing composition changes are blocked in both the UI and API. The lock also covers legacy submitted records and flagged records whose stored status is still in_review. Unlocking uses the existing `reopen_review` action, preserves compositions and history, and clears the current completion/flag fields; the previous flag reason remains in its audit event. Assigned reviewers and existing checkers/admins retain their existing document access.

Storage retains the original status values and event history for compatibility; deployment does not migrate reviews. New completion actions use the existing finalized state internally. Missing/unreadable source gaps still block completion and can be flagged through **Flag annotation**.

Description edits and soft deletions do not require explanatory notes. Hover a
composition row to delete it, then use Show deleted and Recover to restore it
without renumbering. A base with linked children cannot be deleted until they are
unlinked. Pending seeds retain an Accept hover action. Ctrl+Z undoes saved changes.
Constituents, restrictions, evidence and instance fields edit inline with Save,
Cancel and Esc, retaining the other confirmed sections. Inherited information is
plain read-only text. Empty Unrepresented restrictions subsections are hidden.

New composition editors publish their initial draft before evidence capture begins.
**Add span → select text in Source → Attach selected span** works without editing
any other field or choosing an inherited base. Choosing a base does not change
the capture procedure. Attaching updates the draft; saving persists it, while
Cancel/Esc discards it.

The description UI authors add-only inheritance through Instance details. Audit events, revision conflict protection, idempotent retries, validation, and source snapshots remain in the background. Both claims workspaces retain their original controls and workflow.
