import { codePointLength, codePointSlice, codePointToUtf16Offset, tokenizeRawSource, utf16ToCodePointOffset } from "../src/review/rawSource";

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const nonBmp = "A😀B";
expect(codePointLength(nonBmp) === 3, "Unicode code-point length must not use UTF-16 length");
expect(utf16ToCodePointOffset(nonBmp, 3) === 2, "UTF-16 DOM position after emoji maps to code-point position");
expect(codePointToUtf16Offset(nonBmp, 2) === 3, "code-point position maps back to UTF-16 DOM position");
expect(codePointSlice(nonBmp, 1, 2) === "😀", "code-point slices preserve non-BMP characters");

const raw = '<div class="indep-clm" num="1">A &amp; B <½″ <sub>2</sub><img src=""></div>';
const tokens = tokenizeRawSource(raw);
expect(tokens.some((token) => token.kind === "open" && token.tag === "div" && token.className === "indep-clm" && token.num === "1"), "safe claim class and number survive parsing");
expect(tokens.some((token) => token.kind === "image" && token.missing), "empty image source is retained as a visible marker");
const text = tokens.filter((token) => token.kind === "text").map((token) => token.value).join("");
expect(text.includes("<½″"), "literal comparison text is never treated as markup");
expect(!tokens.some((token) => token.kind === "open" && token.tag === "f"), "unknown comparison-like tags stay literal text");

const misnested = '<seg-refi><br/><div class="uspto-tbl-1"><div class="uspto-tr"></seg-refi></div>';
const misnestedTokens = tokenizeRawSource(misnested);
expect(misnestedTokens.filter((token) => token.kind === "close").length === 2, "misnested known structural closes are tokenized for tolerant tree rendering");

console.log("review raw source mapper tests passed");

const ocrComparison = '<p>1<<b<<3, 5<c<12 and 0.5<e<1.</p>';
const comparisonText = tokenizeRawSource(ocrComparison).filter((token) => token.kind === "text").map((token) => token.value).join("");
expect(comparisonText === '1<<b<<3, 5<c<12 and 0.5<e<1.', "OCR comparisons must not be consumed as bold/emphasis tags");
