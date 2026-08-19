/*
 * Couche de branchement (U7). Elle ne decide rien: elle pousse les observations dans
 * le moteur et traduit ses decisions en appels a l adaptateur.
 *
 * Une seule regle lui appartient en propre, et elle est load-bearing: une correction
 * en cours doit aller a son terme. Sans elle, le correcteur redecide une nouvelle
 * correction a chaque tour sans qu aucune n aboutisse, et l ecart oscille
 * indefiniment autour du plancher. Defaut trouve par le simulateur, pas par les tests.
 */

import type { ClientMessage, ServerMessage } from "../../shared/protocol";
import type { PlayerPort } from "../player/playerPort";
import { createClockEstimator } from "./clock";
import { createDriftLog } from "./driftLog";
import { decide, type Thresholds } from "./corrector";
import { observedGapMs, targetPositionMs, type CommonStart } from "./timeline";
import { STALL_GRACE_MS } from "./thresholds";

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
  let start: CommonStart | null = null;
  let pending: { barrierId: number; positionMs: number } | null = null;
  let inFlight: { endsAtMs: number } | null = null;
  let lastStallAtMs: number | null = null;
  let resumedAtMs: number | null = null;
  let pairGap: number | null = null;

  function stallAllowed(nowMs: number): boolean {
    if (lastStallAtMs !== null && nowMs - lastStallAtMs < STALL_GRACE_MS) return false;
    // Un participant qui vient de repartir n est pas redeclare en stagnation tout de suite.
    if (resumedAtMs !== null && nowMs - resumedAtMs < STALL_GRACE_MS) return false;
    return true;
  }

  return {
    onServerMessage(message: ServerMessage, nowMs: number): void {
      switch (message.type) {
        case "room_state":
          myId = message.youAre;
          return;

        case "clock_probe_reply":
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
          resumedAtMs = nowMs;
          return;
        }

        case "peer_positions": {
          if (myId === null) return;
          const mine = message.positions.find((p) => p.participantId === myId);
          const other = message.positions.find((p) => p.participantId !== myId);
          pairGap = mine && other ? mine.positionMs - other.positionMs : null;
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
      send({
        type: "position_report",
        positionMs: Math.max(0, observation.positionMs),
        observedAt: nowMs,
        fresh: observation.fresh,
      });

      // Une vitesse remise a 1 par un changement de morceau annule la correction en cours.
      if (player.takeRateReset()) inFlight = null;

      if (pending !== null) {
        // On ne se declare pret qu une fois l estimation d horloge convergee (R12):
        // sinon on convertirait l instant de depart avec un ecart encore faux.
        if (observation.fresh && clock.estimate().converged) {
          send({ type: "ready", barrierId: pending.barrierId, positionMs: pending.positionMs });
        }
        return;
      }

      if (start === null) return;

      const offset = clock.estimate().offsetMs;
      const target = targetPositionMs(start, offset, nowMs);
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

      if (!observation.fresh) {
        if (observation.playing && stallAllowed(nowMs)) {
          lastStallAtMs = nowMs;
          send({ type: "stall", positionMs: Math.max(0, observation.positionMs) });
        }
        return;
      }

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

    correcting(): boolean {
      return inFlight !== null;
    },
  };
}
