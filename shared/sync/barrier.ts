/*
 * Le depart commun (R11, KTD11).
 *
 * Vit dans `shared` parce que le serveur l'execute: il est le seul detenteur du
 * quorum et du delai maximum (KD3). Deux minuteries concurrentes, une de chaque
 * cote, expireraient a des instants differents et produiraient exactement la
 * reprise desalignee que R11 interdit.
 *
 * Pur et sans horloge implicite: chaque appel recoit l'instant serveur courant,
 * ce qui rend la machine a etats testable sans navigateur (R22).
 */

export interface BarrierConfig {
  participants: string[];
  /** Au-dela, on repart sans le retardataire, sauf si personne n'est pret (R17). */
  maxWaitMs: number;
  /** Marge placee devant l'instant de depart, pour qu'il soit toujours dans le futur. */
  leadMs: number;
}

export interface Waiting {
  kind: "waiting";
  barrierId: number;
  /** Ou chaque participant doit se placer avant de se declarer pret. */
  positionMs: number;
  waitingFor: string[];
}

export type BarrierOutcome =
  | Waiting
  | { kind: "start"; barrierId: number; positionMs: number; startAtServerMs: number }
  | { kind: "ignored" };

export interface BarrierRef {
  barrierId: number;
  participantId: string;
}

export function createBarrier(config: BarrierConfig) {
  const participants = new Set(config.participants);
  const ready = new Set<string>();
  let barrierId = 0;
  let open = false;
  let positionMs = 0;
  let deadlineAtServerMs = 0;

  function waiting(): Waiting {
    return {
      kind: "waiting",
      barrierId,
      positionMs,
      waitingFor: [...participants].filter((p) => !ready.has(p)),
    };
  }

  function start(atServerMs: number): BarrierOutcome {
    open = false;
    return {
      kind: "start",
      barrierId,
      positionMs,
      startAtServerMs: atServerMs + config.leadMs,
    };
  }

  /** Une disponibilite qui ne porte pas l'identifiant courant vient d'une barriere revolue. */
  function isCurrent(ref: BarrierRef): boolean {
    return open && ref.barrierId === barrierId;
  }

  return {
    open(args: { positionMs: number; atServerMs: number }): Waiting {
      barrierId += 1;
      open = true;
      ready.clear();
      positionMs = args.positionMs;
      deadlineAtServerMs = args.atServerMs + config.maxWaitMs;
      return waiting();
    },

    ready(ref: BarrierRef, atServerMs: number): BarrierOutcome {
      if (!isCurrent(ref)) return { kind: "ignored" };
      if (!participants.has(ref.participantId)) return { kind: "ignored" };
      ready.add(ref.participantId);
      const everyone = [...participants].every((p) => ready.has(p));
      return everyone ? start(atServerMs) : waiting();
    },

    tick(atServerMs: number): BarrierOutcome {
      if (!open || atServerMs < deadlineAtServerMs) return { kind: "ignored" };
      /*
       * Personne n'est pret: relancer produirait une lecture que nul ne peut honorer.
       * On prolonge (R17, AE6). Le cas n'est pas marginal: les deux clients jouent la
       * meme video a la meme position, donc une coupure publicitaire mediane les
       * frappe au meme instant.
       */
      if (ready.size === 0) {
        deadlineAtServerMs = atServerMs + config.maxWaitMs;
        return waiting();
      }
      return start(atServerMs);
    },

    addParticipant(participantId: string, _atServerMs: number): void {
      participants.add(participantId);
    },

    removeParticipant(participantId: string): void {
      participants.delete(participantId);
      ready.delete(participantId);
    },
  };
}
