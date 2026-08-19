/*
 * Detection de stagnation (KD6, KTD5). Pur et sans horloge implicite.
 *
 * La regle des deux relevés consecutifs n est pas de la prudence gratuite: la position
 * rapportee par le lecteur est un cache extrapole localement, plafonne a une seconde.
 * Un relevé isole qui n avance pas peut n etre qu un echantillon manque, pas un arret.
 */

export interface StallReading {
  positionMs: number;
  fresh: boolean;
  playing: boolean;
  atMs: number;
}

export interface StallVerdict {
  stalled: boolean;
  /** Vrai au tour ou la progression repart, pour fermer l interruption au journal. */
  recovered: boolean;
}

export interface StallOptions {
  /** Progression minimale attendue entre deux relevés pour les considerer vivants. */
  minProgressMs?: number;
  /** Un participant qui vient de repartir n est pas redeclare en stagnation aussitot. */
  graceMs?: number;
}

export function createStallDetector(options: StallOptions = {}) {
  const minProgressMs = options.minProgressMs ?? 100;
  const graceMs = options.graceMs ?? 3_000;

  let lastPositionMs: number | null = null;
  let flatReadings = 0;
  let stalled = false;
  let recoveredAtMs: number | null = null;

  return {
    observe(reading: StallReading): StallVerdict {
      if (!reading.playing) {
        // Un arret volontaire n est pas une stagnation.
        lastPositionMs = reading.positionMs;
        flatReadings = 0;
        const wasStalled = stalled;
        stalled = false;
        return { stalled: false, recovered: wasStalled };
      }

      const progressed =
        lastPositionMs === null || reading.positionMs - lastPositionMs >= minProgressMs;
      lastPositionMs = reading.positionMs;

      if (progressed && reading.fresh) {
        flatReadings = 0;
        if (stalled) {
          stalled = false;
          recoveredAtMs = reading.atMs;
          return { stalled: false, recovered: true };
        }
        return { stalled: false, recovered: false };
      }

      flatReadings += 1;
      if (flatReadings < 2) return { stalled: false, recovered: false };

      // Delai de grace apres une reprise, pour ne pas osciller autour du redemarrage.
      if (recoveredAtMs !== null && reading.atMs - recoveredAtMs < graceMs) {
        return { stalled: false, recovered: false };
      }

      stalled = true;
      return { stalled: true, recovered: false };
    },

    isStalled(): boolean {
      return stalled;
    },
  };
}
