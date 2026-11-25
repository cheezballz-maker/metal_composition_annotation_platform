from __future__ import annotations

import io
import json
import unittest
import zipfile
from copy import deepcopy
from hashlib import sha256

from backend.composition_export import build_export_bundle, canonical_composition, summarize_document


def composition(name="steel", node=1, claim=1):
    return {"node_no": node, "claim_no": claim, "composition_name": name, "composition_type": "alloy",
            "constituents": [{"constituent_name": "Co", "constituent_status": "included", "amount_comparator": "range",
                              "amount_unit": "wt %", "amount_lower_value": 1.0, "amount_upper_value": 2,
                              "amount_lower_endpoint_type": "closed", "amount_upper_endpoint_type": "open"},
                             {"constituent_name": "Fe", "constituent_status": "included", "amount_comparator": "balance",
                              "amount_unit": None, "amount_lower_value": None, "amount_upper_value": None}],
            "constraints": [], "evidence_spans": [{"start": 0, "end": 5, "evidence_text": "steel"}],
            "unrepresented_relations": []}


def fixture(sid="a"):
    record = {"meta": {"source_type": "patent", "source_id": sid, "section": "claim"},
              "compositions": [composition()], "source_quality": {"table_presence": "not_applicable",
              "table_quality": "not_applicable", "gaps": [], "corrections": []}}
    return {"dataset_id": "test", "source_id": sid, "meta": record["meta"], "baseline": deepcopy(record), "source_quality": record["source_quality"],
            "revision": 0, "status": "not_started", "reviewer": "reviewer", "finalized_revision": None,
            "compositions": [{"id": "seed:1", "origin": "seed", "decision": "pending", "deleted": False, "data": composition()}], "events": []}


