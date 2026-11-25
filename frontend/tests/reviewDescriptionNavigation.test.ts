import { alphabeticalConstituents, filterOccurrences, fitDescriptionPanels, indexOccurrences, resizeDescriptionPanels } from "../src/review/descriptionNavigation";
import type { ReviewComposition } from "../src/review/types";

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function near(a: number, b: number) { return Math.abs(a - b) < 1e-7; }
const comps: ReviewComposition[] = [
  { id: "a", origin: "seed", decision: "edited", data: { composition_name: "Unrelated title", evidence_spans: [{start: 0, end: 1, evidence_text: "Cu <b>3–20</b> wt%,\n preferably 5–18 wt%."}] } },
  { id: "b", origin: "added", decision: "added", data: { constituents: [{ constituent_name: "Si", amounts: [{role:"preferred", evidence_spans:[{start: 0,end: 1,evidence_text:"Si &lt; 1 wt%"}]}] }] } },
  { id: "c", origin: "seed", decision: "deleted", deleted: true, data: { evidence_spans: [{start:0,end:1,evidence_text:"first fragment"},{start:2,end:3,evidence_text:"second fragment"}] } },
  { id: "d", origin: "seed", decision: "accepted", data: { unrepresented_relations: [{kind:"inherits_from",evidence_span:{start:0,end:1,evidence_text:"same base alloy, with less Cu"}}] } },
];
const indexed = indexOccurrences(comps);
expect(indexed.length === 4, "All records, including deleted ones, remain navigable");
expect(filterOccurrences(indexed,"3–20 wt%, preferably")[0]?.occurrence === 1, "Search tolerates markup and whitespace");
expect(filterOccurrences(indexed,"SI < 1 WT%")[0]?.occurrence === 2, "Nested evidence and decoded symbols are searchable, case-insensitively");
expect(filterOccurrences(indexed,"same base")[0]?.occurrence === 4, "Relationship evidence can find an occurrence without renumbering it");
expect(filterOccurrences(indexed,"Unrelated title").length === 0, "Search matches evidence, not composition names");
expect(filterOccurrences(indexed,"fragment second").length === 0, "Separate evidence spans cannot create a false fragment match");
expect(filterOccurrences(indexed,"   ").length === 4, "Clearing the query restores the full list");

const original = {source:44,list:20};
const first = resizeDescriptionPanels(original,"source",48,1200);
expect(near(first.source + first.list,64), "First divider keeps details width fixed");
const second = resizeDescriptionPanels(original,"details",70,1200);
expect(near(second.source,44) && near(second.list,26), "Second divider resizes the list and details independently of source");
for (const width of [745,900,1200,1800]) {
  const fitted = fitDescriptionPanels({source:70,list:25},width);
  const resized = [fitted,resizeDescriptionPanels(fitted,"source",-100,width),resizeDescriptionPanels(fitted,"source",200,width),resizeDescriptionPanels(fitted,"details",-100,width),resizeDescriptionPanels(fitted,"details",200,width)];
  for (const sizes of resized) {
    expect(sizes.source * width / 100 >= 260 - 1e-7,"Source remains wide enough to read");
    expect(sizes.list * width / 100 >= 160 - 1e-7,"Occurrence list cannot collapse");
    expect((100 - sizes.source - sizes.list) * width / 100 >= 300 - 1e-7,"Details stay wide enough to edit");
  }
}
console.log("description evidence search and pane resize tests passed");

const storedConstituents = [{constituent_name:"Ti"},{constituent_name:"Al"},{constituent_name:"Cu"},{constituent_name:""}];
const beforeSort = JSON.stringify(storedConstituents);
const sorted = alphabeticalConstituents(storedConstituents);
expect(sorted.map(e=>e.row.constituent_name).join(",") === "Al,Cu,Ti,", "Named constituents sort alphabetically, with unsaved unnamed entries last");
expect(sorted.map(e=>e.index).join(",") === "1,2,0,3", "Display sorting preserves stored indices for the correct edit target");
expect(JSON.stringify(storedConstituents) === beforeSort, "Sorting does not mutate annotation order or data");
expect(alphabeticalConstituents([{constituent_name:"Ag"},...storedConstituents.slice(1)],storedConstituents.map(e=>e.constituent_name)).map(e=>e.index).join(",") === "1,2,0,3", "Typing a new name can retain its editor position until save");
