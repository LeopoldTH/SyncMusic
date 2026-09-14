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
import type { PlayedSegment, RoomSnapshot } from "./room";

/*
 * Le format de la cle persistee, defini une seule fois (KTD4). Deux fonctions de ce
 * module l ecrivent: le changer dans l une sans l autre romprait le rapprochement
 * entre la ligne creee au depart commun et la duree qui s y ajoute, en silence et
 * sans qu aucun typecheck le voie.
 */
function roomItemKey(instanceId: string, itemId: string): string {
  return `${instanceId}#${itemId}`;
}

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
        roomItemKey: roomItemKey(args.instanceId, item.itemId),
        // L instance passe explicitement: c est ici qu on construit la cle, donc le
        // seul endroit qui doive connaitre son format (KTD4).
        roomInstanceId: args.instanceId,
      },
      args.nowMs,
    );
  }
}

/*
 * Ecriture de la duree quand un morceau cesse d etre courant (U4 memoire des ecoutes,
 * R1). La room a mesure avant de muter (KTD1) et rend le segment joue; c est ici qu on
 * construit la cle, comme au depart commun, et la seule ici (KTD4).
 *
 * Aucun compte en entree, et c est voulu (U4): la meme fonction sert a la destruction
 * d une room, ou plus aucune session n existe. Les lignes visees n existent que pour
 * des comptes connectes, le depart commun ayant deja applique la garde. Un morceau
 * qu aucun compte n a entendu ne touche donc rien.
 *
 * La duree s ajoute, elle ne remplace pas (KTD3): un morceau rappele par « precedent »
 * porte la meme cle, et un remplacement lui ferait perdre sa premiere ecoute.
 */
export function recordPlayedSegment(args: {
  db: Db;
  /** L instance de room, jamais le code a quatre lettres, qui se recycle (KTD6). */
  instanceId: string;
  played: PlayedSegment;
  /*
   * L horloge du serveur a l ecriture. Elle borne la duree au temps ecoule depuis le
   * premier depart commun: la position que rend la room peut venir d une stagnation
   * annoncee sans plafond par un autre participant (revue du 11/09/2026, #7).
   */
  nowMs: number;
}): void {
  const { item } = args.played;
  args.db.addListenedMs({
    roomItemKey: roomItemKey(args.instanceId, item.itemId),
    listenedMs: args.played.listenedMs,
    // Rattrapage d une reponse oEmbed arrivee apres le depart commun: la file les
    // connait peut-etre maintenant, et la ligne est deja en ecriture.
    title: item.title,
    channelTitle: item.channelTitle,
    thumbnailUrl: item.thumbnailUrl,
  }, args.nowMs);
}
