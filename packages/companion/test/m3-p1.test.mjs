/**
 * M3-P1: per-file approve selection. The undefined-vs-[] distinction
 * is load-bearing — conflating them (the original `files && length`
 * bug) silently wrote files the user had unchecked. Caught in e2e,
 * pinned here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickEdits } from "../dist/edit/gateway.js";

const A = [{ file: "a.tsx" }, { file: "b.tsx" }, { file: "c.tsx" }];

test("files undefined → whole changeset", () => {
  assert.deepEqual(pickEdits(A, undefined), A);
});

test("files [] → explicit none (nothing applied)", () => {
  assert.deepEqual(pickEdits(A, []), []);
});

test("files subset → exactly that subset", () => {
  assert.deepEqual(pickEdits(A, ["a.tsx", "c.tsx"]), [
    { file: "a.tsx" },
    { file: "c.tsx" },
  ]);
});

test("unknown names are ignored, not invented", () => {
  assert.deepEqual(pickEdits(A, ["zz.tsx"]), []);
});
