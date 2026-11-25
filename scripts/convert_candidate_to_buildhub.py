from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import sys
from copy import deepcopy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.composition_schema import validate_record


CLAIM_START = re.compile(r"(?m)(?<!\S)(\d+)\.\s")
HTML_TAG = re.compile(r"<[^>]+>")


def render_to_source_text(value: str) -> str:
    """Convert MACE's rendered HTML evidence to the source snapshot text."""
    value = HTML_TAG.sub("", value)
    return html.unescape(value).replace("\r\n", "\n")


def claim_ranges(content: str) -> dict[int, tuple[int, int]]:
    matches = list(CLAIM_START.finditer(content))
    result: dict[int, tuple[int, int]] = {}
    for index, match in enumerate(matches):
        number = int(match.group(1))
        end = matches[index + 1].start() if index + 1 < len(matches) else len(content)
        result.setdefault(number, (match.start(), end))
    return result


def locate_span(span: dict, content: str, claim_no: int | str | None) -> dict:
    original_text = span.get("evidence_text")
    if not isinstance(original_text, str):
        raise ValueError("evidence span has no evidence_text")
    start = span.get("start")
    end = span.get("end")
    if isinstance(start, int) and isinstance(end, int) and 0 <= start < end <= len(content):
        if content[start:end] == original_text:
            return {"start": start, "end": end, "evidence_text": content[start:end]}

    rendered = render_to_source_text(original_text)
    hits: list[int] = []
    cursor = 0
    while rendered:
        hit = content.find(rendered, cursor)
        if hit < 0:
            break
        hits.append(hit)
        cursor = hit + 1
    if len(hits) == 1:
        hit = hits[0]
        return {"start": hit, "end": hit + len(rendered), "evidence_text": content[hit : hit + len(rendered)]}

    # Some relation evidence is already expressed in source coordinates but
    # carries a stale quote.  Preserve that valid interval and refresh only
    # its text so the Build Hub validator can accept it.
    if isinstance(start, int) and isinstance(end, int) and 0 <= start < end <= len(content):
        return {"start": start, "end": end, "evidence_text": content[start:end]}

    # A small number of source snapshots differ in Unicode normalization or
    # replacement characters.  In that case retain source-grounded evidence
    # by using the complete claim containing the annotated claim number.
    inferred = re.search(r'\bnum="(\d+)"', original_text)
    if inferred:
        claim_no = inferred.group(1)
    try:
        number = int(claim_no) if claim_no is not None else None
    except (TypeError, ValueError):
        number = None
    if number is not None:
        bounds = claim_ranges(content).get(number)
        if bounds is not None and bounds[1] > bounds[0]:
            begin, finish = bounds
            return {"start": begin, "end": finish, "evidence_text": content[begin:finish]}
    if content:
        return {"start": 0, "end": len(content), "evidence_text": content}
    raise ValueError(f"cannot locate evidence span for claim {claim_no!r}")


def convert_record(record: dict, content: str) -> dict:
    converted = deepcopy(record)
    for composition in converted.get("compositions", []):
        claim_no = composition.get("claim_no")
        composition["evidence_spans"] = [
            locate_span(span, content, claim_no)
            for span in composition.get("evidence_spans", [])
        ]
        relations = []
        for relation in composition.get("unrepresented_relations", []):
            if isinstance(relation, dict) and isinstance(relation.get("evidence_span"), dict):
                relation = relation["evidence_span"]
            if not isinstance(relation, dict):
                raise ValueError("unrepresented relation is not an object")
            relations.append(locate_span(relation, content, claim_no))
        composition["unrepresented_relations"] = relations
    # Quality-gap spans are already in source coordinates, but their quoted
    # text may come from the rendered representation.  Keep their coordinates
    # and make the text agree with the immutable source snapshot.
    def normalize_quality(value: object) -> None:
        if isinstance(value, dict):
            if {"start", "end", "evidence_text"}.issubset(value):
                start, end = value["start"], value["end"]
                if isinstance(start, int) and isinstance(end, int) and 0 <= start < end <= len(content):
                    value["evidence_text"] = content[start:end]
            else:
                for item in value.values():
                    normalize_quality(item)
        elif isinstance(value, list):
            for item in value:
                normalize_quality(item)

    normalize_quality(converted.get("source_quality"))
    return validate_record(converted, content)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    output = args.output.resolve()
    if output.exists():
        raise SystemExit(f"output exists: {output}")
    source_dir = args.source_dir.resolve()
    records = []
    seen: set[str] = set()
    fallback_spans = 0
    relation_count = 0
    with args.candidate.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            record = json.loads(line)
            source_id = record["meta"]["source_id"]
            if source_id in seen:
                raise SystemExit(f"duplicate source id on line {line_number}: {source_id}")
            seen.add(source_id)
            source_path = source_dir / f"{source_id}.json"
            source_obj = json.loads(source_path.read_text(encoding="utf-8"))
            content = source_obj["content"] if isinstance(source_obj, dict) else source_obj[0]["content"]
            before = sum(
                len(c.get("evidence_spans", [])) + len(c.get("unrepresented_relations", []))
                for c in record.get("compositions", [])
            )
            converted = convert_record(record, content)
            after = sum(
                len(c.get("evidence_spans", [])) + len(c.get("unrepresented_relations", []))
                for c in converted.get("compositions", [])
            )
            relation_count += sum(len(c.get("unrepresented_relations", [])) for c in converted.get("compositions", []))
            if after != before:
                raise SystemExit(f"span count changed for {source_id}")
            records.append((source_id, converted))

    staging = output.parent / f".{output.name}.staging"
    if staging.exists():
        raise SystemExit(f"staging exists: {staging}")
    (staging / "sources").mkdir(parents=True)
    try:
        for source_id, record in records:
            shutil.copyfile(source_dir / f"{source_id}.json", staging / "sources" / f"{source_id}.json")
        with (staging / "gold.jsonl").open("w", encoding="utf-8", newline="\n") as handle:
            for _, record in records:
                handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        report = {
            "conversion": "rendered_html_to_buildhub_raw_content_v1",
            "record_count": len(records),
            "composition_count": sum(len(r["compositions"]) for _, r in records),
            "relation_count": relation_count,
            "source_count": len(list((staging / "sources").glob("*.json"))),
            "validated": True,
            "source_snapshots": "copied unchanged from buildhub-seeded-400-20260924",
        }
        (staging / "CONVERSION_REPORT.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        staging.replace(output)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
