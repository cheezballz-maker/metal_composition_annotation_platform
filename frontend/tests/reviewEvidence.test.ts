import { resolveEvidence } from "../src/review/evidence";
import { codePointLength, codePointSlice, utf16ToCodePointOffset } from "../src/review/rawSource";

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const source = '<p>😀 C + Si &lt; 4</p><p>C + Si &lt; 4</p>';
const first = utf16ToCodePointOffset(source, source.indexOf('C +'));
const second = utf16ToCodePointOffset(source, source.lastIndexOf('C +'));
const text = 'C + Si &lt; 4';
const span = { start: second, end: second + codePointLength(text), evidence_text: text };
expect(resolveEvidence(span, source)[0].start === second, 'Stored offsets win over repeated evidence text');
expect(resolveEvidence({ start_offset: second, end_offset: span.end }, source)[0].evidence_text === text, 'Offset-only objects use exact raw text');
const nested = resolveEvidence({ unrepresented_relations: [{ evidence_spans: [span, span] }] }, source);
expect(nested.length === 1 && nested[0].start === second, 'Nested relation spans are collected and deduplicated');
const scoped = resolveEvidence({ evidence: text }, source, [span]);
expect(scoped.length === 1 && scoped[0].start === second, 'Text-only evidence searches inside composition scope');
expect(resolveEvidence({ evidence: text }, source).length === 2, 'Ambiguous exact text exposes all matches, not an arbitrary first match');
expect(resolveEvidence({ evidence: text }, source, []).length === 0, 'An empty explicit scope does not search the whole document');
expect(resolveEvidence({ constituent_name: 'C' }, source).length === 0, 'Constituent names do not invent evidence');
for (const invalid of [{ start: -1, end: 4 }, { start: 2, end: 2 }, { start: 0.5, end: 4 }, { start: 0, end: 900 }]) {
  expect(resolveEvidence({ ...invalid, evidence_text: text }, source).length === 0, 'Invalid offsets cannot fall back to another occurrence');
}
const combined = resolveEvidence({ evidence: [{ start: first, end: first + text.length }], evidence_spans: [span] }, source);
expect(combined.length === 2, 'Both evidence fields remain available');
expect(codePointSlice(source, nested[0].start, nested[0].end) === text, 'Unicode and markup do not shift raw offsets');
console.log('review evidence resolution tests passed');
