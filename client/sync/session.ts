/*
 * Couche de branchement (U7). Elle ne decide rien: elle pousse les observations dans
 * le moteur et traduit ses decisions en appels a l adaptateur.
 *
 * Une seule regle lui appartient en propre, et elle est load-bearing: une correction
 * en cours doit aller a son terme. Sans elle, le correcteur redecide une nouvelle
 * correction a chaque tour sans qu aucune n aboutisse, et l ecart oscille
 * indefiniment autour du plancher. Defaut trouve par le simulateur, pas par les tests.
 */

import { probeReplyIsCoherent, type ClientMessage, type ServerMessage } from "../../shared/protocol";
import type { PlayerPort } from "../player/playerPort";
import { createClockEstimator } from "./clock";
import { createDriftLog } from "./driftLog";
import { decide, type Thresholds } from "./corrector";
import { observedGapMs, targetPositionMs, type CommonStart } from "./timeline";
import { STALE_REPORT_MS, STALL_GRACE_MS } from "./thresholds";
import { createStallDetector } from "./stallDetector";

export interface SessionDeps {
  player: PlayerPort;
  clock: ReturnType<typeof createClockEstimator>;
  log: ReturnType<typeof createDriftLog>;
  thresholds: Thresholds;
  send: (message: ClientMessage) => void;
}

