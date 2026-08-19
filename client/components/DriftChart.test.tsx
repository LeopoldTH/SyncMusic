import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DriftChart } from "./DriftChart";
import type { DriftPoint } from "../sync/driftLog";

const point = (atMs: number, pairGapMs: number | null): DriftPoint => ({ atMs, localGapMs: 0, pairGapMs });

describe("courbe de derive", () => {
  it("attend d avoir de quoi tracer", () => {
    const html = renderToStaticMarkup(<DriftChart points={[point(0, 100)]} thresholdMs={600} />);
    expect(html).toContain("apres quelques secondes");
    expect(html).not.toContain("<svg");
  });

  it("ignore les points dont l ecart par paire est inconnu", () => {
    const points = [point(0, null), point(1000, null), point(2000, null)];
    const html = renderToStaticMarkup(<DriftChart points={points} thresholdMs={600} />);
    expect(html).toContain("apres quelques secondes");
  });

  it("annonce la valeur courante et le seuil", () => {
    const points = [point(0, 100), point(1000, 250), point(2000, 480)];
    const html = renderToStaticMarkup(<DriftChart points={points} thresholdMs={600} />);
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
    const html = renderToStaticMarkup(<DriftChart points={points} thresholdMs={600} />);
    const line = html.match(/<line[^>]*>/)?.[0] ?? "";
    const y1 = Number(line.match(/y1="([\d.]+)"/)?.[1] ?? "0");
    // Le seuil doit tomber dans le cadre, ni colle en haut ni hors champ.
    expect(y1).toBeGreaterThan(0);
    expect(y1).toBeLessThan(120);
  });

  it("trace un point par mesure", () => {
    const points = [point(0, 100), point(1000, 200), point(2000, 300), point(3000, 150)];
    const html = renderToStaticMarkup(<DriftChart points={points} thresholdMs={600} />);
    const path = html.match(/d="([^"]+)"/)?.[1] ?? "";
    expect(path.split(/[ML]/).filter(Boolean)).toHaveLength(4);
  });
});
