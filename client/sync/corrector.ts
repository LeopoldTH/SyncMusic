/*
 * Decision de correction: les trois etages du plan (KTD2, KTD3).
 * Fonction pure. Aucun etat, aucune horloge, aucun effet.
 */

export interface Thresholds {
  /** Sous ce seuil on ne corrige pas: la position rapportee est extrapolee localement. */
  floorMs: number;
  /** Au-dela, la vitesse mettrait trop longtemps: on saute. */
  ceilingMs: number;
  /** Duree visee pour resorber l'ecart. Longue par choix: personne n'est presse. */
  resorptionWindowMs: number;
  rateStep: number;
  rateMin: number;
  rateMax: number;
}

export type Decision =
  | { kind: "hold" }
  | { kind: "rate"; rate: number; durationMs: number }
  | { kind: "seek"; toPositionMs: number };

/**
 * Reproduit la quantification du lecteur, mesuree le 2026-08-19: arrondi a deux
 * decimales puis calage sur la grille de 0,05, entre 0,25 et 2,00.
 *
 * Une seule difference, deliberee: on s'eloigne de 1 au lieu d'y retomber. Une
 * vitesse de 1,00 ne corrige rien, donc un petit ecart resterait en place et la
 * boucle le redecouvrirait a chaque tour. En s'ecartant d'un cran, la correction
 * est simplement plus longue, ce que la duree calculee absorbe exactement.
 */
function quantizeRate(raw: number, t: Thresholds): number {
  const clamped = Math.min(t.rateMax, Math.max(t.rateMin, raw));
  const rounded = Math.round(clamped * 100) / 100;
  const steps = rounded / t.rateStep;
  const n = rounded >= 1 ? Math.ceil(steps - 1e-9) : Math.floor(steps + 1e-9);
  const snapped = Math.round(n * t.rateStep * 100) / 100;
  return Math.min(t.rateMax, Math.max(t.rateMin, snapped));
}

export function decide(gapMs: number, targetPositionMs: number, t: Thresholds): Decision {
  const magnitude = Math.abs(gapMs);

  if (magnitude < t.floorMs) return { kind: "hold" };
  if (magnitude >= t.ceilingMs) return { kind: "seek", toPositionMs: targetPositionMs };

  const rate = quantizeRate(1 + gapMs / t.resorptionWindowMs, t);

  // Garde-fou: sans elle, la duree serait une division par zero. La quantification
  // ci-dessus l'evite deja, mais un jeu de seuils degrade pourrait y ramener.
  if (rate === 1) return { kind: "hold" };

  return { kind: "rate", rate, durationMs: magnitude / Math.abs(rate - 1) };
}
