/*
 * Genres des videos (YouTube Data API v3, endpoint videos.list, part=topicDetails).
 *
 * Le genre est celui qu indique YouTube (decision de seance), et il se remplit par
 * lots sur les lignes deja enregistrees, jamais au moment d ajouter un morceau
 * (KTD5): le chemin de la room reste intact, un appel couvre cinquante videos, et
 * l existant se rattrape par construction. Un genre n est pas perissable, contrairement
 * a une duree.
 *
 * Mesure du 09/09/2026: un lot de cinquante identifiants coute 1 unite de quota, la ou
 * une recherche en coute 100, sur un budget quotidien de 10 000. Le garde de budget de
 * la recherche ne voit pas cet appel et ne doit pas le voir: il facturerait cent unites
 * pour un lot qui en coute une. Le quota est protege ici par deux bornes: le nombre de
 * lots par passage, et le delai minimal entre deux passages (revue du 11/09/2026, #8).
 *
 * La cle ne quitte jamais le serveur, comme pour la recherche: une cle d API dans du
 * JavaScript de navigateur est publique par construction, et celle-ci est facturable.
 */

import { z } from "zod";
import type { Db } from "./db";
import { classifyYoutubeApiError } from "./youtubeApiError";

/** Genres d une video, deja normalises. Un tableau vide = interrogee, aucun genre. */
export interface VideoTopics {
  videoId: string;
  genres: string[];
}

export type TopicsOutcome =
  | { ok: true; topics: VideoTopics[] }
  /** Quota epuise chez Google. Distinct d une panne: reessayer n y changera rien. */
  | { ok: false; reason: "quota" }
  /** Reseau, delai depasse, reponse illisible. Reessayer a du sens. */
  | { ok: false; reason: "unavailable" };

const ENDPOINT = "https://www.googleapis.com/youtube/v3/videos";

/** Borne de l API: cinquante identifiants par requete, pour une unite de quota. */
export const BATCH_SIZE = 50;

/*
 * Lots par passage. Deux cents videos, quatre unites de quota: assez pour qu un
 * historique ordinaire soit couvert en un passage, assez peu pour qu un passage ne coute
 * rien de sensible sur les 10 000 unites du jour. Ce qui deborde attend le passage
 * suivant. Cette borne ne dit rien de la cadence des passages: c est le role de
 * MIN_FILL_INTERVAL_MS.
 */
const MAX_BATCHES_PER_RUN = 4;

/*
 * Reponse de l API, decrite au strict necessaire. Volontairement tolerante, a l inverse
 * du protocole interne: elle vient de chez quelqu un d autre, elle peut gagner des
 * champs sans prevenir, et une video malformee ne doit pas faire perdre les 49 autres.
 *
 * `topicDetails` est absent des que YouTube n attribue aucune categorie, et c est un
 * cas normal (AE8, R4): la video est alors interrogee sans genre, pas en erreur.
 */
const TopicItem = z.object({
  id: z.string().min(1),
  topicDetails: z.object({ topicCategories: z.array(z.unknown()).default([]) }).optional(),
});

const TopicsResponse = z.object({ items: z.array(z.unknown()).default([]) });

/*
 * L API rend des adresses d articles Wikipedia, pas des etiquettes. Mesure du
 * 09/09/2026 sur Despacito:
 *   https://en.wikipedia.org/wiki/Electronic_music -> « Electronic music »
 *
 * Une adresse qui ne pointe pas un article Wikipedia n a pas d etiquette a en tirer:
 * on l ecarte plutot que d inventer.
 */
const ARTICLE_URL = /^https?:\/\/[\w-]+\.wikipedia\.org\/wiki\/(.+)$/i;

/*
 * « Music » figure sur presque toutes les videos musicales et ne dit rien: la garder
 * ferait un premier genre partage par tout l historique. Une video dont il ne reste
 * rien apres ce filtre est « interrogee, aucun genre » (KTD12).
 */
