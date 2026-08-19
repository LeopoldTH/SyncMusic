/*
 * Recuperation du titre d une video.
 *
 * Passe par oEmbed, l endpoint public de YouTube: pas de cle d API, pas de quota a
 * gerer, et rien a configurer pour deployer. En echange il ne donne que le titre et
 * l auteur, ce qui est exactement ce dont la file a besoin.
 */

const ENDPOINT = "https://www.youtube.com/oembed";

export async function fetchVideoTitle(videoId: string, timeoutMs = 4_000): Promise<string | null> {
  const url = `${ENDPOINT}?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: abort.signal });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null) return null;
    const title = (payload as { title?: unknown }).title;
    return typeof title === "string" && title.length > 0 ? title : null;
  } catch {
    // Une video privee, supprimee, ou un reseau capricieux: le morceau reste jouable
    // sous son identifiant. Un titre absent n est pas une erreur.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
