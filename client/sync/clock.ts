/*
 * Estimation de l'ecart entre l'horloge locale et celle du serveur (KTD1).
 *
 * Ne connait ni le reseau, ni le DOM, ni YouTube: il recoit des echantillons et
 * decide quand une sonde doit partir. L'emission appartient au transport (KTD6).
 */

export interface ProbeSample {
  /** Horloge du client au depart de la sonde. */
  clientSentAt: number;
  /** Horloge du serveur a la reception. */
  serverReceivedAt: number;
  /** Horloge du serveur a la reemission. */
  serverSentAt: number;
  /** Horloge du client au retour. */
  clientReceivedAt: number;
}

export interface ClockEstimate {
  /** A ajouter a l'horloge locale pour obtenir l'horloge serveur. */
  offsetMs: number;
  roundTripMs: number;
  converged: boolean;
  samples: number;
  /** Dispersion de la fenetre: c est elle qui decide de la convergence. */
  spreadMs: number;
}

export interface ClockOptions {
  windowSize?: number;
  minSamples?: number;
  maxSpreadMs?: number;
  smoothing?: number;
  probeIntervalMs?: number;
}

interface Measured {
  offsetMs: number;
  roundTripMs: number;
}

/**
 * Retire le temps de traitement serveur du total, puis suppose que l'aller et le
 * retour se partagent le reste a parts egales. C'est cette hypothese de symetrie
 * que le filtre du minimum protege.
 */
function measure(s: ProbeSample): Measured {
  const total = s.clientReceivedAt - s.clientSentAt;
  const serverBusy = s.serverSentAt - s.serverReceivedAt;
  return {
    roundTripMs: total - serverBusy,
    offsetMs: ((s.serverReceivedAt - s.clientSentAt) + (s.serverSentAt - s.clientReceivedAt)) / 2,
  };
}

export function createClockEstimator(options: ClockOptions = {}) {
  const windowSize = options.windowSize ?? 8;
  const minSamples = options.minSamples ?? 3;
  /*
   * Bande de confiance, pas une exigence de precision.
   *
   * A 60 ms, ce critere gardait la lecture fermee une trentaine de secondes sur un
   * vrai reseau: la gigue d un telephone en wifi depasse ce seuil en permanence, et il
   * fallait attendre qu une fenetre de mesures chanceuse tombe. Mesure le 30/08/2026
   * a deux appareils.
   *
   * Or l estimation ne retient pas la moyenne mais l echantillon au plus court
   * aller-retour: une fenetre dispersee ne veut pas dire une mauvaise estimation, elle
   * veut dire un reseau bruyant, et le meilleur echantillon reste le meilleur. Ce
   * seuil doit donc ecarter « on n en sait rien », pas « le reseau bouge ». Cale sur
   * le plancher de correction: en dessous de 300 ms, le moteur ne corrige rien de
   * toute facon, donc exiger mieux avant de demarrer ne sert personne.
   */
  const maxSpreadMs = options.maxSpreadMs ?? 300;
  const smoothing = options.smoothing ?? 0.4;
  const probeIntervalMs = options.probeIntervalMs ?? 2_000;

  const window: Measured[] = [];
  let smoothed: number | null = null;
  let lastProbeAt: number | null = null;

  function best(): Measured | null {
    let winner: Measured | null = null;
    for (const m of window) if (!winner || m.roundTripMs < winner.roundTripMs) winner = m;
    return winner;
  }

  return {
    accept(sample: ProbeSample): void {
      const m = measure(sample);
      window.push(m);
      if (window.length > windowSize) window.shift();

      /*
       * On ne lisse que vers le meilleur echantillon de la fenetre, jamais vers le
       * dernier arrive. Le retard reseau ne peut qu'ajouter du temps: il biaise
       * l'estimation au lieu de la bruiter symetriquement, donc une moyenne le traine
       * au lieu de l'annuler. Le minimum est ici le bon estimateur.
       */
      const b = best();
      if (!b) return;
      smoothed = smoothed === null ? b.offsetMs : smoothed + (b.offsetMs - smoothed) * smoothing;
    },

    estimate(): ClockEstimate {
      const b = best();
      const offsets = window.map((m) => m.offsetMs);
      const spread = offsets.length > 0 ? Math.max(...offsets) - Math.min(...offsets) : Infinity;
      return {
        offsetMs: smoothed ?? 0,
        roundTripMs: b?.roundTripMs ?? Infinity,
        converged: window.length >= minSamples && spread <= maxSpreadMs,
        samples: window.length,
        spreadMs: spread,
      };
    },

    /** Decide, n'emet pas: l'emission appartient au transport (KTD6). */
    shouldProbe(nowMs: number): boolean {
      return lastProbeAt === null || nowMs - lastProbeAt >= probeIntervalMs;
    },

    noteProbeSent(nowMs: number): void {
      lastProbeAt = nowMs;
    },
  };
}