const GENERIC_LABEL = "music";

/** L etiquette d une adresse d article, ou null quand il n y a rien a en tirer. */
function labelOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const slug = ARTICLE_URL.exec(raw)?.[1];
  if (slug === undefined) return null;

  // Une ancre ou un parametre ne fait pas partie du titre de l article.
  const title = slug.split(/[#?]/)[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(title);
  } catch {
    // Echappement invalide: aucune etiquette lisible a en tirer, et « %E0%A4 » n a
    // rien a faire dans un classement de genres.
    return null;
  }

  const label = decoded.replace(/_/g, " ").trim();
  if (label.length === 0) return null;
  return label.toLowerCase() === GENERIC_LABEL ? null : label;
}

function genresOf(categories: readonly unknown[]): string[] {
  // Deux adresses peuvent donner la meme etiquette: un genre ne doit compter qu une fois.
  const labels = new Set<string>();
  for (const raw of categories) {
    const label = labelOf(raw);
    if (label !== null) labels.add(label);
  }
  return [...labels];
}

/**
 * Extrait les genres exploitables d une reponse de l API. Pur: c est ici que vit tout
 * ce qui merite un test, la fonction reseau ci-dessous ne fait que l alimenter.
 *
 * Une reponse illisible rend une liste vide, jamais une exception: l appelant n ecrit
 * alors rien, et aucun genre deja en base n est efface.
 */
export function parseTopicsResponse(payload: unknown): VideoTopics[] {
  const envelope = TopicsResponse.safeParse(payload);
  if (!envelope.success) return [];

  const topics: VideoTopics[] = [];
  for (const raw of envelope.data.items) {
    const item = TopicItem.safeParse(raw);
    if (!item.success) continue;
    topics.push({
      videoId: item.data.id,
      genres: genresOf(item.data.topicDetails?.topicCategories ?? []),
    });
  }
  return topics;
}

export interface TopicsOptions {
  timeoutMs?: number;
}

/**
 * Les genres d un lot d au plus cinquante identifiants, pour une unite de quota. Le
 * decoupage vit chez l appelant: c est lui qui borne le nombre de lots.
 */
