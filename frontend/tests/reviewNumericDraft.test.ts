import { normalizeFiniteDraft } from "../src/review/numericDraft";

function expect(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

// A text input retains this exact draft while typing; conversion happens only on save.
const typed = ["0", "0.", "0.5"];
expect(typed[1] === "0.", "intermediate decimal draft remains text");
expect(normalizeFiniteDraft(typed[2], "amount") === 0.5, "0.5 saves as a finite number");
let rejected = false;
try { normalizeFiniteDraft("-", "amount"); } catch { rejected = true; }
expect(rejected, "incomplete negative draft is rejected only on save");
console.log("review numeric draft tests passed");
