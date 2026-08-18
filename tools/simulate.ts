/*
 * Simulateur du moteur de synchronisation. Outil de developpement, hors du perimetre
 * du plan: il ne sert a rien en production, il sert a voir le moteur se comporter.
 *
 *   npm run sim
 *
 * Aucun navigateur, aucun reseau, aucun serveur. Toutes les horloges sont fausses
 * et controlees, ce qui est exactement ce que R22 demande.
 */

import { createClockEstimator, type ProbeSample } from "../client/sync/clock";
import { targetPositionMs, observedGapMs, type CommonStart } from "../client/sync/timeline";
import { decide, type Thresholds } from "../client/sync/corrector";
import { createBarrier } from "../shared/sync/barrier";

const T: Thresholds = {
  floorMs: 300,        // mesure du 2026-08-19: cadence de position 266 ms
  ceilingMs: 3_000,    // provisoire, U7 le derive du seuil audible
  resorptionWindowMs: 10_000,
  rateStep: 0.05,
  rateMin: 0.25,
  rateMax: 2,
};

const LOOP_MS = 1_000; // cadence reelle en onglet arriere-plan (mesure du 2026-08-19)

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}
function num(v: number, n = 7): string {
  return pad((v >= 0 ? "+" : "") + v.toFixed(0), n);
}
function describe(d: ReturnType<typeof decide>): string {
  if (d.kind === "hold") return "rien";
  if (d.kind === "seek") return "SAUT vers " + (d.toPositionMs / 1000).toFixed(1) + " s";
  return "vitesse " + d.rate.toFixed(2) + " pendant " + (d.durationMs / 1000).toFixed(1) + " s";
}

/* --- Un client simule ------------------------------------------------------- */

interface ClientOptions {
  name: string;
  /** Ecart reel entre son horloge et celle du serveur, en ms. */
  clockOffsetMs: number;
  /** Temps reseau aller-retour, en ms. */
  networkMs: number;
  /** 1 = lecture nominale. 0.98 = le lecteur prend du retard sur l'horloge. */
  playbackFactor: number;
}

function makeClient(o: ClientOptions) {
  const est = createClockEstimator();
  let positionMs = 0;
  /*
   * Correction en cours. Sans cet etat cote appelant, le correcteur redecide une
   * nouvelle correction a chaque tour sans qu'aucune n aboutisse, et l ecart oscille
   * indefiniment autour du plancher. C est le contrat que U7 devra porter.
   */
  let inFlight: { rate: number; remainingMs: number } | null = null;

  return {
    name: o.name,
    /** Le client sonde le serveur; l'asymetrie du reseau varie a chaque tour. */
    probe(serverNowMs: number, asymmetryMs: number): void {
      const localSentAt = serverNowMs - o.clockOffsetMs;
      const outbound = o.networkMs / 2 + asymmetryMs;
      const inbound = o.networkMs / 2 - asymmetryMs;
      const sample: ProbeSample = {
        clientSentAt: localSentAt,
        serverReceivedAt: localSentAt + outbound + o.clockOffsetMs,
        serverSentAt: localSentAt + outbound + o.clockOffsetMs + 2,
        clientReceivedAt: localSentAt + outbound + inbound + 2,
      };
      est.accept(sample);
    },
    advance(realMs: number): void {
      positionMs += realMs * o.playbackFactor;
      if (inFlight) {
        const applied = Math.min(realMs, inFlight.remainingMs);
        positionMs += (inFlight.rate - 1) * applied;
        inFlight.remainingMs -= applied;
        if (inFlight.remainingMs <= 0) inFlight = null;
      }
    },
    correcting(): boolean {
      return inFlight !== null;
    },
    apply(d: ReturnType<typeof decide>): void {
      if (d.kind === "rate") inFlight = { rate: d.rate, remainingMs: d.durationMs };
      if (d.kind === "seek") positionMs = d.toPositionMs;
    },
    jumpTo(ms: number): void {
      positionMs = ms;
    },
    /** Ce que le moteur decide a cet instant, avec l'ecart reellement observe. */
    step(start: CommonStart, serverNowMs: number) {
      const localNow = serverNowMs - o.clockOffsetMs;
      const estimate = est.estimate();
      const target = targetPositionMs(start, estimate.offsetMs, localNow);
      const gap = observedGapMs(target, positionMs);
      return { estimate, target, gap, decision: decide(gap, target, T), positionMs };
    },
  };
}

/* --- Scenario 1: derive et correction --------------------------------------- */

