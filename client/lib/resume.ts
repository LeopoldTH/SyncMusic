/*
 * Ce que cet onglet etait en train de faire, relu au chargement pour revenir dans sa
 * room au lieu de repasser par l ecran d accueil.
 *
 * Defaut du 23/08/2026: un rafraichissement sortait de la room, et comme le serveur
 * garde la place pendant son delai de grace, la room devenait injoignable — pleine
 * pour celui-la meme qui l occupait. Rendre son identifiant suffisait a reprendre sa
 * place, mais obligeait a retaper le code avant la fin du delai. Ne jamais sortir de
 * la room est le comportement attendu; la reprise manuelle n en etait que le symptome
 * repare.
 *
 * sessionStorage et non localStorage: la portee par onglet est exactement la bonne
 * semantique. Le rafraichissement conserve la place, alors que deux onglets restent
 * deux participants — c est ce qui permet de tester a deux sur une seule machine.
 */

import { JoinRoom } from "../../shared/protocol";

/** Exactement de quoi reconstruire un `join_room`: c est le seul usage de cet objet. */
export interface ResumeRecord {
  code: string;
  participantId: string;
  name: string;
}

const KEY = "syncmusic.session";

/**
 * Relit la trace, ou `null` s il n y en a pas d exploitable.
 *
 * La valeur stockee est validee par le schema du message qu elle servira a envoyer.
 * Une trace laissee par une version anterieure, tronquee ou modifiee a la main ne doit
 * ni faire echouer le demarrage, ni partir sur le reseau pour revenir en erreur de
 * protocole que l utilisateur ne saurait pas lire.
 */
export function readResume(store: Storage): ResumeRecord | null {
  const raw = store.getItem(KEY);
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const candidate = JoinRoom.safeParse({ ...parsed, type: "join_room" });
  if (!candidate.success) return null;
  const { code, name, participantId } = candidate.data;
  // Une trace sans identifiant ne sert a rien: elle ferait perdre sa place au revenant.
  if (participantId === undefined) return null;
  return { code, participantId, name };
}

export function saveResume(store: Storage, record: ResumeRecord): void {
  store.setItem(KEY, JSON.stringify(record));
}

export function clearResume(store: Storage): void {
  store.removeItem(KEY);
}
