/*
 * Etat de verite d'une room (KD3). Aucun socket ici: la logique se teste sans
 * ouvrir de connexion, et le transport se contente de la piloter.
 */

import { createBarrier, type BarrierOutcome, type Waiting } from "../shared/sync/barrier";
import type { QueueItem } from "../shared/protocol";

export interface RoomConfig {
  maxParticipants: number;
  maxWaitMs: number;
  leadMs: number;
  /** Une coupure reseau breve ne doit pas detruire la room et sa file. */
  graceMs: number;
}

export type RoomErrorCode = "room_full" | "not_in_room" | "cannot_remove_playing";

type Failure = { ok: false; code: RoomErrorCode; message: string };
function fail(code: RoomErrorCode, message: string): Failure {
  return { ok: false, code, message };
}

export interface RoomSnapshot {
  code: string;
  participants: string[];
  queue: QueueItem[];
  currentItemId: string | null;
  playing: boolean;
}

interface Presence {
  connected: boolean;
  disconnectedAt: number | null;
}

interface Reported {
  positionMs: number;
  fresh: boolean;
  atServerMs: number;
}

export function createRoom(code: string, config: RoomConfig) {
  const presence = new Map<string, Presence>();
  const positions = new Map<string, Reported>();
  const queue: QueueItem[] = [];
  const barrier = createBarrier({ participants: [], maxWaitMs: config.maxWaitMs, leadMs: config.leadMs });

  let currentIndex: number | null = null;
  let playing = false;
  let nextItemId = 1;
  /*
   * Timeline autoritaire. Sans elle le serveur ignore ou en est la lecture, et ne peut
   * pas positionner un arrivant: la timeline ne vivrait que chez les clients deja la.
   */
  let timeline: { positionMs: number; startAtServerMs: number } | null = null;

  function noteStart(outcome: BarrierOutcome): BarrierOutcome {
    if (outcome.kind === "start") {
      timeline = { positionMs: outcome.positionMs, startAtServerMs: outcome.startAtServerMs };
    }
    return outcome;
  }

  /** Un participant deconnecte depuis plus que le delai de grace ne compte plus. */
  function expired(p: Presence, nowMs: number): boolean {
    return !p.connected && p.disconnectedAt !== null && nowMs - p.disconnectedAt >= config.graceMs;
  }

  function purge(nowMs: number): void {
    for (const [id, p] of presence) {
      if (expired(p, nowMs)) {
        presence.delete(id);
        positions.delete(id);
        barrier.removeParticipant(id);
      }
    }
  }

  function currentItemId(): string | null {
    if (currentIndex === null) return null;
    return queue[currentIndex]?.itemId ?? null;
  }

  function snapshot(): RoomSnapshot {
    return {
      code,
      participants: [...presence.keys()],
      queue: [...queue],
      currentItemId: currentItemId(),
      playing,
    };
  }

  return {
    state: snapshot,

    join(participantId: string, nowMs: number): { ok: true; state: RoomSnapshot } | Failure {
      purge(nowMs);
      const existing = presence.get(participantId);
      if (existing) {
        // Reconnexion pendant le delai de grace: la room et sa file sont intactes.
        existing.connected = true;
        existing.disconnectedAt = null;
        return { ok: true, state: snapshot() };
      }
      if (presence.size >= config.maxParticipants) {
        return fail("room_full", "cette room accueille deja deux participants");
      }
      presence.set(participantId, { connected: true, disconnectedAt: null });
      barrier.addParticipant(participantId, nowMs);
      return { ok: true, state: snapshot() };
    },

    disconnect(participantId: string, nowMs: number): void {
      const p = presence.get(participantId);
      if (!p) return;
      p.connected = false;
      p.disconnectedAt = nowMs;
    },

    /** Vraie seulement quand plus personne ne peut revenir. */
    isEmpty(nowMs: number): boolean {
      if (presence.size === 0) return true;
      for (const p of presence.values()) if (!expired(p, nowMs)) return false;
      return true;
    },

    queueAdd(participantId: string, videoId: string, nowMs: number):
      { ok: true; itemId: string } | Failure {
      if (!presence.has(participantId)) return fail("not_in_room", "participant inconnu dans cette room");
      const itemId = `q${nextItemId++}`;
      queue.push({ itemId, videoId, addedBy: participantId });
      void nowMs;
      return { ok: true, itemId };
    },

    queueRemove(participantId: string, itemId: string, nowMs: number): { ok: true } | Failure {
      if (!presence.has(participantId)) return fail("not_in_room", "participant inconnu dans cette room");
      if (itemId === currentItemId()) {
        return fail("cannot_remove_playing", "le morceau en cours ne peut pas etre retire de la file");
      }
      const index = queue.findIndex((i) => i.itemId === itemId);
      if (index === -1) return { ok: true };
      queue.splice(index, 1);
      // L index courant suit le decalage, sinon on changerait de morceau en retirant
      // un titre place avant lui dans la file.
      if (currentIndex !== null && index < currentIndex) currentIndex -= 1;
      void nowMs;
      return { ok: true };
    },

    control(action: "play" | "pause" | "next" | "previous", nowMs: number): void {
      void nowMs;
      if (action === "play") {
        if (currentIndex === null && queue.length > 0) currentIndex = 0;
        playing = currentIndex !== null;
        return;
      }
      if (action === "pause") { playing = false; return; }
      if (action === "next") {
        const from = currentIndex ?? -1;
        const to = from + 1;
        if (to >= queue.length) { currentIndex = null; playing = false; return; }
        currentIndex = to;
        return;
      }
      // previous
      if (currentIndex === null) return;
      currentIndex = Math.max(0, currentIndex - 1);
    },

    clockProbe(clientSentAt: number, receivedAtServerMs: number) {
      return {
        clientSentAt,
        serverReceivedAt: receivedAtServerMs,
        // Traitement en memoire: la reemission suit immediatement la reception.
        serverSentAt: receivedAtServerMs,
      };
    },

    reportPosition(participantId: string, report: { positionMs: number; fresh: boolean }, nowMs: number): void {
      if (!presence.has(participantId)) return;
      positions.set(participantId, { ...report, atServerMs: nowMs });
    },

    /** Source unique de l ecart par paire: un client ne voit jamais celui de l autre. */
    peerPositions(nowMs: number) {
      return {
        atServerMs: nowMs,
        positions: [...positions.entries()].map(([participantId, r]) => ({
          participantId,
          positionMs: r.positionMs,
          fresh: r.fresh,
        })),
      };
    },

    /** Une stagnation annoncee ouvre une barriere a la position courante (KD5). */
    stall(participantId: string, positionMs: number, nowMs: number): BarrierOutcome | Waiting {
      if (!presence.has(participantId)) return { kind: "ignored" };
      playing = false;
      return barrier.open({ positionMs, atServerMs: nowMs });
    },

    ready(participantId: string, barrierId: number, nowMs: number): BarrierOutcome {
      return noteStart(barrier.ready({ barrierId, participantId }, nowMs));
    },

    /** Ou en est la lecture maintenant, du point de vue du serveur. */
    positionNow(nowMs: number): number {
      if (timeline === null) return 0;
      if (!playing) return timeline.positionMs;
      return timeline.positionMs + Math.max(0, nowMs - timeline.startAtServerMs);
    },

    retract(participantId: string, barrierId: number, nowMs: number): BarrierOutcome {
      return barrier.retract({ barrierId, participantId }, nowMs);
    },

    tick(nowMs: number): BarrierOutcome {
      purge(nowMs);
      return noteStart(barrier.tick(nowMs));
    },

    resumeAt(positionMs: number, nowMs: number): Waiting {
      playing = true;
      return barrier.open({ positionMs, atServerMs: nowMs });
    },

    /** Un arrivant en cours de lecture doit passer par un depart commun (F1). */
    rejoinBarrier(nowMs: number): Waiting | null {
      if (!playing) return null;
      return barrier.open({ positionMs: this.positionNow(nowMs), atServerMs: nowMs });
    },
  };
}
