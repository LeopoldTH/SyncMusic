/*
 * Recuperation de ce que YouTube dit d une video: titre, chaine, miniature.
 *
 * Passe par oEmbed, l endpoint public de YouTube: pas de cle d API, pas de quota a
 * gerer, et rien a configurer pour deployer. C est ce qui en fait la source de
 * l artiste sur tous les chemins d ajout, y compris l envoi d une playlist (U3,
 * KTD6): l artiste survit a un quota YouTube epuise, contrairement a la recherche.
 */

import { z } from "zod";

const ENDPOINT = "https://www.youtube.com/oembed";

/** Requetes oEmbed simultanees par defaut sur un ajout groupe (U3). */
const DEFAULT_PARALLEL = 4;

export type VideoInfoOutcome =
  /*
   * Reponse exploitable. Chaque champ reste nullable: oEmbed peut rendre 200 sans
   * titre ni chaine, et un champ absent n est pas une erreur (R4).
   */
  | { ok: true; title: string | null; channelTitle: string | null; thumbnailUrl: string | null }
  /** YouTube refuse de decrire la video: privee, supprimee, inexistante (R14). */
  | { ok: false; reason: "refused" }
  /** Reseau, delai depasse, reponse illisible. Le morceau reste jouable (R4). */
  | { ok: false; reason: "unavailable" };

/*
 * Reponse oEmbed, decrite au strict necessaire et volontairement tolerante, a
 * l inverse du protocole interne: elle vient de chez quelqu un d autre et peut gagner
 * des champs sans prevenir. Un champ manquant rend simplement une valeur nulle.
 */
const OEmbedResponse = z.object({
  title: z.string().min(1).optional(),
  author_name: z.string().min(1).optional(),
  thumbnail_url: z.string().min(1).optional(),
});

/*
 * Refus contre panne (R14). Un refus, c est YouTube qui dit que cette video n existe
 * pas pour lui: privee, supprimee, identifiant inexistant. Mesure de U3: un
 * identifiant invalide rend 400, une video valide rend 200.
 *
 * Un 5xx ou un 429 ne sont pas des refus mais des pannes chez YouTube. Les traiter
 * comme des refus ferait disparaitre de l historique, definitivement, tous les
 * morceaux ajoutes pendant une panne, alors que R4 demande exactement l inverse:
 * enregistrer le morceau sans artiste.
 */
function isRefusal(httpStatus: number): boolean {
  return httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429;
}

export async function fetchVideoInfo(videoId: string, timeoutMs = 4_000): Promise<VideoInfoOutcome> {
  const url = `${ENDPOINT}?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: abort.signal });
    if (!response.ok) {
      return { ok: false, reason: isRefusal(response.status) ? "refused" : "unavailable" };
    }
    const parsed = OEmbedResponse.safeParse(await response.json());
    // Une reponse illisible est une panne, pas un refus: rien ne dit que la video
    // n existe pas, et le morceau doit rester enregistrable sans artiste (R4).
    if (!parsed.success) return { ok: false, reason: "unavailable" };
    return {
      ok: true,
      title: parsed.data.title ?? null,
      channelTitle: parsed.data.author_name ?? null,
      thumbnailUrl: parsed.data.thumbnail_url ?? null,
    };
  } catch {
    // Une coupure reseau ou un delai depasse: le morceau reste jouable sous son
    // identifiant, et s enregistrera sans artiste. Ce n est pas une erreur.
    return { ok: false, reason: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

/*
 * Recuperation d une liste entiere, avec un plafond de requetes simultanees (U3).
 * Un envoi de playlist peut porter cent morceaux: sans plafond, c est cent requetes
 * d un coup vers YouTube pour un seul message client.
 *
 * Chaque resultat est rendu des qu il arrive, par son rang dans la liste, plutot
 * qu en bloc a la fin: la file se remplit au fil de l eau comme sur un ajout un par
 * un, et l appelant garde le lien avec son propre element de file.
 */
export async function fetchEachVideoInfo(
  videoIds: readonly string[],
  onOutcome: (index: number, outcome: VideoInfoOutcome) => void,
  parallel = DEFAULT_PARALLEL,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(parallel, videoIds.length) }, async () => {
    while (next < videoIds.length) {
      const index = next++;
      const videoId = videoIds[index];
      if (videoId === undefined) return;
      onOutcome(index, await fetchVideoInfo(videoId));
    }
  });
  await Promise.all(workers);
}
