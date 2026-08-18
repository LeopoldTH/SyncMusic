import { describe, it, expect } from "vitest";
import { decide, type Thresholds } from "./corrector";

// Plancher issu de la mesure du 2026-08-19 (cadence de position: 266 ms mediane).
// Plafond encore provisoire: U7 le derive du seuil audible mesure a l'ecoute.
const T: Thresholds = {
  floorMs: 300,
  ceilingMs: 3_000,
  resorptionWindowMs: 10_000,
  rateStep: 0.05,
  rateMin: 0.25,
  rateMax: 2,
};

describe("etage 1: zone morte", () => {
  it("ne fait rien sous le plancher", () => {
    expect(decide(250, 60_000, T)).toEqual({ kind: "hold" });
    expect(decide(-250, 60_000, T)).toEqual({ kind: "hold" });
  });
});

describe("etage 2: correction par la vitesse", () => {
  it("produit une vitesse appartenant a la grille", () => {
    const d = decide(2_000, 60_000, T);
    if (d.kind !== "rate") return expect.unreachable("une correction par vitesse etait attendue");
    expect(Math.round(d.rate * 100) % 5).toBe(0);
  });

  it("resorbe exactement l'ecart sur la duree calculee", () => {
    const gap = 2_000;
    const d = decide(gap, 60_000, T);
    if (d.kind !== "rate") return expect.unreachable("une correction par vitesse etait attendue");
    // La vitesse appliquee pendant la duree doit rattraper l'ecart, au signe pres.
    expect((d.rate - 1) * d.durationMs).toBeCloseTo(gap, 6);
  });

  it("accelere quand le client est en retard et ralentit quand il est en avance", () => {
    const late = decide(1_500, 60_000, T);
    const early = decide(-1_500, 60_000, T);
    if (late.kind !== "rate" || early.kind !== "rate") return expect.unreachable("vitesses attendues");
    expect(late.rate).toBeGreaterThan(1);
    expect(early.rate).toBeLessThan(1);
  });

  it("allonge la duree plutot que d abandonner sur un petit ecart", () => {
    // 400 ms sur une fenetre de 10 s donne 1,04, qui n existe pas sur la grille.
    // On prend le cran suivant en s eloignant de 1, et la duree absorbe l ecart.
    const d = decide(400, 60_000, T);
    if (d.kind !== "rate") return expect.unreachable("une correction par vitesse etait attendue");
    expect(d.rate).toBeCloseTo(1.05, 6);
    expect((d.rate - 1) * d.durationMs).toBeCloseTo(400, 6);
  });

  it("ne retombe jamais sur une vitesse de 1,00, qui ne corrigerait rien", () => {
    for (let gap = -2_900; gap <= 2_900; gap += 13) {
      const d = decide(gap, 60_000, T);
      if (d.kind === "rate") expect(d.rate).not.toBe(1);
    }
  });

  it("ne produit jamais de duree infinie ni de NaN", () => {
    for (let gap = -2_900; gap <= 2_900; gap += 37) {
      const d = decide(gap, 60_000, T);
      if (d.kind === "rate") {
        expect(Number.isFinite(d.durationMs)).toBe(true);
        expect(d.durationMs).toBeGreaterThan(0);
      }
    }
  });
});

describe("etage 3: saut", () => {
  it("saute au-dela du plafond", () => {
    expect(decide(5_000, 60_000, T)).toEqual({ kind: "seek", toPositionMs: 60_000 });
  });

  it("saute aussi quand le client est tres en avance", () => {
    expect(decide(-5_000, 60_000, T)).toEqual({ kind: "seek", toPositionMs: 60_000 });
  });
});

describe("client lent", () => {
  it("produit une decision stable sans osciller entre etages", () => {
    // Un client dont la position progresse 5 % moins vite que l'horloge.
    const kinds = new Set<string>();
    let position = 60_000;
    let target = 60_000;
    for (let tick = 0; tick < 12; tick++) {
      target += 1_000;
      position += 950;
      const d = decide(target - position, target, T);
      kinds.add(d.kind);
    }
    // L'ecart croit de 50 ms par seconde: il traverse le plancher une fois et
    // reste ensuite dans la bande de correction par vitesse.
    expect(kinds.has("seek")).toBe(false);
  });
});
