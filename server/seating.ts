/*
 * L arrivee d un socket dans une room, place comprise.
 *
 * Ce module existe pour une raison de preuve, pas d elegance. La regle qu il porte —
 * on ne detient jamais deux places, et on ne rend la sienne qu une fois la suivante
 * acquise — vivait dans `server/index.ts`, que rien ne peut charger dans un test: son
 * import ouvre la base, arme trois minuteries et ecoute le port. Les tests ecrits
 * contre le registre passaient donc aussi bien avec la regle qu sans elle (revue du
 * 16/09/2026). Ici, elle est verifiable.
 *
 * Le transport reste dehors: ce module ne connait ni socket, ni diffusion. Il recoit
 * la room visee deja resolue et rend la main a l appelant pour tout ce qui part sur le
 * fil.
 */

import type { BarrierOutcome } from "../shared/sync/barrier";
import type { RoomErrorCode } from "./room";
import type { Room } from "./roomRegistry";

/** La place d un socket: qui il est, et dans quelle room il est assis. */
export interface Seat {
  participantId: string;
  code: string | null;
}

export interface SeatingDeps {
  /** La room quittee, ou `undefined` si le balayage l a deja detruite. */
  getRoom(code: string): Room | undefined;
  /*
   * Ce que l appelant fait d un depart deja effectue: prevenir ceux qui restent. Le
   * resultat porte la barriere, car partir peut debloquer leur depart commun ou leur
   * attente. La liberation elle-meme n est pas ici: elle appartient a ce module, sans
   * quoi rien ne la prouverait.
   */
  onDeparture(code: string, room: Room, outcome: BarrierOutcome, nowMs: number): void;
}

type Outcome = { ok: true } | { ok: false; code: RoomErrorCode; message: string };

/*
 * Asseoir `seat` dans `room`, sous l identite `nextId`, en liberant la place
 * precedente s il y en avait une autre.
 *
 * L ordre porte tout le sens. Rejoindre d abord: un join refuse ne doit pas couter sa
 * place a celui qui l avait deja, sinon taper le code d une room pleine laisse assis
 * nulle part. Reprendre une autre place de la room qu on occupe deja reste correct
 * dans cet ordre, l identifiant repris etant deja present, donc traite par la branche
 * de reconnexion de `join`, qui ne retate pas le plafond.
 *
 * La comparaison porte sur la place, pas seulement sur la room: rejoindre la sienne ne
 * libere rien, c est le rafraichissement; reprendre celle d a cote libere bien la
 * sienne, qui resterait fantome autrement.
 */
export function enterRoom(
  seat: Seat,
  code: string,
  room: Room,
  nextId: string,
  name: string,
  nowMs: number,
  deps: SeatingDeps,
): Outcome {
  const joined = room.join(nextId, nowMs, name);
  if (!joined.ok) return { ok: false, code: joined.code, message: joined.message };

  const previousCode = seat.code;
  const keepsSameSeat = previousCode === code && seat.participantId === nextId;
  if (previousCode !== null && !keepsSameSeat) {
    const previousId = seat.participantId;
    // Couper la place avant de prevenir: l appelant filtre ses destinataires sur elle,
    // donc le partant ne doit plus recevoir l etat de la room qu il vient de quitter.
    seat.code = null;
    const previous = deps.getRoom(previousCode);
    if (previous) deps.onDeparture(previousCode, previous, previous.leave(previousId, nowMs), nowMs);
  }

  seat.participantId = nextId;
  seat.code = code;
  return { ok: true };
}
