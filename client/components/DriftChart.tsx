import type { DriftPoint } from "../sync/driftLog";
import type { ClockEstimate } from "../sync/clock";

interface Props {
  points: readonly DriftPoint[];
  /** Seuil au-dela duquel l ecart devient audible. Trace en repere. */
  thresholdMs: number;
  /** Ce que cet appareil croit savoir de l horloge. `null` avant la premiere sonde. */
  clock: Pick<ClockEstimate, "offsetMs" | "roundTripMs" | "spreadMs" | "samples"> | null;
  /** Nombre de fois ou la lecture a ete interrompue, stagnation ou attente. */
  interruptions: number;
}

const WIDTH = 640;
const HEIGHT = 110;

/*
 * Ce que cet appareil croit savoir de l horloge, en clair.
 *
 * Deux appareils affichent chacun le sien. La difference des deux ecarts est
 * exactement l erreur de placement entre les participants: on la lit au lieu de la
 * deduire d une courbe. Le compteur d interruptions dit, lui, si la lecture a ete
 * coupee, ce qu une courbe d ecart ne montre pas.
 */
function Horloge({ clock, interruptions }: Pick<Props, "clock" | "interruptions">) {
  if (clock === null || clock.samples === 0) return null;
  return (
    <dl className="mesures">
      <dt>Ecart d horloge</dt>
      <dd>{Math.round(clock.offsetMs)} ms</dd>
      <dt>Dispersion</dt>
      <dd>{Math.round(clock.spreadMs)} ms sur {clock.samples} sondes</dd>
      <dt>Aller-retour</dt>
      <dd>{Math.round(clock.roundTripMs)} ms</dd>
      <dt>Interruptions</dt>
      <dd>{interruptions}</dd>
    </dl>
  );
}

/*
 * Courbe de derive (R19). Volontairement en SVG nu: la valeur du projet est la mesure,
 * pas la bibliotheque de graphiques.
 *
 * La legende explique ce qu on regarde. Un graphique qu il faut se faire expliquer
 * ne sert a rien, et c est exactement ce qui s est passe avec la premiere version.
 */
export function DriftChart({ points, thresholdMs, clock, interruptions }: Props) {
  const measured = points.filter((p) => p.pairGapMs !== null);

  if (measured.length < 2) {
    return (
      <figure className="chart">
        <figcaption>Ecart entre vous deux, seconde par seconde</figcaption>
        <p className="hint">La courbe apparait apres quelques secondes d ecoute a deux.</p>
        <Horloge clock={clock} interruptions={interruptions} />
      </figure>
    );
  }

  const values = measured.map((p) => Math.abs(p.pairGapMs ?? 0));
  // L echelle englobe toujours le seuil, sinon une courbe plate a 20 ms remplirait
  // tout le cadre et donnerait l impression d une derive enorme.
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
  const within = measured.filter((p) => Math.abs(p.pairGapMs ?? 0) <= thresholdMs).length;
  const ratio = Math.round((within / measured.length) * 100);
  const minutes = Math.max(1, Math.round(span / 60_000));

  return (
    <figure className="chart">
      <figcaption>
        Ecart entre vous deux, seconde par seconde. La ligne rouge est le seuil au-dela
        duquel le decalage s entend ({thresholdMs} ms). Plus la courbe est basse, mieux c est.
      </figcaption>

      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="chart__svg"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Courbe de derive: actuellement ${Math.round(last)} millisecondes, sous le seuil ${ratio} pour cent du temps`}
      >
        <line x1="0" y1={thresholdY} x2={WIDTH} y2={thresholdY} className="chart__threshold" />
        <path d={path} className="chart__line" fill="none" vectorEffect="non-scaling-stroke" />
      </svg>

      <div className="chart__foot">
        <span className="hint">Maintenant : {Math.round(last)} ms</span>
        <span className="hint">Sous le seuil {ratio} % du temps, sur {minutes} min</span>
      </div>
      <Horloge clock={clock} interruptions={interruptions} />
    </figure>
  );
}
