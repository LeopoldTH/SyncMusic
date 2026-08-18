import { describe, it, expect } from "vitest";
import { targetPositionMs, observedGapMs, type CommonStart } from "./timeline";

const start: CommonStart = { barrierId: 1, positionMs: 30_000, startAtServerMs: 5_000_000 };

describe("position cible", () => {
  it("vaut la position annoncee a l'instant de depart exact", () => {
    // Horloge locale en retard de 4200 ms sur le serveur.
    const localNow = start.startAtServerMs - 4200;
    expect(targetPositionMs(start, 4200, localNow)).toBe(30_000);
  });

  it("avance avec le temps ecoule depuis le depart", () => {
    const localNow = start.startAtServerMs - 4200 + 2_000;
    expect(targetPositionMs(start, 4200, localNow)).toBe(32_000);
  });

  it("compense le retard quand l'instant de depart est deja passe", () => {
    // Le message arrive 800 ms trop tard. Reprendre a 30 000 injecterait 800 ms
    // de retard que le correcteur ne rattraperait jamais sous son plancher.
    const localNow = start.startAtServerMs - 4200 + 800;
    expect(targetPositionMs(start, 4200, localNow)).toBe(30_800);
  });

  it("ne recule pas avant l'instant de depart", () => {
    const localNow = start.startAtServerMs - 4200 - 500;
    expect(targetPositionMs(start, 4200, localNow)).toBe(30_000);
  });
});

describe("ecart observe", () => {
  it("est positif quand le client est en retard", () => {
    expect(observedGapMs(32_000, 31_500)).toBe(500);
  });

  it("est negatif quand le client est en avance", () => {
    expect(observedGapMs(32_000, 32_400)).toBe(-400);
  });
});
