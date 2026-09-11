/*
 * Lecture de la memoire des ecoutes (U8, route GET /api/stats de U7). Meme
 * philosophie que account.ts, history.ts et playlists.ts: une reponse inattendue, un
 * serveur muet ou une session absente valent tous « rien a montrer », jamais un ecran
 * casse et jamais une exception.
 *
 * Le DTO se redeclare a la main plutot que de s importer du serveur: le client ne
 * partage avec lui que `shared/`, et une reponse venue du reseau se valide de toute
 * facon champ par champ.
 *
 * Trois champs de la reponse ne sont volontairement pas repris: `thumbnailUrl` nulle
 * part, `channelTitle` sur le top morceaux, et les `genres` d une ligne de seance.
 * L ecran n affiche pas de miniature (leur traitement visuel n est pas tranche par la
 * charte, U8), le top morceaux ne montre pas l artiste de chaque titre, et les genres
 * n existent a l ecran que comme classement (R12). Ne pas les porter jusqu ici est la
 * garantie la moins chere qu ils ne seront pas affiches par megarde.
 */

/** Compteurs cumules (R6). */
export interface Totals {
  /** Somme des durees connues. Les lignes sans duree n y entrent pas. */
  listenedMs: number;
  /** Combien de lignes portent une duree: ce sur quoi `listenedMs` porte (R9). */
  timedTrackCount: number;
  /** Toutes les ecoutes, mesurees ou non. */
  trackCount: number;
  sessionCount: number;
}

/*
 * Un classement et ce sur quoi il porte (R9). Le seuil au-dela duquel un classement a
 * le droit de s appeler « top » appartient a l ecran, pas au serveur, qui ne filtre
 * rien: c est l ecran qui compare `distinctCount` au seuil et qui affiche la
 * couverture quand elle est partielle.
 */
export interface Ranking<Entry> {
  entries: Entry[];
  /** Ecoutes reellement classees. */
  coveredPlays: number;
  /** Entrees distinctes classees, y compris celles que la limite a laissees dehors. */
  distinctCount: number;
}

export interface TopTrack {
  videoId: string;
  title: string | null;
  listenedMs: number;
  playCount: number;
}

export interface TopArtist {
  /** Le nom de la chaine YouTube tient lieu d artiste (R2). */
  channelTitle: string;
  listenedMs: number;
  playCount: number;
}

export interface TopGenre {
  genre: string;
  /** Un morceau compte dans chacun de ses genres (R12). */
  trackCount: number;
}

/** Un morceau dans une fiche de seance (R8). */
export interface SessionTrack {
  videoId: string;
  title: string | null;
  channelTitle: string | null;
  playedAt: number;
  /** `null` quand la duree n a jamais ete mesuree: ce n est pas zero. */
  listenedMs: number | null;
}

/** Une soiree d ecoute (R8). */
export interface ListeningSession {
  roomInstanceId: string;
  /** Date et heure du premier morceau. */
  startedAt: number;
  trackCount: number;
  /** Somme des durees connues de ses lignes; les autres n y ajoutent rien. */
  listenedMs: number;
  tracks: SessionTrack[];
}

export interface Stats {
  totals: Totals;
  topTracks: Ranking<TopTrack>;
  topArtists: Ranking<TopArtist>;
  topGenres: Ranking<TopGenre>;
  sessions: {
    entries: ListeningSession[];
    /** Curseur de la page suivante, null quand tout est charge. */
    nextBefore: string | null;
  };
}

