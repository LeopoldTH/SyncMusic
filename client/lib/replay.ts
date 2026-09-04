import type { ServerMessage } from "../../shared/protocol";

/** Un message tel qu il est arrive: son contenu et l instant de sa reception. */
export interface Recu {
  message: ServerMessage;
  atMs: number;
}

/*
 * Ce qu une session neuve doit reentendre pour savoir ou elle en est.
 *
 * Le lecteur peut mourir et renaitre, et la session nait avec lui, vierge. Deux
 * sources la renseignent, et elles se recouvrent: les derniers messages structurants
 * memorises au fil de l eau, et la file des messages arrives pendant qu aucune session
 * n existait. Quand la session manquait, `handle` a range le meme message aux deux
 * endroits.
 *
 * Deux defauts trouves en revue le 04/09/2026, tous deux dans ce recouvrement:
 *
 *  - le meme depart commun etait applique deux fois, la seconde avec son horodatage
 *    d origine. Or la position cible se calcule depuis l instant fourni: la seconde
 *    application visait un instant passe et faisait reculer le lecteur d autant que le
 *    lecteur avait mis a se charger;
 *  - l attente en cours n etait memorisee nulle part. Une session recreee pendant une
 *    barriere ignorait qu on attendait sa disponibilite, ne se declarait jamais prete,
 *    et son pair restait fige jusqu au delai maximum de quarante-cinq secondes.
 *
 * D ou la regle: un genre memorise se rejoue une seule fois, avec l heure courante,
 * et sa copie en file est ecartee. Les autres genres gardent leur horodatage d origine,
 * ce dont depend la sonde d horloge: son aller-retour se mesure a l instant ou la
 * reponse est vraiment arrivee, pas a celui du rejeu.
 */
export function aRejouer(
  memorises: ReadonlyArray<ServerMessage | null>,
  enAttente: readonly Recu[],
  nowMs: number,
): Recu[] {
  const retenus = memorises.filter((m): m is ServerMessage => m !== null);
  const genres = new Set(retenus.map((m) => m.type));
  return [
    ...retenus.map((message) => ({ message, atMs: nowMs })),
    ...enAttente.filter((p) => !genres.has(p.message.type)),
  ];
}
