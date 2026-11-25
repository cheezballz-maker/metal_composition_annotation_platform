import {
  codePointSlice,
  rawBoundaryFromDomPoint,
  rawRangeFromSelection,
  tokenizeRawSource,
} from "../src/review/rawSource";

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type FakeNode = FakeElement | FakeText;

class FakeElement {
  nodeType = 1;
  parentElement: FakeElement | null = null;
  childNodes: FakeNode[] = [];
  dataset: Record<string, string>;

  constructor(dataset: Record<string, string> = {}) {
    this.dataset = dataset;
  }

  append(child: FakeNode) {
    child.parentElement = this;
    this.childNodes.push(child);
    return child;
  }

  closest(selector: string): FakeElement | null {
    if (selector === "[data-raw-start]" && this.dataset.rawStart != null) return this;
    return this.parentElement?.closest(selector) || null;
  }

  querySelector(selector: string): FakeElement | null {
    if (selector !== "[data-raw-start]") return null;
    for (const child of this.childNodes) {
      if (child instanceof FakeElement) {
        if (child.dataset.rawStart != null) return child;
        const nested = child.querySelector(selector);
        if (nested) return nested;
      }
    }
    return null;
  }
}

class FakeText {
  nodeType = 3;
  parentElement: FakeElement | null = null;
  childNodes: FakeNode[] = [];

  constructor(readonly data: string) {}
}

(globalThis as unknown as { Node: { TEXT_NODE: number; ELEMENT_NODE: number } }).Node = {
  TEXT_NODE: 3,
  ELEMENT_NODE: 1,
};

const nonBmpElement = new FakeElement({ rawStart: "10", rawEnd: "13" });
const nonBmpText = nonBmpElement.append(new FakeText("A😀B")) as FakeText;
expect(rawBoundaryFromDomPoint(nonBmpText as unknown as Node, 0) === 10, "text start maps to raw start");
expect(rawBoundaryFromDomPoint(nonBmpText as unknown as Node, 1) === 11, "BMP UTF-16 offset maps directly");
expect(rawBoundaryFromDomPoint(nonBmpText as unknown as Node, 2) === 11, "mid-surrogate offset uses the preceding raw boundary");
expect(rawBoundaryFromDomPoint(nonBmpText as unknown as Node, 3) === 12, "UTF-16 offset after emoji counts one code point");
expect(rawBoundaryFromDomPoint(nonBmpText as unknown as Node, 4, true) === 13, "text end maps to raw end");

const entityElement = new FakeElement({ rawStart: "20", rawEnd: "25", rawUnit: "entity" });
const entityText = entityElement.append(new FakeText("&")) as FakeText;
expect(rawBoundaryFromDomPoint(entityText as unknown as Node, 0) === 20, "entity start maps before all raw entity characters");
expect(rawBoundaryFromDomPoint(entityText as unknown as Node, 1, true) === 25, "entity end maps after all raw entity characters");

const container = new FakeElement();
container.append(nonBmpElement);
container.append(entityElement);
expect(rawBoundaryFromDomPoint(container as unknown as Node, 0) === 10, "element start endpoint chooses first mapped child");
expect(rawBoundaryFromDomPoint(container as unknown as Node, 2, true) === 25, "element end endpoint chooses previous mapped child end");

const nested = new FakeElement();
const bold = nested.append(new FakeElement()) as FakeElement;
const italic = nested.append(new FakeElement()) as FakeElement;
const a = bold.append(new FakeElement({ rawStart: "8", rawEnd: "9" })) as FakeElement;
a.append(new FakeText("A"));
const b = italic.append(new FakeElement({ rawStart: "16", rawEnd: "17" })) as FakeElement;
b.append(new FakeText("B"));
const sub = italic.append(new FakeElement()) as FakeElement;
const two = sub.append(new FakeElement({ rawStart: "22", rawEnd: "23" })) as FakeElement;
two.append(new FakeText("2"));
const c = italic.append(new FakeElement({ rawStart: "29", rawEnd: "30" })) as FakeElement;
c.append(new FakeText("C"));
expect(rawBoundaryFromDomPoint(nested as unknown as Node, 0) === 8, "offset zero chooses the first mapped descendant");
expect(rawBoundaryFromDomPoint(nested as unknown as Node, 0, true) === 8, "an end boundary before all children falls forward to the first mapping");
expect(rawBoundaryFromDomPoint(nested as unknown as Node, 2) === 30, "a start boundary after all children falls back to the final mapping end");
expect(rawBoundaryFromDomPoint(nested as unknown as Node, 2, true) === 30, "childNodes.length chooses the last mapped descendant end");
expect(rawBoundaryFromDomPoint(nested as unknown as Node, 1) === 16, "a start boundary between siblings chooses the following subtree start");
expect(rawBoundaryFromDomPoint(nested as unknown as Node, 1, true) === 9, "an end boundary between siblings chooses the preceding subtree end");
const nestedSecondChild = rawRangeFromSelection({
  startContainer: nested,
  startOffset: 1,
  endContainer: nested,
  endOffset: 2,
} as unknown as Range);
expect(nestedSecondChild?.start === 16 && nestedSecondChild.end === 30, "nested element endpoints span every mapped descendant in the selected sibling");

const forward = rawRangeFromSelection({
  startContainer: nonBmpText,
  startOffset: 1,
  endContainer: entityText,
  endOffset: 1,
} as unknown as Range);
expect(forward?.start === 11 && forward.end === 25, "mixed non-BMP/entity range maps to raw half-open range");
const reverse = rawRangeFromSelection({
  startContainer: entityText,
  startOffset: 1,
  endContainer: nonBmpText,
  endOffset: 1,
} as unknown as Range);
expect(reverse?.start === 11 && reverse.end === 25, "reverse selection is normalized without changing boundaries");

const raw = '<div class="uspto-tr unsafe/value" num="2">A😀 &amp; B <½″ <sub>2</sub><img src=""><br/></div>';
const tokens = tokenizeRawSource(raw);
const div = tokens.find(token => token.kind === "open" && token.tag === "div");
expect(div?.kind === "open" && div.className === "uspto-tr" && div.num === "2", "table class is preserved and unsafe class is dropped");
expect(tokens.some(token => token.kind === "image" && token.missing), "empty-src image remains a missing marker");
expect(tokens.some(token => token.kind === "break"), "self-closing break is tokenized");
expect(tokens.filter(token => token.kind === "text").some(token => token.value.includes("<½″")), "literal comparison stays text");

const reconstructed = tokens.map(token => token.kind === "text" ? token.value : codePointSlice(raw, token.rawStart, token.rawEnd)).join("");
expect(reconstructed === raw, "token raw ranges partition the exact Unicode code-point source");

console.log("review raw source browser-boundary tests passed");