export async function fetchVideoTopics(
  videoIds: readonly string[],
  apiKey: string,
  options: TopicsOptions = {},
): Promise<TopicsOutcome> {
  // Une requete sans identifiant couterait une unite pour rien.
  if (videoIds.length === 0) return { ok: true, topics: [] };

  const url = new URL(ENDPOINT);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("part", "topicDetails");
  url.searchParams.set("id", videoIds.slice(0, BATCH_SIZE).join(","));

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 5_000);
  try {
    const response = await fetch(url, { signal: abort.signal });
    if (!response.ok) return { ok: false, reason: await classifyYoutubeApiError(response) };
    return { ok: true, topics: parseTopicsResponse(await response.json()) };
  } catch {
    return { ok: false, reason: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

export interface FillGenresOptions {
  db: Db;
  apiKey: string;
  /** Lots d au plus cinquante videos par passage. Defaut: MAX_BATCHES_PER_RUN. */
  maxBatches?: number;
}

/*
 * Un passage de remplissage (U6, R11). Appelable sans etre attendu: la promesse ne
 * porte aucune donnee et ne rejette jamais. U7 le declenche, via createGenreFiller,
 * apres avoir compose sa reponse, et n en a rien a tirer. Ce qui manque a ce passage
 * revient au suivant, sans etat a garder: la colonne a NULL est la file d attente
 * (KTD12).
 *
 * Une video que YouTube ne rend pas reste a NULL et sera redemandee: c est ce que veut
 * une reponse partielle, et le prix a payer est au pire une unite par passage pour une
 * video devenue introuvable.
 */
export async function fillMissingGenres(options: FillGenresOptions): Promise<void> {
  try {
    const maxBatches = Math.max(0, Math.trunc(options.maxBatches ?? MAX_BATCHES_PER_RUN));
    const videoIds = options.db.listVideoIdsWithoutGenres(maxBatches * BATCH_SIZE);

    for (let start = 0; start < videoIds.length; start += BATCH_SIZE) {
      const outcome = await fetchVideoTopics(
        videoIds.slice(start, start + BATCH_SIZE),
        options.apiKey,
      );
      if (!outcome.ok) {
        /*
         * Quota epuise: les lots suivants seront refuses pareil, et chaque tentative
         * reste facturee. Une panne, elle, peut ne concerner que cette requete: on tente
         * le lot suivant, et celui-ci se retentera au passage suivant.
         */
        if (outcome.reason === "quota") return;
        continue;
      }
      for (const topic of outcome.topics) {
        options.db.setVideoGenres(topic.videoId, topic.genres);
      }
    }
  } catch {
    /*
     * Revue du 11/09/2026, #4. « Ne rejette jamais » n etait qu affirme: une base
     * verrouillee (SQLITE_BUSY) ou un disque plein font lever la lecture ou l ecriture,
     * et personne n attend cette promesse. Node arrete alors le process sur le rejet
     * non rattrape, toutes les rooms avec. Ce qui est reste a NULL revient au passage
     * suivant.
     *
     * Une ligne fixe, jamais l objet d erreur, comme pour les requetes dans index.ts:
     * son contexte peut porter un secret.
     */
    console.error("erreur pendant le remplissage des genres");
  }
}

/*
 * Delai minimal entre deux demarrages de passage (revue du 11/09/2026, #8). La borne de
 * lots se compte par passage, pas dans le temps: sans ce delai, recharger la route de
 * statistiques en boucle payait jusqu a quatre unites par requete, et une video que
 * YouTube ne rend plus, restee a NULL, rendait ce cout perpetuel.
 *
 * Hypothese assumee: une soiree tout juste enregistree peut attendre quelques minutes
 * ses genres. En echange, le pire cas ne depend plus du nombre de requetes: 144 passages
 * par jour a quatre unites, 576 unites sur les 10 000.
 */
const MIN_FILL_INTERVAL_MS = 10 * 60_000;

export interface GenreFillerOptions extends FillGenresOptions {
  /** Delai minimal entre deux demarrages de passage. Defaut: MIN_FILL_INTERVAL_MS. */
  minIntervalMs?: number;
  /**
   * Horloge en millisecondes, injectee par les tests. Defaut: monotone, pour qu un
   * reglage de l heure du systeme ne bloque ni ne relance le remplissage.
   */
  now?: () => number;
}

/*
 * Le declencheur du remplissage, un par process (revue du 11/09/2026, #8). Il garde le
 * seul etat que la base ne porte pas: un passage tourne-t-il deja, et quand le dernier
 * a-t-il demarre. Il borne quand un passage part, jamais ce qu il fait: les genres se
 * remplissent toujours par lots et apres coup, jamais a l ajout d un morceau (KTD5).
 */
export function createGenreFiller(options: GenreFillerOptions) {
  const minIntervalMs = options.minIntervalMs ?? MIN_FILL_INTERVAL_MS;
  const now = options.now ?? (() => performance.now());
  let running = false;
  let lastStartedAtMs: number | null = null;

  return {
    /*
     * Lance un passage, ou ne fait rien si un passage tourne deja ou a demarre il y a
     * moins de `minIntervalMs`. La promesse se resout a la fin du passage lance, ou tout
     * de suite quand rien ne part, et ne rejette jamais.
     */
    async trigger(): Promise<void> {
      if (running) return;
      const startedAtMs = now();
      if (lastStartedAtMs !== null && startedAtMs - lastStartedAtMs < minIntervalMs) return;

      running = true;
      lastStartedAtMs = startedAtMs;
      try {
        await fillMissingGenres(options);
      } finally {
        // Un passage qui echoue ne doit pas eteindre le remplissage jusqu au redemarrage.
        running = false;
      }
    },
  };
}
