import { describe, it, expect } from "vitest";
import { createClockEstimator, type ProbeSample } from "./clock";

/**
 * Construit un echantillon pour un ecart d'horloge et un temps reseau donnes.
 * `asymmetryMs` decale l'aller par rapport au retour: c'est exactement ce que
 * l'attente en file dans un routeur produit, et ce qui fausse l'estimation.
 */
function sample(offsetMs: number, networkMs: number, asymmetryMs = 0): ProbeSample {
  const outbound = networkMs / 2 + asymmetryMs;
  const inbound = networkMs / 2 - asymmetryMs;
  const clientSentAt = 1_000_000;
  const serverReceivedAt = clientSentAt + outbound + offsetMs;
  const serverSentAt = serverReceivedAt + 2; // temps de traitement serveur
  const clientReceivedAt = clientSentAt + outbound + inbound + 2;
  return { clientSentAt, serverReceivedAt, serverSentAt, clientReceivedAt };
}

/*
 * Assoupli le 30/08/2026, mesure a deux appareils: a 60 ms, ce critere gardait la
 * lecture fermee une trentaine de secondes sur un vrai reseau. La gigue d un telephone
 * en wifi depasse ce seuil en permanence, alors que l estimation retenue, celle du plus
 * court aller-retour, reste bonne. Le critere doit ecarter « on n en sait rien », pas
 * « le reseau bouge ».
 */
describe("tolerance a un reseau bruyant", () => {
  it("conclut malgre une fenetre dispersee de plus de soixante millisecondes", () => {
    const c = createClockEstimator();
    // Trois sondes dont l asymetrie varie de 80 ms: du bruit de routeur ordinaire.
    for (const asym of [0, 40, 80]) c.accept(sample(500, 60, asym));
    expect(c.estimate().converged).toBe(true);
  });

  it("refuse encore de conclure sur trop peu de mesures", () => {
    const c = createClockEstimator();
    c.accept(sample(500, 60));
    expect(c.estimate().converged).toBe(false);
  });
});

describe("estimation de l'ecart d'horloge", () => {
  it("converge vers l'ecart reel sur des allers-retours reguliers", () => {
    const est = createClockEstimator();
    for (let i = 0; i < 8; i++) est.accept(sample(4200, 40));
    expect(est.estimate().offsetMs).toBeCloseTo(4200, 0);
  });

  it("ignore un aller-retour anormalement long", () => {
    const est = createClockEstimator();
    for (let i = 0; i < 6; i++) est.accept(sample(4200, 40));
    const clean = est.estimate().offsetMs;

    // Un paquet retenu 400 ms sur l'aller seulement: la formule croit a un ecart
    // de 200 ms de plus. Le filtre du minimum doit le rejeter.
    est.accept(sample(4200, 840, 400));
    expect(est.estimate().offsetMs).toBeCloseTo(clean, 0);
  });

  it("se reajuste sans discontinuite quand la latence passe de 30 a 300 ms", () => {
    const est = createClockEstimator();
    for (let i = 0; i < 8; i++) est.accept(sample(4200, 30));
    const before = est.estimate().offsetMs;
    for (let i = 0; i < 8; i++) est.accept(sample(4200, 300));
    const after = est.estimate().offsetMs;
    expect(Math.abs(after - before)).toBeLessThan(20);
  });

  it("n'est pas converge tant que trop peu de sondes ont ete retenues", () => {
    const est = createClockEstimator();
    expect(est.estimate().converged).toBe(false);
    est.accept(sample(4200, 40));
    expect(est.estimate().converged).toBe(false);
  });

  it("devient converge une fois la dispersion sous sa borne", () => {
    const est = createClockEstimator();
    for (let i = 0; i < 6; i++) est.accept(sample(4200, 40));
    expect(est.estimate().converged).toBe(true);
  });

  it("reste non converge quand les echantillons sont trop disperses", () => {
    const est = createClockEstimator();
    est.accept(sample(4200, 40));
    est.accept(sample(9000, 40));
    est.accept(sample(1000, 40));
    expect(est.estimate().converged).toBe(false);
  });

  it("decide qu'une sonde doit partir sans jamais l'emettre", () => {
    const est = createClockEstimator();
    expect(est.shouldProbe(0)).toBe(true);
    est.noteProbeSent(0);
    expect(est.shouldProbe(100)).toBe(false);
  });
});
