import type { DriftPoint } from "../sync/driftLog";

interface Props {
  points: readonly DriftPoint[];
  /** Seuil au-dela duquel l ecart devient audible. Trace en repere. */
  thresholdMs: number;
}

const WIDTH = 640;
const HEIGHT = 120;

/*
 * Courbe de derive (R19). Volontairement en SVG nu: la valeur du projet est la mesure,
 * pas la bibliotheque de graphiques.
 */
export function DriftChart({ points, thresholdMs }: Props) {
  const measured = points.filter((p) => p.pairGapMs !== null);

  if (measured.length < 2) {
    return <p className="hint">La courbe apparaitra apres quelques secondes de lecture a deux.</p>;
  }

  const values = measured.map((p) => Math.abs(p.pairGapMs ?? 0));
  // L echelle englobe toujours le seuil, sinon on ne verrait pas qu on le depasse.
  const peak = Math.max(thresholdMs * 1.4, ...values);
  const first = measured[0]?.atMs ?? 0;
  const span = Math.max(1, (measured[measured.length - 1]?.atMs ?? first) - first);

  const path = measured
    .map((p, i) => {
      const x = ((p.atMs - first) / span) * WIDTH;
      const y = HEIGHT - (Math.abs(p.pairGapMs ?? 0) / peak) * HEIGHT;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const thresholdY = HEIGHT - (thresholdMs / peak) * HEIGHT;
  const last = Math.abs(measured[measured.length - 1]?.pairGapMs ?? 0);

  return (
    <figure className="chart">
      <figcaption>
        Ecart entre les deux participants — actuellement {Math.round(last)} ms, seuil {thresholdMs} ms
      </figcaption>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="chart__svg" role="img"
           aria-label={`Courbe de derive, valeur actuelle ${Math.round(last)} millisecondes`}>
        <line x1="0" y1={thresholdY} x2={WIDTH} y2={thresholdY} className="chart__threshold" />
        <path d={path} className="chart__line" fill="none" />
      </svg>
      <span className="hint">{measured.length} mesures</span>
    </figure>
  );
}