class NormalizationTests(unittest.TestCase):
    def test_order_numeric_whitespace_and_evidence_are_not_identity(self):
        first = composition()
        second = deepcopy(first)
        second.update(node_no=99, claim_no=8, evidence_spans=[])
        second["composition_name"] = " steel  "
        second["constituents"][0]["amount_lower_value"] = 1
        second["constituents"].reverse()
        self.assertEqual(canonical_composition(first), canonical_composition(second))

    def test_semantic_distinctions_are_preserved(self):
        first = composition()
        for field, value in [("constituent_name", "CO"), ("amount_unit", "vol %"), ("amount_unit", "%"),
                             ("amount_unit", "ppm by weight"), ("amount_lower_value", None),
                             ("amount_lower_value", 0), ("amount_lower_endpoint_type", "approx"),
                             ("amount_lower_endpoint_type", "open"), ("constituent_status", "optional")]:
            with self.subTest(field=field, value=value):
                second = deepcopy(first)
                second["constituents"][0][field] = value
                self.assertNotEqual(canonical_composition(first), canonical_composition(second))
        duplicate = deepcopy(first)
        duplicate["constituents"].append(deepcopy(duplicate["constituents"][0]))
        self.assertNotEqual(canonical_composition(first), canonical_composition(duplicate))

    def test_constraint_order_and_members_preserve_semantics(self):
        first = composition()
        first["constraints"] = [{"constraint_id": "a", "mode": "sum", "member_refs": ["Co", "Fe"],
                                 "selection": {"min": None, "max": 2}, "evidence": "first occurrence"}]
        second = deepcopy(first)
        second["constraints"][0].update(constraint_id="b", member_refs=["Fe", "Co"], evidence="another occurrence")
        self.assertEqual(canonical_composition(first), canonical_composition(second))
        second["constraints"][0]["mode"] = "any_of"
        self.assertNotEqual(canonical_composition(first), canonical_composition(second))
        second = deepcopy(first)
        second["constraints"][0]["selection"]["max"] = 1
        self.assertNotEqual(canonical_composition(first), canonical_composition(second))

    def test_relation_meaning_ignores_raw_tags_offsets_but_keeps_comparisons(self):
        first, second = composition(), composition()
        first["unrepresented_relations"] = [{"start": 10, "end": 50, "evidence_text": "<seg-refi>B<sub>4</sub>C &lt; 5</seg-refi>"}]
        second["unrepresented_relations"] = [{"start": 80, "end": 100, "evidence_text": "B4C < 5"}]
        self.assertEqual(canonical_composition(first), canonical_composition(second))
        second["unrepresented_relations"][0]["evidence_text"] = "B4C < 6"
        self.assertNotEqual(canonical_composition(first), canonical_composition(second))

    def test_mentions_stable_ids_deletion_and_candidate_groups(self):
        doc = fixture()
        doc["compositions"].extend([
            {"id": "seed:2", "origin": "seed", "decision": "accepted", "deleted": False, "data": composition(node=2, claim=2)},
            {"id": "added:a", "origin": "added", "decision": "edited", "deleted": False, "data": composition("renamed", node=3)},
            {"id": "seed:4", "origin": "seed", "decision": "deleted", "deleted": True, "data": composition("different", node=4)}])
        summary = summarize_document(doc)
        self.assertEqual(summary["mention_count"], 3)
        self.assertEqual(summary["unique_composition_count"], 2)
        self.assertEqual(summary["pending_count"], 1)
        self.assertEqual(len(summary["ambiguous_candidate_groups"]), 1)
        self.assertEqual(sorted(x for group in summary["canonical_groups"] for x in group["mention_ids"]), ["added:a", "seed:1", "seed:2"])


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.docs = [fixture("a"), fixture("b")]
        self.snapshots = {sid: json.dumps([{"patent_id": sid, "content": "steel 😀"}]).encode() for sid in ("a", "b")}
        self.manifest = {"dataset_id": "test", "schema_version": "composition-review-v1",
                         "assignments": {"a": "reviewer", "b": "other"}, "sources": {
                             sid: {"file": f"sources/{sid}.json", "content_sha256": sha256("steel 😀".encode()).hexdigest(),
                                   "snapshot_sha256": sha256(data).hexdigest()} for sid, data in self.snapshots.items()}}

    def unpack(self, docs=None, mode="progress"):
        data = build_export_bundle(self.manifest, self.docs if docs is None else docs, self.snapshots, actor="checker", mode=mode)
        return zipfile.ZipFile(io.BytesIO(data))

    def test_progress_raw_roundtrip_coverage_and_cross_source_counts(self):
        with self.unpack() as bundle:
            records = [json.loads(line) for line in bundle.read("gold.jsonl").splitlines()]
            self.assertEqual(records, [doc["baseline"] for doc in self.docs])
            for sid in ("a", "b"):
                self.assertEqual(bundle.read(f"sources/{sid}.json"), self.snapshots[sid])
            summary = json.loads(bundle.read("summary.json"))
            self.assertEqual(summary["mention_count"], 2)
            self.assertEqual(summary["sum_per_source_unique_composition_count"], 2)
            self.assertEqual(summary["dataset_wide_distinct_signature_count"], 1)
        with self.unpack(self.docs[:1]) as bundle:
            manifest = json.loads(bundle.read("manifest.json"))
            self.assertEqual(manifest["omitted_source_count"], 1)
            self.assertEqual(set(manifest["assignments"]), {"a"})
            self.assertEqual(manifest["offset_unit"], "unicode_code_point")
            self.assertNotIn("sources/b.json", bundle.namelist())

    def test_final_requires_complete_current_approvals(self):
        with self.assertRaises(ValueError):
            self.unpack(mode="final")
        for doc in self.docs:
            doc.update(status="finalized", finalized_revision=1, revision=1, source_checked=True, review_outcome="compositions_found")
            doc["compositions"][0]["decision"] = "accepted"
            doc["events"] = [{"action_id": "final", "action": "finalize", "actor": "checker", "role": "checker",
                              "timestamp": "2026-09-15T00:00:00+00:00", "dataset_id": "test", "source_id": doc["source_id"],
                              "previous_revision": 0, "new_revision": 1}]
        with self.unpack(mode="final") as bundle:
            self.assertEqual(json.loads(bundle.read("manifest.json"))["finalized_source_count"], 2)
        with self.assertRaises(ValueError):
            self.unpack(self.docs[:1], mode="final")
        self.docs[0]["revision"] = 2
        with self.assertRaises(ValueError):
            self.unpack(mode="final")

    def test_sources_and_raw_evidence_verified(self):
        self.docs[0]["compositions"][0]["data"]["evidence_spans"][0]["end"] = 6
        with self.assertRaises(ValueError):
            self.unpack()
        self.docs[0] = fixture()
        self.snapshots["a"] = b'[{"content":"changed"}]'
        with self.assertRaises(ValueError):
            self.unpack()

    def test_zero_results_retained_and_deleted_entries_in_audit(self):
        doc = self.docs[0]
        doc["compositions"][0]["deleted"] = True
        event = {"action_id": "delete", "action": "delete", "actor": "reviewer", "role": "reviewer",
                 "timestamp": "2026-09-15T00:00:00+00:00", "source_id": doc["source_id"], "dataset_id": "test",
                 "previous_revision": 0, "new_revision": 1, "reason": "Not a formulation", "before": deepcopy(doc["compositions"][0])}
        doc["events"].append(event)
        with self.unpack([doc]) as bundle:
            self.assertEqual(json.loads(bundle.read("gold.jsonl"))["compositions"], [])
            self.assertEqual(json.loads(bundle.read("audit.jsonl")), event)
            self.assertEqual(json.loads(bundle.read("summary.json"))["mention_count"], 0)

    def test_corrupted_final_state_and_audit_cannot_export(self):
        doc = self.docs[0]
        doc.update(status="finalized", finalized_revision=0)
        self.manifest["sources"].pop("b")
        self.manifest["assignments"].pop("b")
        with self.assertRaisesRegex(ValueError, "acknowledgment"):
            self.unpack([doc], mode="final")
        doc["events"] = [{"action": "delete", "actor": "someone"}]
        with self.assertRaisesRegex(ValueError, "audit"):
            self.unpack([doc])


if __name__ == "__main__":
    unittest.main()
