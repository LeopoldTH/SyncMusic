/*
 * Journal de derive (R19, R20). Vit en memoire pour la session en cours: rien a
 * persister, la room elle-meme ne survit pas a sa fermeture (KD9).
 *
 * Aucune agregation: la courbe doit garder sa resolution sur toute la session,
 * puisque c est precisement sur une session longue que le critere de succes
 * s evalue. Une session de deux heures a une mesure par seconde tient en 7200
 * points, ce qui ne coute rien.
 */

export interface DriftPoint {
  atMs: number;
  /** Ecart de ce client a la timeline du serveur. */
  localGapMs: number;
  /** Ecart entre les deux participants. Null tant qu on ne connait pas l autre. */
  pairGapMs: number | null;
}

export interface Interruption {
  participantId: string;
  startedAtMs: number;
  endedAtMs: number | null;
}

export function createDriftLog() {
  const points: DriftPoint[] = [];
  const interruptions: Interruption[] = [];
  const open = new Map<string, Interruption>();

  return {
    record(point: DriftPoint): void {
      points.push(point);
    },

    beginInterruption(participantId: string, atMs: number): void {
      if (open.has(participantId)) return;
      const entry: Interruption = { participantId, startedAtMs: atMs, endedAtMs: null };
      open.set(participantId, entry);
      interruptions.push(entry);
    },

    endInterruption(participantId: string, atMs: number): void {
      const entry = open.get(participantId);
      if (!entry) return;
      entry.endedAtMs = atMs;
      open.delete(participantId);
    },

    points(): readonly DriftPoint[] {
      return points;
    },

    interruptions(): readonly Interruption[] {
      return interruptions;
    },

    /** Resume affichable: ce que le critere de succes regarde. */
    summary(thresholdMs: number) {
      const measured = points.filter((p) => p.pairGapMs !== null);
      const within = measured.filter((p) => Math.abs(p.pairGapMs ?? 0) <= thresholdMs).length;
      const closed = interruptions.filter((i) => i.endedAtMs !== null);
      const totalInterruptedMs = closed.reduce((sum, i) => sum + ((i.endedAtMs ?? 0) - i.startedAtMs), 0);
      return {
        points: points.length,
        measuredPoints: measured.length,
        withinThresholdRatio: measured.length === 0 ? null : within / measured.length,
        interruptions: interruptions.length,
        totalInterruptedMs,
      };
    },
  };
}
