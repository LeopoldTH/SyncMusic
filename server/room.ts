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
  participants: Array<{ id: string; name: string }>;
  queue: QueueItem[];
  currentItemId: string | null;
  playing: boolean;
}

interface Presence {
  name: string;
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

  function positionAt(nowMs: number): number {
    if (timeline === null) return 0;
    if (!playing) return timeline.positionMs;
    return timeline.positionMs + Math.max(0, nowMs - timeline.startAtServerMs);
  }

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
      participants: [...presence.entries()].map(([id, p]) => ({ id, name: p.name })),
      queue: [...queue],
      currentItemId: currentItemId(),
      playing,
    };
  }

  return {
    state: snapshot,

    join(participantId: string, nowMs: number, name = "invite"): { ok: true; state: RoomSnapshot } | Failure {
      purge(nowMs);
      const existing = presence.get(participantId);
      if (existing) {
        // Reconnexion pendant le delai de grace: la room et sa file sont intactes.
        existing.connected = true;
        existing.disconnectedAt = null;
        existing.name = name;
        return { ok: true, state: snapshot() };
      }
      if (presence.size >= config.maxParticipants) {
        return fail("room_full", "cette room accueille deja deux participants");
      }
      presence.set(participantId, { name, connected: true, disconnectedAt: null });
      barrier.addParticipant(participantId, nowMs);
      return { ok: true, state: snapshot() };
    },

    disconnect(participantId: string, nowMs: number): void {
      const p = presence.get(participantId);
      if (!p) return;
      p.connected = false;
      p.disconnectedAt = nowMs;
    },

    /*
     * Une place est reprenable quand son occupant s est deconnecte et que le delai de
     * grace court encore. C est ce qui rend un rafraichissement de page inoffensif: le
     * client renvoie son identifiant et retrouve sa place, au lieu d en demander une
     * troisieme dans une room qui n en a que deux.
     *
     * La place doit etre libre. Un onglet duplique copie le sessionStorage de
     * l original, donc reclamerait un identifiant encore connecte: il devient un
     * nouveau participant, il ne prend pas la place de celui qui ecoute.
     */
    reclaimable(participantId: string, nowMs: number): boolean {
      const p = presence.get(participantId);
      return p !== undefined && !p.connected && !expired(p, nowMs);
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
      queue.push({ itemId, videoId, addedBy: participantId, title: null });
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

    /** Renseigne le titre une fois connu. Sans effet si le morceau a ete retire entre-temps. */
    setTitle(itemId: string, title: string): boolean {
      const item = queue.find((i) => i.itemId === itemId);
      if (!item) return false;
      item.title = title;
      return true;
    },

    control(action: "play" | "pause" | "next" | "previous", nowMs: number): void {
      if (action === "play") {
        if (currentIndex === null && queue.length > 0) currentIndex = 0;
        /*
         * Reancrer la timeline sur maintenant. Sans cela le temps ecoule pendant la
         * pause serait compte comme de la lecture, et on reprendrait plus loin que la
         * ou on s est arrete.
         */
        timeline = { positionMs: positionAt(nowMs), startAtServerMs: nowMs };
        playing = currentIndex !== null;
        return;
      }
      if (action === "pause") {
        /*
         * Figer la position au moment de la pause. Sans cela le serveur ne retient que
         * le point de depart du dernier depart commun, et la reprise repart de la.
         */
        timeline = { positionMs: positionAt(nowMs), startAtServerMs: nowMs };
        playing = false;
        return;
      }
      if (action === "next") {
        const from = currentIndex ?? -1;
        const to = from + 1;
        timeline = null; // un nouveau morceau repart de son debut
        if (to >= queue.length) { currentIndex = null; playing = false; return; }
        currentIndex = to;
        return;
      }
      // previous
      if (currentIndex === null) return;
      timeline = null;
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

    /*
     * Source unique de l ecart par paire: un client ne voit jamais celui de l autre.
     *
     * Chaque position est ramenee a `nowMs` avant d etre diffusee. Sans ce recalage,
     * deux rapports arrives a une seconde d intervalle produisent une seconde d ecart
     * apparent alors que les deux lecteurs sont parfaitement en phase.
     */
    peerPositions(nowMs: number) {
      return {
        atServerMs: nowMs,
        positions: [...positions.entries()].map(([participantId, r]) => {
          const ageMs = Math.max(0, nowMs - r.atServerMs);
          // On n extrapole que ce qui avancait vraiment: une position figee le reste.
          const advanced = playing && r.fresh ? ageMs : 0;
          return {
            participantId,
            positionMs: r.positionMs + advanced,
            fresh: r.fresh,
            ageMs,
          };
        }),
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
      return positionAt(nowMs);
    },

    tick(nowMs: number): BarrierOutcome {
      purge(nowMs);
      return noteStart(barrier.tick(nowMs));
    },

    resumeAt(positionMs: number, nowMs: number): Waiting {
      playing = true;
      return barrier.open({ positionMs, atServerMs: nowMs });
    },

    /*
     * Fin de piste annoncee par un client. Idempotent: le second rapport porte
     * l identifiant du morceau precedent, donc il ne fait rien.
     */
    trackEnded(itemId: string, nowMs: number): { advanced: boolean; hasNext: boolean } {
      if (itemId !== currentItemId()) return { advanced: false, hasNext: false };
      this.control("next", nowMs);
      return { advanced: true, hasNext: currentItemId() !== null };
    },

    /** Un arrivant en cours de lecture doit passer par un depart commun (F1). */
    rejoinBarrier(nowMs: number): Waiting | null {
      if (!playing) return null;
      return barrier.open({ positionMs: this.positionNow(nowMs), atServerMs: nowMs });
    },
  };
}
