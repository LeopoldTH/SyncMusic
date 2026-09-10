/*
 * Ecriture de l historique au depart commun (U5, KTD6).
 *
 * Le point d ecriture est la diffusion d un common_start: c est le seul instant ou le
 * serveur sait a la fois quel morceau part et qui est la pour l entendre. La logique
 * vit ici plutot que dans le transport pour se tester avec une base en memoire, et
 * room.ts reste sans persistance (KD3): la room ne sait meme pas que ce module existe.
 *
 * L idempotence n est pas geree ici: les departs communs se repetent (pause, pub,
 * stall) et recordListen s appuie sur la contrainte UNIQUE de la base (KTD6). On peut
 * donc appeler cette fonction a chaque depart sans y penser.
 */

import type { Db, User } from "./db";
import type { RoomSnapshot } from "./room";

export function recordCommonStart(args: {
  db: Db;
  /** L instance de room, jamais le code a quatre lettres, qui se recycle (KTD6). */
  instanceId: string;
  snapshot: RoomSnapshot;
  /** Les participants presents a cet instant; null pour un invite. */
  users: Array<User | null>;
  nowMs: number;
}): void {
  const { snapshot } = args;
  if (snapshot.currentItemId === null) return;
  const item = snapshot.queue.find((i) => i.itemId === snapshot.currentItemId);
  if (item === undefined) return;
  /*
   * YouTube refuse de decrire cette video: privee, supprimee, inexistante (R14). Elle
   * n entre pas dans l historique, sinon la memoire des ecoutes se remplirait de
   * lignes qu on ne saura jamais nommer. Une panne reseau, elle, ne pose pas ce
   * drapeau: le morceau s enregistre alors sans artiste (R4).
   */
  if (item.refused) return;

  for (const user of args.users) {
    if (user === null) continue; // un invite ne laisse aucune trace (R10)
    args.db.recordListen(
      {
        userId: user.id,
        videoId: item.videoId,
        // Copie de ce que la queue connait deja, sinon null: pas de second fetch, et
        // pas de rattrapage quand la reponse oEmbed arrive apres coup (choix de U5).
        title: item.title,
        channelTitle: item.channelTitle,
        thumbnailUrl: item.thumbnailUrl,
        roomItemKey: `${args.instanceId}#${item.itemId}`,
        // L instance passe explicitement: c est ici qu on construit la cle, donc le
        // seul endroit qui doive connaitre son format (KTD4).
        roomInstanceId: args.instanceId,
      },
      args.nowMs,
    );
  }
}
