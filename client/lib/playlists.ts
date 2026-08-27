/*
 * Playlists du compte (U6, KTD8). Meme philosophie que account.ts et history.ts:
 * une reponse inattendue vaut « rien a montrer », et un refus du serveur revient
 * avec sa raison, prete a etre affichee.
 */

export interface Playlist {
  id: number;
  name: string;
  itemCount: number;
}

export interface PlaylistItem {
  videoId: string;
  title: string | null;
}

export type PlaylistResult<T> = { ok: true; value: T } | { ok: false; reason: string };

async function post(url: string, body: unknown): Promise<{ status: number; payload: unknown } | null> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json().catch(() => null) };
  } catch {
    return null;
  }
}

function reasonOf(payload: unknown, fallback: string): string {
  const reason = (payload as { error?: unknown } | null)?.error;
  return typeof reason === "string" ? reason : fallback;
}

export async function fetchPlaylists(): Promise<Playlist[] | null> {
  try {
    const response = await fetch("/api/playlists", { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    const raw = (payload as { playlists?: unknown }).playlists;
    if (!Array.isArray(raw)) return null;

    const playlists: Playlist[] = [];
    for (const entry of raw) {
      const p = entry as { id?: unknown; name?: unknown; itemCount?: unknown };
      if (typeof p.id !== "number" || typeof p.name !== "string") continue;
      playlists.push({ id: p.id, name: p.name, itemCount: typeof p.itemCount === "number" ? p.itemCount : 0 });
    }
    return playlists;
  } catch {
    return null;
  }
}

export async function fetchPlaylistItems(id: number): Promise<PlaylistItem[] | null> {
  try {
    const response = await fetch(`/api/playlists/${id}/items`, { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    const raw = (payload as { items?: unknown }).items;
    if (!Array.isArray(raw)) return null;

    const items: PlaylistItem[] = [];
    for (const entry of raw) {
      const i = entry as { videoId?: unknown; title?: unknown };
      if (typeof i.videoId !== "string") continue;
      items.push({ videoId: i.videoId, title: typeof i.title === "string" ? i.title : null });
    }
    return items;
  } catch {
    return null;
  }
}

export async function createPlaylist(name: string): Promise<PlaylistResult<{ id: number }>> {
  const response = await post("/api/playlists", { name });
  if (response === null) return { ok: false, reason: "serveur injoignable" };
  if (response.status !== 200) return { ok: false, reason: reasonOf(response.payload, "creation refusee") };
  const id = (response.payload as { id?: unknown } | null)?.id;
  return typeof id === "number" ? { ok: true, value: { id } } : { ok: false, reason: "reponse inattendue" };
}

export async function addPlaylistItem(
  playlistId: number,
  item: { videoId: string; title: string | null },
): Promise<PlaylistResult<null>> {
  const response = await post(`/api/playlists/${playlistId}/items`, item);
  if (response === null) return { ok: false, reason: "serveur injoignable" };
  if (response.status !== 200) return { ok: false, reason: reasonOf(response.payload, "ajout refuse") };
  return { ok: true, value: null };
}