export function createSession(deps: SessionDeps) {
  const { player, clock, log, thresholds, send } = deps;

  let myId: string | null = null;
  let currentItemId: string | null = null;
  let start: CommonStart | null = null;
  let pending: { barrierId: number; positionMs: number } | null = null;
  let inFlight: { endsAtMs: number } | null = null;
  let pairGap: number | null = null;
  let stallAnnounced = false;
  /*
   * Compensation de la latence de sortie audio (KD8). Une enceinte Bluetooth sort le
   * son avec du retard: pour l entendre au bon moment, il faut lire en avance d autant.
   * Non mesurable a distance, donc reglee a l oreille et conservee sur l appareil.
   */
  let outputLatencyMs = 0;
  let lastObservedPositionMs = 0;
  const stalls = createStallDetector({ graceMs: STALL_GRACE_MS });

  return {
    onServerMessage(message: ServerMessage, nowMs: number): void {
      switch (message.type) {
        case "room_state":
          myId = message.youAre;
          currentItemId = message.currentItemId;
          /*
           * La pause doit atteindre le lecteur. Sans cette ligne l etat partage change,
           * l interface l affiche, et la musique continue de jouer chez les deux.
           * La reprise, elle, repasse toujours par un depart commun (R11).
           */
          if (!message.playing) {
            player.pause();
            start = null;
          }
          return;

        case "clock_probe_reply":
          /*
           * Une reponse incoherente (reemission anterieure a la reception) ne peut pas
           * venir d une horloge saine. L accepter empoisonnerait l estimation pour
           * toute la fenetre glissante, sans que rien ne le signale.
           */
          if (!probeReplyIsCoherent(message)) return;
          clock.accept({
            clientSentAt: message.clientSentAt,
            serverReceivedAt: message.serverReceivedAt,
            serverSentAt: message.serverSentAt,
            clientReceivedAt: nowMs,
          });
          return;

        case "waiting":
          // On se place la ou le serveur l indique, puis on attend d etre pret.
          start = null;
          pending = { barrierId: message.barrierId, positionMs: message.positionMs };
          player.pause();
          player.seekTo(message.positionMs, nowMs);
          if (myId !== null && message.waitingFor.includes(myId)) {
            log.beginInterruption(myId, nowMs);
          }
          return;

        case "common_start": {
          pending = null;
          start = message;
          if (myId !== null) log.endInterruption(myId, nowMs);
          const offset = clock.estimate().offsetMs;
          // La cible porte deja la compensation du retard si l instant est passe.
          player.seekTo(targetPositionMs(message, offset, nowMs), nowMs);
          player.play({ automatic: true }, nowMs);
          stallAnnounced = false;
          return;
        }

        case "peer_positions": {
          if (myId === null) return;
          const mine = message.positions.find((p) => p.participantId === myId);
          const other = message.positions.find((p) => p.participantId !== myId);
          /*
           * Deux conditions pour que le chiffre veuille dire quelque chose: les deux
           * positions doivent etre des observations, pas des extrapolations perimees,
           * et aucune ne doit etre trop vieille pour que le recalage serveur tienne.
           * Sinon on affiche "inconnu" plutot qu un nombre faux.
           */
          const usable = (p: { fresh: boolean; ageMs: number }) => p.fresh && p.ageMs <= STALE_REPORT_MS;
          pairGap = mine && other && usable(mine) && usable(other)
            ? mine.positionMs - other.positionMs
            : null;
          return;
        }

        default:
          return;
      }
    },

    tick(nowMs: number): void {
      if (clock.shouldProbe(nowMs)) {
        clock.noteProbeSent(nowMs);
        send({ type: "clock_probe", clientSentAt: nowMs });
      }

      const observation = player.observe(nowMs);
      lastObservedPositionMs = observation.positionMs;
      const verdict = stalls.observe({
        positionMs: observation.positionMs,
        fresh: observation.fresh,
        playing: observation.playing,
        atMs: nowMs,
      });
      if (verdict.recovered) {
        stallAnnounced = false;
        if (myId !== null) log.endInterruption(myId, nowMs);
      }
      send({
        type: "position_report",
        positionMs: Math.max(0, observation.positionMs),
        fresh: observation.fresh,
      });

      // Une vitesse remise a 1 par un changement de morceau annule la correction en cours.
      if (player.takeRateReset()) inFlight = null;

      /*
       * Fin de piste: on le dit au serveur, qui avance la file. Sans cela la position
       * gele, le detecteur de stagnation prend le relais, et le morceau repart au lieu
       * de laisser la place au suivant.
       */
      if (player.takeEnded() && currentItemId !== null) {
        start = null;
        send({ type: "track_ended", itemId: currentItemId });
        return;
      }

      if (pending !== null) {
        // On ne se declare pret qu une fois l estimation d horloge convergee (R12):
        // sinon on convertirait l instant de depart avec un ecart encore faux.
        if (observation.fresh && clock.estimate().converged) {
          send({ type: "ready", barrierId: pending.barrierId, positionMs: pending.positionMs });
        }
        return;
      }

      if (start === null) return;

      /*
       * Le lecteur ne joue pas alors qu on le croit en lecture: pause prise sur les
       * controles de l iframe, publicite, ou refus du navigateur. Corriger n a alors
       * aucun sens, la cible avance et la position ne peut pas suivre.
       *
       * Sans cette porte, l ecart grandissait jusqu a produire un saut en avant toutes
       * les douze secondes environ, lecteur toujours en pause: la correction par
       * vitesse tenait sa fenetre de dix secondes sur un lecteur immobile, puis
       * l ecart accumule depassait le plafond et declenchait un saut vers la cible.
       * Ce qu il faut corriger, c est le fait que le lecteur soit arrete, pas sa
       * position — et cela ne se decide pas ici.
       */
      if (!observation.playing) return;

      const offset = clock.estimate().offsetMs;
      const target = targetPositionMs(start, offset, nowMs) + outputLatencyMs;
      const gap = observedGapMs(target, observation.positionMs);
      log.record({ atMs: nowMs, localGapMs: gap, pairGapMs: pairGap });

      // Une correction en cours va a son terme avant qu on en redecide une autre.
      if (inFlight !== null) {
        if (nowMs >= inFlight.endsAtMs) {
          player.setRate(1);
          inFlight = null;
        }
        return;
      }

      if (verdict.stalled) {
        if (!stallAnnounced) {
          stallAnnounced = true;
          if (myId !== null) log.beginInterruption(myId, nowMs);
          send({ type: "stall", positionMs: Math.max(0, observation.positionMs) });
        }
        return;
      }
      if (!observation.fresh) return;

      const decision = decide(gap, target, thresholds);
      if (decision.kind === "rate") {
        player.setRate(decision.rate);
        inFlight = { endsAtMs: nowMs + decision.durationMs };
        return;
      }
      if (decision.kind === "seek") {
        player.seekTo(decision.toPositionMs, nowMs);
      }
    },

    pairGapMs(): number | null {
      return pairGap;
    },

    setOutputLatencyMs(value: number): void {
      outputLatencyMs = value;
    },

    driftPoints() {
      return log.points();
    },

    driftSummary(thresholdMs: number) {
      return log.summary(thresholdMs);
    },

    correcting(): boolean {
      return inFlight !== null;
    },

    /** Etat interne, pour le diagnostic depuis la console. */
    debug() {
      return {
        myId,
        pending,
        hasStart: start !== null,
        positionMs: Math.round(lastObservedPositionMs),
        clock: clock.estimate(),
        outputLatencyMs,
        stallAnnounced,
      };
    },
  };
}
