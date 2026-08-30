import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DriftChart } from "./DriftChart";
import type { DriftPoint } from "../sync/driftLog";

const point = (atMs: number, pairGapMs: number | null): DriftPoint => ({ atMs, localGapMs: 0, pairGapMs });

describe("courbe de derive", () => {
  it("attend d avoir de quoi tracer", () => {
    const html = renderToStaticMarkup(<DriftChart points={[point(0, 100)]} thresholdMs={600} clock={null} interruptions={0} />);
    expect(html).toContain("apres quelques secondes");
    expect(html).not.toContain("<svg");
  });

  it("ignore les points dont l ecart par paire est inconnu", () => {
    const points = [point(0, null), point(1000, null), point(2000, null)];
    const html = renderToStaticMarkup(<DriftChart points={points} thresholdMs={600} clock={null} interruptions={0} />);
    expect(html).toContain("apres quelques secondes");
  });

  it("annonce la valeur courante et le seuil", () => {
    const points = [point(0, 100), point(1000, 250), point(2000, 480)];
    const html = renderToStaticMarkup(<DriftChart points={points} thresholdMs={600} clock={null} interruptions={0} />);
    expect(html).toContain("480 ms");
    expect(html).toContain("600 ms");
    // La legende doit dire ce qu on regarde: la premiere version ne le disait pas,
    // et il a fallu l expliquer de vive voix.
    expect(html).toContain("Ecart entre vous deux");
    expect(html).toContain("Plus la courbe est basse");
  });

  it("garde le seuil dans l echelle meme quand la derive reste faible", () => {
    // Sans cette regle, une courbe plate a 20 ms remplirait tout le cadre et donnerait
    // l impression d une derive enorme.
    const points = [point(0, 10), point(1000, 20), point(2000, 15)];
    const html = renderToStaticMarkup(<DriftChart points={points} thresholdMs={600} clock={null} interruptions={0} />);
    const line = html.match(/<line[^>]*>/)?.[0] ?? "";
    const y1 = Number(line.match(/y1="([\d.]+)"/)?.[1] ?? "0");
    // Le seuil doit tomber dans le cadre, ni colle en haut ni hors champ.
    expect(y1).toBeGreaterThan(0);
    expect(y1).toBeLessThan(120);
  });

  it("trace un point par mesure", () => {
    const points = [point(0, 100), point(1000, 200), point(2000, 300), point(3000, 150)];
    const html = renderToStaticMarkup(<DriftChart points={points} thresholdMs={600} clock={null} interruptions={0} />);
    const path = html.match(/d="([^"]+)"/)?.[1] ?? "";
    expect(path.split(/[ML]/).filter(Boolean)).toHaveLength(4);
  });
});

/*
 * Le panneau de mesures. Deux appareils affichent chacun son ecart d horloge: c est
 * la difference des deux qui explique le decalage entre participants, et on veut la
 * lire plutot que la deduire d une courbe.
 */
describe("mesures brutes", () => {
  const horloge = { offsetMs: -312.4, roundTripMs: 42.9, spreadMs: 84.2, samples: 8 };

  it("affiche l ecart d horloge, la dispersion et les interruptions", () => {
    const html = renderToStaticMarkup(
      <DriftChart points={[]} thresholdMs={600} clock={horloge} interruptions={3} />,
    );
    expect(html).toContain("-312 ms");
    expect(html).toContain("84 ms sur 8 sondes");
    expect(html).toContain("43 ms");
    expect(html).toContain("Interruptions");
  });

  it("ne montre rien tant qu aucune sonde n est revenue", () => {
    const html = renderToStaticMarkup(
      <DriftChart points={[]} thresholdMs={600} clock={{ ...horloge, samples: 0 }} interruptions={0} />,
    );
    expect(html).not.toContain("Ecart d horloge");
  });

  /* La courbe n apparait qu a deux points: les mesures, elles, doivent etre la avant. */
  it("s affiche meme sans courbe", () => {
    const html = renderToStaticMarkup(
      <DriftChart points={[]} thresholdMs={600} clock={horloge} interruptions={0} />,
    );
    expect(html).toContain("La courbe apparait");
    expect(html).toContain("Ecart d horloge");
  });
});
