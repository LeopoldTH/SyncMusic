/*
 * Conversion du couple depart commun vers une position cible locale (R11, R12, R12b).
 * Pure: aucune horloge implicite, l'appelant fournit le temps.
 */

export interface CommonStart {
  barrierId: number;
  positionMs: number;
  startAtServerMs: number;
}

/**
 * Position ou le lecteur devrait se trouver a `localNowMs`.
 *
 * Le terme `elapsed` porte la compensation du retard (KTD12): quand l'instant de
 * depart est deja passe a la reception, reprendre a la position brute injecterait
 * un retard egal a ce depassement, et la boucle a la seconde ne le rattraperait
 * jamais sous son plancher. Le mecanisme de realignement deviendrait alors la
 * premiere source de derive, a chaque changement de morceau.
 */
export function targetPositionMs(start: CommonStart, offsetMs: number, localNowMs: number): number {
  const serverNowMs = localNowMs + offsetMs;
  const elapsed = serverNowMs - start.startAtServerMs;
  return start.positionMs + Math.max(0, elapsed);
}

/** Positif quand le client est en retard sur la cible, negatif quand il est en avance. */
export function observedGapMs(targetMs: number, actualMs: number): number {
  return targetMs - actualMs;
}
