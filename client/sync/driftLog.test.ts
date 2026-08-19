import { describe, it, expect } from "vitest";
import { createDriftLog } from "./driftLog";

describe("journal de derive", () => {
  it("conserve tous les points sans agreger", () => {
    const log = createDriftLog();
    for (let i = 0; i < 7_200; i++) log.record({ atMs: i * 1000, localGapMs: 10, pairGapMs: 20 });
    expect(log.points()).toHaveLength(7_200);
    expect(log.points()[0]?.atMs).toBe(0);
  });

  it("calcule la part du temps passe sous le seuil", () => {
    const log = createDriftLog();
    log.record({ atMs: 0, localGapMs: 0, pairGapMs: 100 });
    log.record({ atMs: 1000, localGapMs: 0, pairGapMs: 900 });
    log.record({ atMs: 2000, localGapMs: 0, pairGapMs: 200 });
    expect(log.summary(600).withinThresholdRatio).toBeCloseTo(2 / 3, 6);
  });

  it("ignore les points dont l ecart par paire est inconnu", () => {
    const log = createDriftLog();
    log.record({ atMs: 0, localGapMs: 0, pairGapMs: null });
    expect(log.summary(600).measuredPoints).toBe(0);
    expect(log.summary(600).withinThresholdRatio).toBe(null);
  });
});

describe("interruptions", () => {
  it("enregistre une interruption avec sa duree", () => {
    const log = createDriftLog();
    log.beginInterruption("pote", 1_000);
    log.endInterruption("pote", 13_000);
    expect(log.summary(600).interruptions).toBe(1);
    expect(log.summary(600).totalInterruptedMs).toBe(12_000);
  });

  it("ne compte pas deux fois une interruption deja ouverte", () => {
    const log = createDriftLog();
    log.beginInterruption("pote", 1_000);
    log.beginInterruption("pote", 2_000);
    expect(log.interruptions()).toHaveLength(1);
    expect(log.interruptions()[0]?.startedAtMs).toBe(1_000);
  });

  it("laisse une interruption en cours sans duree", () => {
    const log = createDriftLog();
    log.beginInterruption("pote", 1_000);
    expect(log.summary(600).totalInterruptedMs).toBe(0);
    expect(log.interruptions()[0]?.endedAtMs).toBe(null);
  });
});
