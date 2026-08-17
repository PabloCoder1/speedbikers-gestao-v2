import assert from "node:assert/strict";
import test from "node:test";

import { calculateUpsellerImportProgress } from "./import-progress";

const summary = {
  stockRows: 3_379,
  productRows: 3_422,
  relationshipRows: 24_026,
  kitRows: 272,
};

test("reports zero before an import is committed", () => {
  const progress = calculateUpsellerImportProgress({
    status: "previewed",
    phase: "preview",
    cursorRow: 0,
    previewSummary: summary,
    createdAt: "2026-08-17T10:00:00.000Z",
    now: new Date("2026-08-17T10:01:00.000Z"),
  });

  assert.equal(progress.percent, 0);
  assert.equal(progress.estimatedSecondsRemaining, null);
});

test("uses the current phase cursor and never reaches 100 before applied", () => {
  const progress = calculateUpsellerImportProgress({
    status: "queued",
    phase: "relationships",
    cursorRow: 12_000,
    previewSummary: summary,
    createdAt: "2026-08-17T10:00:00.000Z",
    now: new Date("2026-08-17T10:10:00.000Z"),
  });

  assert.equal(progress.phaseProcessedRows, 12_000);
  assert.equal(progress.phaseTotalRows, 24_026);
  assert.ok(progress.percent > 0 && progress.percent < 100);
  assert.ok((progress.estimatedSecondsRemaining ?? 0) > 0);
});

test("progress is monotonic across resumable promotion phases", () => {
  const relationships = calculateUpsellerImportProgress({
    status: "queued",
    phase: "promote_relationships",
    cursorRow: 24_000,
    previewSummary: summary,
    createdAt: "2026-08-17T10:00:00.000Z",
  });
  const links = calculateUpsellerImportProgress({
    status: "running",
    phase: "build_links_variation",
    cursorRow: 1_500,
    previewSummary: summary,
    createdAt: "2026-08-17T10:00:00.000Z",
  });

  assert.ok(links.percent > relationships.percent);
});

test("reports exactly 100 only when the batch is applied", () => {
  const progress = calculateUpsellerImportProgress({
    status: "applied",
    phase: "applied",
    cursorRow: 0,
    previewSummary: summary,
    createdAt: "2026-08-17T10:00:00.000Z",
  });

  assert.equal(progress.percent, 100);
  assert.equal(progress.completedWorkUnits, progress.totalWorkUnits);
  assert.equal(progress.estimatedSecondsRemaining, null);
});
