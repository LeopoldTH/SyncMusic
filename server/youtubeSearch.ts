/*
 * Recherche de videos (YouTube Data API v3, endpoint search.list).
 *
 * Contrairement a la recuperation de titre, qui passe par oEmbed sans cle, la
 * recherche exige une cle d API et consomme un quota serre: 100 unites par appel pour
 * un budget quotidien de 10 000, soit une centaine de recherches par jour pour toute
 * l application. C est la raison d etre du garde de budget cote route: sans lui, la
 * fonctionnalite meurt pour la journee au premier script qui passe.
 *
 * La cle ne quitte jamais le serveur. Une cle d API dans du JavaScript de navigateur
 * est publique par construction, et celle-ci est facturable.
 */

import { z } from "zod";

export interface SearchResult {
  videoId: string;
  title: string;
  channel: string;
}

export type SearchOutcome =
  | { ok: true; results: SearchResult[] }
  /** Quota epuise chez Google. Distinct d une panne: reessayer n y changera rien. */
  | { ok: false; reason: "quota" }
  /** Reseau, delai depasse, reponse illisible. Reessayer a du sens. */
  | { ok: false; reason: "unavailable" };

const ENDPOINT = "https://www.googleapis.com/youtube/v3/search";

/** Borne d affichage. Un titre YouTube peut etre tres long, l interface non. */
const TITLE_MAX_CHARS = 120;

/*
 * Reponse de l API, decrite au strict necessaire. Volontairement tolerante, a
 * l inverse du protocole interne: cette reponse vient de chez quelqu un d autre, elle
 * peut gagner des champs sans prevenir, et un resultat malforme ne doit pas faire
 * perdre les neuf autres.
 */
const SearchItem = z.object({
  id: z.object({ videoId: z.string().regex(/^[\w-]{11}$/) }),
  snippet: z.object({
    title: z.string().min(1),
    channelTitle: z.string(),
  }),
});

const SearchResponse = z.object({ items: z.array(z.unknown()).default([]) });

/*
 * L API rend ses titres echappes en HTML: « Simon &amp; Garfunkel » arrive tel quel,
 * et s afficherait tel quel. Verifie sur la vraie API le 29/08/2026.
 *
 * `&amp;` se decode en dernier, sinon `&amp;lt;` deviendrait `<` au lieu de `&lt;`:
 * c est le piege classique de ce genre de fonction.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Extrait les resultats exploitables d une reponse de l API. Pur: c est ici que vit
 * tout ce qui merite un test, la fonction reseau ci-dessous ne fait que l alimenter.
 */
export function parseSearchResponse(payload: unknown): SearchResult[] {
  const envelope = SearchResponse.safeParse(payload);
  if (!envelope.success) return [];

  const results: SearchResult[] = [];
  for (const raw of envelope.data.items) {
    const item = SearchItem.safeParse(raw);
    // Un resultat qui n est pas une video (chaine, playlist) n a pas d id.videoId.
    if (!item.success) continue;
    results.push({
      videoId: item.data.id.videoId,
      title: decodeEntities(item.data.snippet.title).slice(0, TITLE_MAX_CHARS),
      channel: decodeEntities(item.data.snippet.channelTitle).slice(0, TITLE_MAX_CHARS),
    });
  }
  return results;
}

export interface SearchOptions {
  maxResults?: number;
  timeoutMs?: number;
}

export async function searchVideos(
  query: string,
  apiKey: string,
  options: SearchOptions = {},
): Promise<SearchOutcome> {
  const url = new URL(ENDPOINT);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("part", "snippet");
  // Sans ce filtre, l API rend aussi des chaines et des playlists, qu on jetterait
  // apres coup: autant ne pas les payer.
  url.searchParams.set("type", "video");
  url.searchParams.set("maxResults", String(options.maxResults ?? 10));
  url.searchParams.set("q", query);

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 5_000);
  try {
    const response = await fetch(url, { signal: abort.signal });
    if (response.status === 403) {
      /*
       * 403 couvre aussi bien le quota epuise qu une cle mal restreinte. Seul le
       * premier cas se resorbe tout seul, et c est le seul qu on sache expliquer a
       * l utilisateur: on lit le motif plutot que de deviner.
       */
      const body: unknown = await response.json().catch(() => null);
      const reason = (body as { error?: { errors?: Array<{ reason?: string }> } })
        ?.error?.errors?.[0]?.reason;
      return { ok: false, reason: reason === "quotaExceeded" ? "quota" : "unavailable" };
    }
    if (!response.ok) return { ok: false, reason: "unavailable" };
    return { ok: true, results: parseSearchResponse(await response.json()) };
  } catch {
    return { ok: false, reason: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}