function nombre(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function texte(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/*
 * La forme commune aux trois classements. Une entree qu on ne sait pas lire est
 * sautee, jamais devinee: un classement ampute reste vrai, une entree inventee non.
 */
function classement<Entry>(
  raw: unknown,
  lire: (brut: Record<string, unknown>) => Entry | null,
): Ranking<Entry> {
  const source = (raw ?? {}) as { entries?: unknown; coveredPlays?: unknown; distinctCount?: unknown };
  const entries: Entry[] = [];
  if (Array.isArray(source.entries)) {
    for (const brut of source.entries) {
      if (typeof brut !== "object" || brut === null) continue;
      const entree = lire(brut as Record<string, unknown>);
      if (entree !== null) entries.push(entree);
    }
  }
  return {
    entries,
    coveredPlays: nombre(source.coveredPlays),
    distinctCount: nombre(source.distinctCount),
  };
}

function lireSeance(brut: unknown): ListeningSession | null {
  const s = brut as {
    roomInstanceId?: unknown; startedAt?: unknown; trackCount?: unknown;
    listenedMs?: unknown; tracks?: unknown;
  } | null;
  if (typeof s?.roomInstanceId !== "string" || typeof s.startedAt !== "number") return null;

  const tracks: SessionTrack[] = [];
  if (Array.isArray(s.tracks)) {
    for (const brutPiste of s.tracks) {
      const piste = brutPiste as {
        videoId?: unknown; title?: unknown; channelTitle?: unknown;
        playedAt?: unknown; listenedMs?: unknown;
      } | null;
      if (typeof piste?.videoId !== "string" || typeof piste.playedAt !== "number") continue;
      tracks.push({
        videoId: piste.videoId,
        title: texte(piste.title),
        channelTitle: texte(piste.channelTitle),
        playedAt: piste.playedAt,
        // `null` n est pas zero: une ligne jamais mesuree ne doit pas se lire
        // « ecoutee zero seconde » (R9).
        listenedMs: typeof piste.listenedMs === "number" ? piste.listenedMs : null,
      });
    }
  }

  return {
    roomInstanceId: s.roomInstanceId,
    startedAt: s.startedAt,
    // A defaut du compte du serveur, celui des lignes qu on a su lire: jamais un
    // nombre plus grand que ce que la fiche affiche.
    trackCount: typeof s.trackCount === "number" ? s.trackCount : tracks.length,
    listenedMs: nombre(s.listenedMs),
    tracks,
  };
}

export async function fetchStats(before?: string): Promise<Stats | null> {
  const url = before === undefined
    ? "/api/stats"
    : `/api/stats?before=${encodeURIComponent(before)}`;
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    // 401 pour un invite, comme partout ailleurs: rien a montrer, pas une erreur.
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null) return null;

    const body = payload as {
      totals?: unknown; topTracks?: unknown; topArtists?: unknown;
      topGenres?: unknown; sessions?: unknown;
    };
    // Les compteurs sont le socle de l ecran: sans eux il n y a rien a rendre
    // d honnete, et mieux vaut rester en attente qu afficher des zeros inventes.
    if (typeof body.totals !== "object" || body.totals === null) return null;
    const totals = body.totals as Record<string, unknown>;

    const sessions = (body.sessions ?? {}) as { entries?: unknown; nextBefore?: unknown };
    const seances: ListeningSession[] = [];
    if (Array.isArray(sessions.entries)) {
      for (const brut of sessions.entries) {
        const seance = lireSeance(brut);
        if (seance !== null) seances.push(seance);
      }
    }

    return {
      totals: {
        listenedMs: nombre(totals["listenedMs"]),
        timedTrackCount: nombre(totals["timedTrackCount"]),
        trackCount: nombre(totals["trackCount"]),
        sessionCount: nombre(totals["sessionCount"]),
      },
      topTracks: classement<TopTrack>(body.topTracks, (e) => (
        typeof e["videoId"] !== "string" ? null : {
          videoId: e["videoId"],
          title: texte(e["title"]),
          listenedMs: nombre(e["listenedMs"]),
          playCount: nombre(e["playCount"]),
        }
      )),
      topArtists: classement<TopArtist>(body.topArtists, (e) => (
        typeof e["channelTitle"] !== "string" ? null : {
          channelTitle: e["channelTitle"],
          listenedMs: nombre(e["listenedMs"]),
          playCount: nombre(e["playCount"]),
        }
      )),
      topGenres: classement<TopGenre>(body.topGenres, (e) => (
        typeof e["genre"] !== "string" ? null : {
          genre: e["genre"],
          trackCount: nombre(e["trackCount"]),
        }
      )),
      sessions: {
        entries: seances,
        nextBefore: typeof sessions.nextBefore === "string" ? sessions.nextBefore : null,
      },
    };
  } catch {
    return null;
  }
}

/*
 * Une page de seances de plus (U8, R8). Seules les seances s accumulent: les
 * compteurs et les classements de la premiere page sont conserves tels quels, plutot
 * que remplaces par ceux de la seconde. Ils portent sur tout l historique et ne
 * changent donc pas d une page a l autre — sauf si une ecoute s enregistre entre les
 * deux appels, et l ecran se mettrait alors a bouger sous les yeux en cliquant sur
 * « Voir plus ».
 */
export function ajouterPage(precedent: Stats, suivant: Stats): Stats {
  return {
    ...precedent,
    sessions: {
      entries: [...precedent.sessions.entries, ...suivant.sessions.entries],
      nextBefore: suivant.sessions.nextBefore,
    },
  };
}
