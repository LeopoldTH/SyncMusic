import { describe, it, expect } from "vitest";
import { createStallDetector } from "./stallDetector";

const playing = (positionMs: number, atMs: number, fresh = true) =>
  ({ positionMs, atMs, fresh, playing: true });

describe("regle des deux relevés", () => {
  it("ne declare rien sur un seul relevé sans progression", () => {
    const d = createStallDetector();
    d.observe(playing(30_000, 0));
    expect(d.observe(playing(30_000, 1_000)).stalled).toBe(false);
  });

  it("declare une stagnation au deuxieme relevé consecutif", () => {
    const d = createStallDetector();
    d.observe(playing(30_000, 0));
    d.observe(playing(30_000, 1_000));
    expect(d.observe(playing(30_000, 2_000)).stalled).toBe(true);
  });

  it("annule la suspicion des que la progression reprend", () => {
    const d = createStallDetector();
    d.observe(playing(30_000, 0));
    d.observe(playing(30_000, 1_000));
    d.observe(playing(31_000, 2_000));
    expect(d.observe(playing(31_000, 3_000)).stalled).toBe(false);
  });
});

describe("arret volontaire", () => {
  it("ne declare pas de stagnation en pause", () => {
    const d = createStallDetector();
    const paused = { positionMs: 30_000, atMs: 0, fresh: true, playing: false };
    d.observe(paused);
    d.observe({ ...paused, atMs: 1_000 });
    expect(d.observe({ ...paused, atMs: 2_000 }).stalled).toBe(false);
  });
});

describe("reprise", () => {
  it("signale la reprise une seule fois", () => {
    const d = createStallDetector();
    d.observe(playing(30_000, 0));
    d.observe(playing(30_000, 1_000));
    d.observe(playing(30_000, 2_000));
    expect(d.isStalled()).toBe(true);

    expect(d.observe(playing(31_000, 3_000)).recovered).toBe(true);
    expect(d.observe(playing(32_000, 4_000)).recovered).toBe(false);
  });

  it("ne redeclare pas une stagnation pendant le delai de grace", () => {
    const d = createStallDetector({ graceMs: 3_000 });
    d.observe(playing(30_000, 0));
    d.observe(playing(30_000, 1_000));
    d.observe(playing(30_000, 2_000));
    d.observe(playing(31_000, 3_000)); // reprise

    d.observe(playing(31_000, 4_000));
    expect(d.observe(playing(31_000, 5_000)).stalled).toBe(false);
    // Une fois le delai passe, la detection redevient active.
    expect(d.observe(playing(31_000, 7_000)).stalled).toBe(true);
  });
});

describe("fraicheur", () => {
  it("compte une position non fraiche comme une absence de progression", () => {
    const d = createStallDetector();
    d.observe(playing(30_000, 0));
    d.observe(playing(31_000, 1_000, false));
    expect(d.observe(playing(32_000, 2_000, false)).stalled).toBe(true);
  });
});