function scenarioDrift(): void {
  console.log("\n=== Scenario 1: un client dont le lecteur prend du retard ===");
  console.log("Leo   : horloge +4200 ms, reseau 40 ms, lecture 0,4 % trop rapide");
  console.log("Pote  : horloge -1500 ms, reseau 90 ms, lecture 2 % trop lente\n");

  const leo = makeClient({ name: "Leo", clockOffsetMs: 4_200, networkMs: 40, playbackFactor: 1.004 });
  const pote = makeClient({ name: "Pote", clockOffsetMs: -1_500, networkMs: 90, playbackFactor: 0.98 });

  let serverNow = 1_000_000;
  // Rodage des horloges avant le depart: c'est la convergence exigee par R12.
  for (let i = 0; i < 8; i++) {
    leo.probe(serverNow, 0);
    pote.probe(serverNow, i === 3 ? 60 : 0); // un paquet asymetrique, que le filtre doit ignorer
    serverNow += 200;
  }
  console.log("Horloges estimees apres rodage:");
  console.log("  Leo  : " + leo.step({ barrierId: 1, positionMs: 0, startAtServerMs: serverNow }, serverNow).estimate.offsetMs.toFixed(1) + " ms (reel +4200)");
  console.log("  Pote : " + pote.step({ barrierId: 1, positionMs: 0, startAtServerMs: serverNow }, serverNow).estimate.offsetMs.toFixed(1) + " ms (reel -1500)\n");

  const start: CommonStart = { barrierId: 1, positionMs: 0, startAtServerMs: serverNow };
  leo.jumpTo(0);
  pote.jumpTo(0);

  console.log(pad("t", 6) + pad("ecart Leo", 11) + pad("ecart Pote", 12) + pad("entre eux", 11) + "decision Pote");
  console.log("-".repeat(78));

  for (let tick = 0; tick <= 60; tick++) {
    serverNow += LOOP_MS;
    leo.advance(LOOP_MS);
    pote.advance(LOOP_MS);
    leo.probe(serverNow, 0);
    pote.probe(serverNow, 0);

    const a = leo.step(start, serverNow);
    const b = pote.step(start, serverNow);
    const between = Math.abs(a.positionMs - b.positionMs);

    // On ne redecide pas tant que la correction precedente n est pas terminee.
    const aFresh = !leo.correcting();
    const bFresh = !pote.correcting();
    if (aFresh) leo.apply(a.decision);
    if (bFresh) pote.apply(b.decision);

    const shown = bFresh && b.decision.kind !== "hold";
    if (tick % 10 === 0 || shown) {
      console.log(
        pad(tick + " s", 6) + num(a.gap, 11) + num(b.gap, 12) + num(between, 11) +
        (shown ? describe(b.decision) : pote.correcting() ? "(correction en cours)" : "rien")
      );
    }
  }
  console.log("\n=> L ecart entre eux est la somme des deux ecarts locaux: c est la grandeur");
  console.log("   que R13 borne, et elle vaut au pire le double de la zone morte.");
}

/* --- Scenario 2: interruption et barriere ----------------------------------- */

function scenarioBarrier(): void {
  console.log("\n\n=== Scenario 2: une publicite chez le pote ===\n");
  const b = createBarrier({ participants: ["leo", "pote"], maxWaitMs: 45_000, leadMs: 500 });
  let t = 2_000_000;

  const opened = b.open({ positionMs: 90_000, atServerMs: t });
  console.log("t=0      barriere " + opened.barrierId + " ouverte a 90,0 s, on attend: " + opened.waitingFor.join(", "));

  t += 300;
  console.log("t=0.3    Leo se declare pret      -> " + b.ready({ barrierId: opened.barrierId, participantId: "leo" }, t).kind);

  t += 12_000;
  const out = b.ready({ barrierId: opened.barrierId, participantId: "pote" }, t);
  if (out.kind === "start") {
    console.log("t=12.3   Pote se declare pret     -> DEPART a " + ((out.startAtServerMs - t) / 1000).toFixed(1) + " s dans le futur, position " + (out.positionMs / 1000).toFixed(1) + " s");
  }

  console.log("\n--- meme scenario, mais le pote ne revient jamais ---");
  const b2 = createBarrier({ participants: ["leo", "pote"], maxWaitMs: 45_000, leadMs: 500 });
  let t2 = 3_000_000;
  const o2 = b2.open({ positionMs: 90_000, atServerMs: t2 });
  b2.ready({ barrierId: o2.barrierId, participantId: "leo" }, t2 + 300);
  const timeout = b2.tick(t2 + 45_001);
  console.log("t=45     delai expire, Leo est pret -> " + timeout.kind + " (Leo repart seul)");

  console.log("\n--- et si les deux calent en meme temps ---");
  const b3 = createBarrier({ participants: ["leo", "pote"], maxWaitMs: 45_000, leadMs: 500 });
  let t3 = 4_000_000;
  b3.open({ positionMs: 90_000, atServerMs: t3 });
  const both = b3.tick(t3 + 45_001);
  console.log("t=45     delai expire, personne pret -> " + both.kind + " (on prolonge, on ne relance pas)");

  console.log("\n--- et si un pret perime arrive apres un changement de morceau ---");
  const b4 = createBarrier({ participants: ["leo", "pote"], maxWaitMs: 45_000, leadMs: 500 });
  let t4 = 5_000_000;
  const first = b4.open({ positionMs: 90_000, atServerMs: t4 });
  const second = b4.open({ positionMs: 0, atServerMs: t4 + 5_000 });
  const stale = b4.ready({ barrierId: first.barrierId, participantId: "leo" }, t4 + 5_100);
  console.log("         barriere " + first.barrierId + " puis " + second.barrierId + ", pret pour la " + first.barrierId + " -> " + stale.kind + " (jete)");
}

scenarioDrift();
scenarioBarrier();
console.log("");
