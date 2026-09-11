/*
 * Persistance: comptes, sessions, historique, playlists (KTD3).
 *
 * SQLite par node:sqlite plutot qu un ORM ou une dependance native. Le serveur est
 * mono-processus, donc une API synchrone suffit et evite de teinter tout le code
 * d asynchrone pour des lectures qui prennent une microseconde.
 *
 * Les rooms ne passent jamais par ici (KD3): elles restent ephemeres, en memoire.
 * Ce module ne connait que ce qui doit survivre a un redemarrage.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

/*
 * Migrations: un tableau ordonne, l index+1 est le numero de version. On applique ce
 * qui manque en comparant a PRAGMA user_version, chaque script dans sa transaction.
 * Pas d outil externe a installer, et une base neuve comme une base en place suivent
 * exactement le meme chemin. Une migration livree ne se modifie plus: on en ajoute une.
 *
 * Exporte pour les tests, qui construisent une base d une version anterieure a partir
 * de la migration livree plutot que d en recopier le schema, qui deriverait.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE users (
    id              INTEGER PRIMARY KEY,
    google_sub      TEXT    NOT NULL UNIQUE,
    name            TEXT    NOT NULL,
    email           TEXT,
    -- Le nom vient de Google et se rafraichit a chaque connexion, sauf si l utilisateur
    -- l a change lui-meme (KD5, KTD7): ce drapeau protege son choix du rafraichissement.
    name_set_by_user INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    id              TEXT    PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    hard_expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_by_user ON sessions(user_id);

  CREATE TABLE history_entries (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id      TEXT    NOT NULL,
    title         TEXT,
    played_at     INTEGER NOT NULL,
    -- instance de room + itemId (KTD6). Jamais le code a 4 lettres, qui se reattribue
    -- apres sweep: deux ecoutes sans rapport se ressembleraient et l une serait perdue.
    room_item_key TEXT    NOT NULL,
    UNIQUE(user_id, room_item_key)
  );
  CREATE INDEX history_recent ON history_entries(user_id, played_at DESC, id DESC);

  CREATE TABLE playlists (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX playlists_by_user ON playlists(user_id, created_at DESC);

  CREATE TABLE playlist_items (
    id          INTEGER PRIMARY KEY,
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    video_id    TEXT    NOT NULL,
    title       TEXT,
    position    INTEGER NOT NULL,
    added_at    INTEGER NOT NULL
  );
  CREATE INDEX playlist_items_by_playlist ON playlist_items(playlist_id, position);
  `,

  /*
   * Memoire des ecoutes (U2). Cinq colonnes nullables, jamais NOT NULL: un morceau
   * dont l artiste, la miniature ou le genre n a pas pu etre recupere reste enregistre
   * sans eux (R4), et les lignes deja en base n auront jamais de duree, celle-ci n
   * etant reconstructible depuis rien.
   */
  `
  -- Temps reellement joue dans la room, pauses exclues (R1). NULL tant qu aucune fin
  -- de morceau n a ete mesuree: l ecran doit pouvoir distinguer « pas mesure » de zero.
  ALTER TABLE history_entries ADD COLUMN listened_ms     INTEGER;
  -- Le nom de la chaine YouTube tient lieu d artiste (R2), l adresse de miniature se
  -- stocke bien qu elle se deduise de l identifiant (KTD7): une forme d URL peut
  -- changer chez YouTube, et les lignes anciennes se retrouveraient sans image.
  ALTER TABLE history_entries ADD COLUMN channel_title   TEXT;
  ALTER TABLE history_entries ADD COLUMN thumbnail_url   TEXT;
  -- Tableau JSON de chaines (KTD12): NULL signifie « jamais interrogee », un tableau
  -- vide « interrogee, aucun genre ». Sans cette distinction, une video sans genre
  -- serait redemandee a YouTube a chaque ouverture de l ecran.
  ALTER TABLE history_entries ADD COLUMN genres          TEXT;
  -- L instance de room, soit le prefixe de room_item_key (KTD4). Une colonne plutot
  -- qu un decoupage de chaine a chaque lecture: le regroupement par seance devient
  -- indexable, et le format de la cle cesse d etre recopie dans chaque requete.
  ALTER TABLE history_entries ADD COLUMN room_instance_id TEXT;

  -- Les lignes deja en base deviennent groupables par seance sans code de compatibilite
  -- (KTD4). Une cle sans separateur, ou dont le prefixe serait vide, ne porte aucune
  -- instance: elle reste a NULL plutot que d en inventer une.
  UPDATE history_entries
  SET room_instance_id = substr(room_item_key, 1, instr(room_item_key, '#') - 1)
  WHERE instr(room_item_key, '#') > 1;

  CREATE INDEX history_by_session ON history_entries(user_id, room_instance_id, played_at);
  `,
];

/*
 * Plafonds de ce qui s accumule en base (KTD9). Les routes valideront aussi en amont
 * pour rendre un message clair, mais la borne vit ici: c est le seul endroit que tout
 * chemin d ecriture traverse.
 */
export const LIMITS = {
  playlistNameChars: 100,
  titleChars: 200,
  itemsPerPlaylist: 500,
  playlistsPerUser: 50,
} as const;

/*
 * Duree de session (KTD4): glissante a 60 jours, mais jamais au-dela de 180 jours
 * depuis la connexion. Le plafond dur borne ce qu une session volee reste utilisable.
 */
const SESSION_SLIDING_MS = 60 * 24 * 60 * 60 * 1000;
const SESSION_MAX_MS = 180 * 24 * 60 * 60 * 1000;

export interface User {
  id: number;
  googleSub: string;
  name: string;
  email: string | null;
}

export interface HistoryEntry {
  id: number;
  videoId: string;
  title: string | null;
  playedAt: number;
  /** Temps joue dans la room, pauses exclues (R1). null quand rien n a ete mesure. */
  listenedMs: number | null;
  /** Le nom de la chaine YouTube tient lieu d artiste (R2). */
  channelTitle: string | null;
  thumbnailUrl: string | null;
  /** null = jamais interrogee, [] = interrogee sans resultat (KTD12). */
  genres: string[] | null;
  /** La seance a laquelle l ecoute appartient (KTD4). */
  roomInstanceId: string | null;
}

/** Curseur de pagination: la derniere entree affichee (KTD8, route GET /api/history). */
export interface HistoryCursor {
  playedAt: number;
  id: number;
}

/** Compteurs cumules de l ecran de statistiques (U7, R6). */
export interface ListeningTotals {
  /** Somme des durees connues. Les lignes sans duree n y entrent pas (R9). */
  listenedMs: number;
  /*
   * Combien de lignes portent une duree. C est ce qui permet a l ecran de dire sur
   * quoi son total porte plutot que de le presenter comme celui de tout l historique
   * (R9): une base ou rien n est mesure doit pouvoir se taire au lieu d afficher zero.
   */
  timedTrackCount: number;
  /** Toutes les ecoutes, mesurees ou non: une meme video ajoutee deux fois compte deux. */
  trackCount: number;
  sessionCount: number;
}

/*
 * Un classement et ce sur quoi il porte (U7, R9). Les deux nombres accompagnent
 * toujours les entrees: le seuil au-dela duquel un classement a le droit de s appeler
 * « top » appartient a l ecran, qui ne peut trancher que s il sait sur combien
 * d ecoutes et sur combien d entrees distinctes le classement repose.
 */
export interface Ranking<Entry> {
  /** Les meilleures entrees, bornees par la limite demandee. */
  entries: Entry[];
  /** Ecoutes reellement classees: ni les lignes sans duree ni celles sans etiquette. */
  coveredPlays: number;
  /** Entrees distinctes classees, y compris celles que la limite a laissees dehors. */
  distinctCount: number;
}

export interface TopTrack {
  videoId: string;
  /** Les plus recents non nuls parmi les lignes de cette video (Assumption U7). */
  title: string | null;
  channelTitle: string | null;
  thumbnailUrl: string | null;
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
  /** Nombre d ecoutes portant ce genre. Un morceau compte dans chacun des siens (R12). */
  trackCount: number;
}

/** Une soiree d ecoute, groupee par instance de room (R8, KTD4). */
export interface ListeningSession {
  roomInstanceId: string;
  /** Date et heure du premier morceau (Assumption U7). */
  startedAt: number;
  trackCount: number;
  /** Somme des durees connues de ses lignes; les autres n y ajoutent rien. */
  listenedMs: number;
  /** Ses morceaux, dans l ordre ou ils ont ete joues (R8). */
  tracks: HistoryEntry[];
}

/*
 * Curseur de pagination des seances (U7, KTD8): il porte sur la seance, jamais sur la
 * ligne. Un curseur de ligne couperait une seance entre deux pages, et son nombre de
 * morceaux comme sa duree seraient faux des deux cotes.
 */
export interface SessionCursor {
  startedAt: number;
  roomInstanceId: string;
}

export interface Playlist {
  id: number;
  name: string;
  createdAt: number;
  itemCount: number;
}

export interface PlaylistItem {
  videoId: string;
  title: string | null;
  position: number;
}

export type DbErrorCode =
  | "playlist_not_found"
  | "playlist_name_invalid"
  | "too_many_playlists"
  | "playlist_full";

type Failure = { ok: false; code: DbErrorCode; message: string };

function fail(code: DbErrorCode, message: string): Failure {
  return { ok: false, code, message };
}

/*
 * L identifiant de session circule en clair dans le cookie, jamais en base: on n y
 * garde que son SHA-256 (KTD4). Une fuite du fichier .db ou d une sauvegarde ne livre
 * alors aucune session utilisable. Pas de sel ni de KDF: la valeur est deja 128 bits
 * tires au hasard, il n y a rien a deviner par force brute.
 */
function fingerprint(rawId: string): string {
  return createHash("sha256").update(rawId).digest("hex");
}

/*
 * Titre, nom de chaine et adresse de miniature viennent tous de YouTube, jamais d une
 * saisie: on tronque au lieu de refuser. Un seul plafond pour les trois, aucun n ayant
 * de longueur legitime au-dela.
 */
function clampText(text: string | null): string | null {
  if (text === null) return null;
  return text.length > LIMITS.titleChars ? text.slice(0, LIMITS.titleChars) : text;
}

/*
 * La colonne des genres porte un tableau JSON de chaines (KTD12). Une valeur illisible
 * se relit comme « jamais interrogee », ce qui la fait redemander plus tard: un ecran
 * de statistiques ne doit pas tomber sur une seule ligne abimee.
 */
function parseGenres(raw: unknown): string[] | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((genre): genre is string => typeof genre === "string");
  } catch {
    return null;
  }
}

/*
 * `LIMIT` recoit une valeur de la route, pas de la base: on la ramene a un entier
 * positif plutot que de la lier telle quelle.
 */
function boundLimit(limit: number): number {
  return Math.max(0, Math.trunc(limit));
}

/*
 * Ce sur quoi un classement porte (U7, R9). Les deux nombres se lisent de la meme
 * facon pour les trois classements, d ou un seul mappage: c est ce couple, pas le
 * seuil qui en decoule, qui appartient a la base.
 */
function toCoverage(row: Record<string, unknown> | undefined): {
  coveredPlays: number;
  distinctCount: number;
} {
  return {
    coveredPlays: Number(row?.["covered_plays"] ?? 0),
    distinctCount: Number(row?.["distinct_count"] ?? 0),
  };
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get();
  const current = Number(row?.["user_version"] ?? 0);

  for (const [index, sql] of MIGRATIONS.entries()) {
    if (index < current) continue;
    db.exec("BEGIN");
    try {
      db.exec(sql);
      // user_version est un pragma: il n accepte pas de parametre lie. La valeur vient
      // d un index de tableau, jamais d une entree exterieure.
      db.exec(`PRAGMA user_version = ${index + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

/*
 * Chemin du fichier de base. Le handler statique confine deja ce qu il sert, mais une
 * base posee sous dist/ serait telechargeable par n importe qui: ceinture en plus.
 */
export function resolveDbPath(raw: string | undefined, distDir: string): string {
  const path = resolve(raw ?? "data/syncmusic.db");
  const dist = resolve(distDir);
  if (path === dist || path.startsWith(dist + sep)) {
    throw new Error(`DB_PATH ne doit pas pointer sous le dossier servi (${dist}): ${path}`);
  }
  return path;
}

export function openDatabase(path: string) {
  // ":memory:" en test: pas de dossier a creer, et rien ne survit a la suite.
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  /*
   * WAL: un lecteur ne bloque plus l ecrivain. Sans interet a deux utilisateurs, mais
   * c est aussi ce qui evite qu une lecture longue fasse echouer une ecriture. Sans
   * effet sur une base en memoire, qui l ignore silencieusement.
   */
  db.exec("PRAGMA journal_mode = WAL");
  migrate(db);

  const statements = {
    upsertUser: db.prepare(`
      INSERT INTO users (google_sub, name, email, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(google_sub) DO UPDATE SET
        email = excluded.email,
        name = CASE WHEN name_set_by_user = 1 THEN users.name ELSE excluded.name END
      RETURNING id, google_sub, name, email
    `),
    setUserName: db.prepare(
      "UPDATE users SET name = ?, name_set_by_user = 1 WHERE id = ?",
    ),
    createSession: db.prepare(
      "INSERT INTO sessions (id, user_id, created_at, expires_at, hard_expires_at) VALUES (?, ?, ?, ?, ?)",
    ),
    findSession: db.prepare(`
      SELECT u.id, u.google_sub, u.name, u.email
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ? AND s.hard_expires_at > ?
    `),
    renewSession: db.prepare(
      "UPDATE sessions SET expires_at = MIN(?, hard_expires_at) WHERE id = ? AND expires_at > ?",
    ),
    deleteSession: db.prepare("DELETE FROM sessions WHERE id = ?"),
    deleteExpiredSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ? OR hard_expires_at <= ?"),
    recordListen: db.prepare(`
      INSERT OR IGNORE INTO history_entries
        (user_id, video_id, title, channel_title, thumbnail_url, played_at, room_item_key, room_instance_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    /*
     * Accumulation de la duree (U4, KTD3). Chemin distinct de `recordListen`: celui-la
     * cree la ligne et garde son premier horodatage, celui-ci ajoute a ce qui y est
     * deja. Un `SET listened_ms = ?` ecraserait une duree juste par celle de la
     * seconde ecoute quand un morceau redevient courant dans la meme seance (AE7).
     *
     * `COALESCE` sur les trois textes: on complete ce que la ligne porte a vide quand
     * oEmbed a repondu apres le depart commun, sans jamais ecraser une valeur presente.
     *
     * La cle de morceau seule, sans compte (U4): a la destruction d une room plus
     * aucune session n existe, et les lignes n existent deja que pour des comptes
     * connectes, le depart commun appliquant la garde. Pas d index sur cette colonne
     * seule: quelques milliers de lignes, une ecriture par fin de morceau.
     */
    addListenedMs: db.prepare(`
      UPDATE history_entries
      SET listened_ms   = COALESCE(listened_ms, 0) + ?,
          title         = COALESCE(title, ?),
          channel_title = COALESCE(channel_title, ?),
          thumbnail_url = COALESCE(thumbnail_url, ?)
      WHERE room_item_key = ?
    `),
    historyPage: db.prepare(`
      SELECT id, video_id, title, played_at, listened_ms, channel_title, thumbnail_url,
             genres, room_instance_id
      FROM history_entries
      WHERE user_id = ? ORDER BY played_at DESC, id DESC LIMIT ?
    `),
    historyPageAfter: db.prepare(`
      SELECT id, video_id, title, played_at, listened_ms, channel_title, thumbnail_url,
             genres, room_instance_id
      FROM history_entries
      WHERE user_id = ? AND (played_at < ? OR (played_at = ? AND id < ?))
      ORDER BY played_at DESC, id DESC LIMIT ?
    `),
    /*
     * Videos dont les genres n ont jamais ete demandes (U6, KTD12). Groupees par
     * identifiant de video, pas listees par ligne: le genre est une propriete de la
     * video, donc deux ecoutes du meme morceau se remplissent d un seul appel, et un
     * appel couvre cinquante videos distinctes plutot que cinquante ecoutes.
     *
     * Les plus recemment jouees d abord: le remplissage est borne par passage, et une
     * soiree d hier merite ses genres avant les archives.
     */
    videoIdsWithoutGenres: db.prepare(`
      SELECT video_id FROM history_entries
      WHERE genres IS NULL
      GROUP BY video_id
      ORDER BY MAX(played_at) DESC
      LIMIT ?
    `),
    setVideoGenres: db.prepare("UPDATE history_entries SET genres = ? WHERE video_id = ?"),

    /*
     * Lectures agregees de l ecran de statistiques (U7). Toutes portent `user_id = ?`:
     * c est la seule garde de vie privee de cet ecran, aucune de ces colonnes n etant
     * protegee ailleurs.
     *
     * `COUNT(listened_ms)` ignore les NULL, la ou `COUNT(*)` les compte: la difference
     * entre les deux est exactement ce que R9 demande de savoir. `COUNT(DISTINCT
     * room_instance_id)` ignore de meme les lignes d avant la migration 2 restees sans
     * instance, qui ne forment aucune seance.
     */
    listeningTotals: db.prepare(`
      SELECT COUNT(*)                     AS track_count,
             COUNT(listened_ms)           AS timed_track_count,
             COALESCE(SUM(listened_ms), 0) AS total_ms,
             COUNT(DISTINCT room_instance_id) AS session_count
      FROM history_entries
      WHERE user_id = ?
    `),

    /*
     * Classement des morceaux par temps cumule (R7, KTD10). Une ligne sans duree en
     * est exclue: la garder la ferait peser zero seconde tout en gonflant la couverture
     * que le classement annonce.
     *
     * Titre, chaine et miniature viennent de sous-requetes plutot que d un `MAX`: on
     * veut la valeur la plus recente *non nulle*, une ligne ecrite avant la reponse
     * oEmbed pouvant etre la plus recente tout en n en portant aucune (Assumption U7).
     * Elles rescopent `user_id`, sans quoi le titre d un autre compte remonterait ici.
     *
     * `MAX(h.id) DESC` departe une egalite de temps: le meme ordre que l index
     * d historique, et surtout le meme d un appel a l autre.
     */
    topTracks: db.prepare(`
      SELECT h.video_id,
             SUM(h.listened_ms) AS total_ms,
             COUNT(*)           AS play_count,
             (SELECT t.title FROM history_entries t
               WHERE t.user_id = ? AND t.video_id = h.video_id AND t.title IS NOT NULL
               ORDER BY t.played_at DESC, t.id DESC LIMIT 1) AS title,
             (SELECT t.channel_title FROM history_entries t
               WHERE t.user_id = ? AND t.video_id = h.video_id AND t.channel_title IS NOT NULL
               ORDER BY t.played_at DESC, t.id DESC LIMIT 1) AS channel_title,
             (SELECT t.thumbnail_url FROM history_entries t
               WHERE t.user_id = ? AND t.video_id = h.video_id AND t.thumbnail_url IS NOT NULL
               ORDER BY t.played_at DESC, t.id DESC LIMIT 1) AS thumbnail_url
      FROM history_entries h
      WHERE h.user_id = ? AND h.listened_ms IS NOT NULL
      GROUP BY h.video_id
      ORDER BY total_ms DESC, MAX(h.id) DESC
      LIMIT ?
    `),
    topTracksCoverage: db.prepare(`
      SELECT COUNT(*) AS covered_plays, COUNT(DISTINCT video_id) AS distinct_count
      FROM history_entries
      WHERE user_id = ? AND listened_ms IS NOT NULL
    `),

    /* Meme regle qu au-dessus, plus l exclusion des lignes sans artiste (AE9). */
    topArtists: db.prepare(`
      SELECT channel_title,
             SUM(listened_ms) AS total_ms,
             COUNT(*)         AS play_count
      FROM history_entries
      WHERE user_id = ? AND listened_ms IS NOT NULL AND channel_title IS NOT NULL
      GROUP BY channel_title
      ORDER BY total_ms DESC, MAX(id) DESC
      LIMIT ?
    `),
    topArtistsCoverage: db.prepare(`
      SELECT COUNT(*) AS covered_plays, COUNT(DISTINCT channel_title) AS distinct_count
      FROM history_entries
      WHERE user_id = ? AND listened_ms IS NOT NULL AND channel_title IS NOT NULL
    `),

    /*
     * Classement des genres (R12, KTD10, KTD12). Il compte des morceaux, pas du temps:
     * une ligne sans duree y compte donc pleinement, contrairement aux deux classements
     * au-dessus. Un morceau porte plusieurs genres et compte dans chacun, d ou le
     * parcours du tableau JSON par `json_each`.
     *
     * Le filtrage passe par une sous-requete, pas par le WHERE exterieur: `json_each`
     * recoit sa valeur avant que le WHERE ne s applique, et une seule colonne abimee
     * ferait alors echouer la requete entiere par « malformed JSON ». `json_valid` la
     * laisse dehors, comme `parseGenres` la relit en « jamais interrogee ».
     *
     * Une etiquette n a pas d identifiant a departager: l ordre alphabetique en tient
     * lieu (KTD10). Collation binaire, donc totale et stable, la ou NOCASE laisserait
     * deux etiquettes qui ne different que par la casse a egalite.
     */
    topGenres: db.prepare(`
      SELECT g.value AS genre, COUNT(*) AS track_count
      FROM (SELECT genres FROM history_entries
            WHERE user_id = ? AND genres IS NOT NULL AND json_valid(genres)) v,
           json_each(v.genres) g
      GROUP BY g.value
      ORDER BY track_count DESC, genre ASC
      LIMIT ?
    `),
    topGenresCoverage: db.prepare(`
      SELECT COUNT(DISTINCT v.id) AS covered_plays, COUNT(DISTINCT g.value) AS distinct_count
      FROM (SELECT id, genres FROM history_entries
            WHERE user_id = ? AND genres IS NOT NULL AND json_valid(genres)) v,
           json_each(v.genres) g
    `),

    /*
     * Seances, de la plus recente a la plus ancienne (R8). Le regroupement est la
     * colonne d instance (KTD4), l heure de debut le premier morceau: c est elle qui
     * separe deux soirees du meme jour et qui garde sa date a une soiree passant
     * minuit. Une ligne sans instance n a aucune identite de seance et reste dehors.
     *
     * L instance departe deux seances de meme debut, pour que le curseur ait toujours
     * un ordre total a suivre.
     */
    sessionsPage: db.prepare(`
      SELECT room_instance_id,
             MIN(played_at)   AS started_at,
             COUNT(*)         AS track_count,
             COALESCE(SUM(listened_ms), 0) AS total_ms
      FROM history_entries
      WHERE user_id = ? AND room_instance_id IS NOT NULL
      GROUP BY room_instance_id
      ORDER BY started_at DESC, room_instance_id DESC
      LIMIT ?
    `),
    sessionsPageAfter: db.prepare(`
      SELECT room_instance_id,
             MIN(played_at)   AS started_at,
             COUNT(*)         AS track_count,
             COALESCE(SUM(listened_ms), 0) AS total_ms
      FROM history_entries
      WHERE user_id = ? AND room_instance_id IS NOT NULL
      GROUP BY room_instance_id
      HAVING MIN(played_at) < ?
          OR (MIN(played_at) = ? AND room_instance_id < ?)
      ORDER BY started_at DESC, room_instance_id DESC
      LIMIT ?
    `),
    /* Les morceaux d une seance, dans l ordre ou ils ont ete joues (R8). */
    sessionTracks: db.prepare(`
      SELECT id, video_id, title, played_at, listened_ms, channel_title, thumbnail_url,
             genres, room_instance_id
      FROM history_entries
      WHERE user_id = ? AND room_instance_id = ?
      ORDER BY played_at ASC, id ASC
    `),

    countPlaylists: db.prepare("SELECT COUNT(*) AS n FROM playlists WHERE user_id = ?"),
    createPlaylist: db.prepare(
      "INSERT INTO playlists (user_id, name, created_at) VALUES (?, ?, ?) RETURNING id",
    ),
    listPlaylists: db.prepare(`
      SELECT p.id, p.name, p.created_at, COUNT(i.id) AS item_count
      FROM playlists p LEFT JOIN playlist_items i ON i.playlist_id = p.id
      WHERE p.user_id = ? GROUP BY p.id ORDER BY p.created_at DESC, p.id DESC
    `),
    ownedPlaylist: db.prepare("SELECT id FROM playlists WHERE id = ? AND user_id = ?"),
    playlistItems: db.prepare(`
      SELECT video_id, title, position FROM playlist_items
      WHERE playlist_id = ? ORDER BY position
    `),
    nextPosition: db.prepare(
      "SELECT COALESCE(MAX(position), -1) + 1 AS next, COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?",
    ),
    addPlaylistItem: db.prepare(`
      INSERT INTO playlist_items (playlist_id, video_id, title, position, added_at)
      VALUES (?, ?, ?, ?, ?)
    `),
  };

  function toUser(row: Record<string, unknown>): User {
    return {
      id: Number(row["id"]),
      googleSub: String(row["google_sub"]),
      name: String(row["name"]),
      email: row["email"] === null ? null : String(row["email"]),
    };
  }

  function toHistoryEntry(row: Record<string, unknown>): HistoryEntry {
    return {
      id: Number(row["id"]),
      videoId: String(row["video_id"]),
      title: row["title"] === null ? null : String(row["title"]),
      playedAt: Number(row["played_at"]),
      listenedMs: row["listened_ms"] === null ? null : Number(row["listened_ms"]),
      channelTitle: row["channel_title"] === null ? null : String(row["channel_title"]),
      thumbnailUrl: row["thumbnail_url"] === null ? null : String(row["thumbnail_url"]),
      genres: parseGenres(row["genres"]),
      roomInstanceId: row["room_instance_id"] === null ? null : String(row["room_instance_id"]),
    };
  }

  return {
    /** Exposee pour les tests et un eventuel arret propre; le serveur ne ferme jamais. */
    close(): void {
      db.close();
    },

    /*
     * Le compte est cle sur le `sub` de Google (KTD7): l email peut changer, `sub` non.
     * Nom et email sont rafraichis a chaque connexion, sauf le nom que l utilisateur a
     * choisi lui-meme.
     */
    upsertUser(profile: { googleSub: string; name: string; email: string | null }, nowMs: number): User {
      const row = statements.upsertUser.get(
        profile.googleSub, profile.name, profile.email, nowMs,
      );
      if (!row) throw new Error("upsert utilisateur sans resultat");
      return toUser(row);
    },

    setUserName(userId: number, name: string): void {
      statements.setUserName.run(name, userId);
    },

    /** `rawId` est l identifiant remis au navigateur; la base n en garde que l empreinte. */
    createSession(rawId: string, userId: number, nowMs: number): void {
      statements.createSession.run(
        fingerprint(rawId), userId, nowMs, nowMs + SESSION_SLIDING_MS, nowMs + SESSION_MAX_MS,
      );
    },

    /** Le compte derriere un cookie, ou null: cookie absent, faux ou expire = invite (KTD5). */
    findSession(rawId: string, nowMs: number): User | null {
      const row = statements.findSession.get(fingerprint(rawId), nowMs, nowMs);
      return row ? toUser(row) : null;
    },

    /** Fenetre glissante: repousse l expiration sans jamais depasser le plafond dur. */
    renewSession(rawId: string, nowMs: number): void {
      statements.renewSession.run(nowMs + SESSION_SLIDING_MS, fingerprint(rawId), nowMs);
    },

    /** Deconnexion: la session ne vaut plus rien immediatement (KTD4). */
    deleteSession(rawId: string): void {
      statements.deleteSession.run(fingerprint(rawId));
    },

    deleteExpiredSessions(nowMs: number): number {
      return Number(statements.deleteExpiredSessions.run(nowMs, nowMs).changes);
    },

    /*
     * Une ecoute par compte et par morceau de la queue (R5). La deduplication est la
     * contrainte UNIQUE, pas du code appelant: les departs communs se repetent (pause,
     * pub, stall) et l ecriture doit pouvoir etre tentee a chaque fois sans y penser.
     * Rend true si l entree est nouvelle.
     */
    recordListen(
      entry: {
        userId: number;
        videoId: string;
        title: string | null;
        roomItemKey: string;
        /*
         * La seance a laquelle l ecoute appartient (KTD4). Fournie par l appelant, qui
         * construit la cle et a donc l instance en main: redecouper `<instance>#<item>`
         * ici ferait connaitre ce format a deux modules, exactement ce que KTD4 evite.
         * Le decoupage ne survit que dans la migration 2, pour les lignes anciennes.
         */
        roomInstanceId: string;
        /*
         * Optionnels: oEmbed repond en fire-and-forget et peut arriver apres le depart
         * commun. Le morceau s enregistre quand meme, sans artiste ni miniature (R4).
         */
        channelTitle?: string | null;
        thumbnailUrl?: string | null;
      },
      nowMs: number,
    ): boolean {
      const result = statements.recordListen.run(
        entry.userId,
        entry.videoId,
        clampText(entry.title),
        clampText(entry.channelTitle ?? null),
        clampText(entry.thumbnailUrl ?? null),
        nowMs,
        entry.roomItemKey,
        entry.roomInstanceId,
      );
      return Number(result.changes) > 0;
    },

    /*
     * Ajoute le temps joue a toutes les lignes de ce morceau, celle de chaque compte
     * present (U4, R1). Aucun compte en entree: l appelant peut etre la destruction
     * d une room, ou plus aucune session n existe.
     *
     * La duree ne decroit jamais (R1): une valeur negative n enleve rien. Rend le
     * nombre de lignes touchees, zero quand aucun compte connecte n ecoutait.
     */
    addListenedMs(entry: {
      roomItemKey: string;
      listenedMs: number;
      /*
       * Rattrapage d une reponse oEmbed arrivee apres le depart commun: ces trois
       * champs ne remplissent que ce que la ligne porte a vide. Gratuit, la ligne
       * etant deja en ecriture.
       */
      title?: string | null;
      channelTitle?: string | null;
      thumbnailUrl?: string | null;
    }): number {
      const result = statements.addListenedMs.run(
        Math.max(0, Math.round(entry.listenedMs)),
        clampText(entry.title ?? null),
        clampText(entry.channelTitle ?? null),
        clampText(entry.thumbnailUrl ?? null),
        entry.roomItemKey,
      );
      return Number(result.changes);
    },

    /** Du plus recent au plus ancien. `after` continue la page precedente (R6). */
    listHistory(userId: number, limit: number, after?: HistoryCursor): HistoryEntry[] {
      const rows = after
        ? statements.historyPageAfter.all(userId, after.playedAt, after.playedAt, after.id, limit)
        : statements.historyPage.all(userId, limit);
      return rows.map(toHistoryEntry);
    },

    /*
     * Les videos a interroger, les plus recemment jouees d abord (U6). Aucun compte en
     * entree: le genre ne depend pas de qui a ecoute, et un seul appel remplit la
     * ligne des deux participants.
     */
    listVideoIdsWithoutGenres(limit: number): string[] {
      return statements.videoIdsWithoutGenres
        .all(boundLimit(limit))
        .map((row) => String(row["video_id"]));
    },

    /*
     * Ecrit les genres sur toutes les lignes de cette video (U6, R11), toutes seances
     * et tous comptes confondus. Rend le nombre de lignes touchees.
     *
     * Un tableau vide est une valeur pleine, « interrogee, aucun genre » (KTD12): sans
     * lui, une video sans genre serait redemandee a chaque ouverture de l ecran. C est
     * aussi pourquoi l ecriture n est pas conditionnee a `genres IS NULL`: elle est le
     * seul chemin qui ecrit cette colonne, et rejouer un lot doit rester sans effet
     * de bord.
     */
    setVideoGenres(videoId: string, genres: readonly string[]): number {
      const result = statements.setVideoGenres.run(JSON.stringify(genres), videoId);
      return Number(result.changes);
    },

    /** Compteurs cumules du compte (U7, R6). Zero partout quand rien n a ete ecoute. */
    readListeningTotals(userId: number): ListeningTotals {
      const row = statements.listeningTotals.get(userId);
      return {
        listenedMs: Number(row?.["total_ms"] ?? 0),
        timedTrackCount: Number(row?.["timed_track_count"] ?? 0),
        trackCount: Number(row?.["track_count"] ?? 0),
        sessionCount: Number(row?.["session_count"] ?? 0),
      };
    },

    /*
     * Les morceaux les plus ecoutes, par temps cumule (U7, R7). `limit` borne les
     * entrees rendues, jamais les nombres qui les accompagnent: l ecran doit savoir
     * combien d entrees existent, pas seulement combien il en recoit (R9).
     */
    listTopTracks(userId: number, limit: number): Ranking<TopTrack> {
      const rows = statements.topTracks.all(
        userId, userId, userId, userId, boundLimit(limit),
      );
      return {
        entries: rows.map((row) => ({
          videoId: String(row["video_id"]),
          title: row["title"] === null ? null : String(row["title"]),
          channelTitle: row["channel_title"] === null ? null : String(row["channel_title"]),
          thumbnailUrl: row["thumbnail_url"] === null ? null : String(row["thumbnail_url"]),
          listenedMs: Number(row["total_ms"]),
          playCount: Number(row["play_count"]),
        })),
        ...toCoverage(statements.topTracksCoverage.get(userId)),
      };
    },

    /** Les artistes les plus ecoutes, par temps cumule (U7, R7, AE9). */
    listTopArtists(userId: number, limit: number): Ranking<TopArtist> {
      const rows = statements.topArtists.all(userId, boundLimit(limit));
      return {
        entries: rows.map((row) => ({
          channelTitle: String(row["channel_title"]),
          listenedMs: Number(row["total_ms"]),
          playCount: Number(row["play_count"]),
        })),
        ...toCoverage(statements.topArtistsCoverage.get(userId)),
      };
    },

    /*
     * Les genres les plus ecoutes (U7, R12). Compte des morceaux, pas du temps: un
     * morceau porte plusieurs genres et compte dans chacun, ce que l ecran doit dire.
     */
    listTopGenres(userId: number, limit: number): Ranking<TopGenre> {
      const rows = statements.topGenres.all(userId, boundLimit(limit));
      return {
        entries: rows.map((row) => ({
          genre: String(row["genre"]),
          trackCount: Number(row["track_count"]),
        })),
        ...toCoverage(statements.topGenresCoverage.get(userId)),
      };
    },

    /*
     * Les seances, de la plus recente a la plus ancienne (U7, R8). `after` continue la
     * page precedente par un curseur de seance: une seance sort donc toujours entiere,
     * avec tous ses morceaux (KTD8).
     */
    listSessions(userId: number, limit: number, after?: SessionCursor): ListeningSession[] {
      const rows = after
        ? statements.sessionsPageAfter.all(
            userId, after.startedAt, after.startedAt, after.roomInstanceId, boundLimit(limit),
          )
        : statements.sessionsPage.all(userId, boundLimit(limit));
      return rows.map((row) => {
        const roomInstanceId = String(row["room_instance_id"]);
        return {
          roomInstanceId,
          startedAt: Number(row["started_at"]),
          trackCount: Number(row["track_count"]),
          listenedMs: Number(row["total_ms"]),
          tracks: statements.sessionTracks.all(userId, roomInstanceId).map(toHistoryEntry),
        };
      });
    },

    createPlaylist(userId: number, name: string, nowMs: number): { ok: true; id: number } | Failure {
      const trimmed = name.trim();
      if (trimmed.length === 0 || trimmed.length > LIMITS.playlistNameChars) {
        return fail("playlist_name_invalid", `nom de playlist entre 1 et ${LIMITS.playlistNameChars} caracteres`);
      }
      const count = Number(statements.countPlaylists.get(userId)?.["n"] ?? 0);
      if (count >= LIMITS.playlistsPerUser) {
        return fail("too_many_playlists", `${LIMITS.playlistsPerUser} playlists au maximum`);
      }
      const row = statements.createPlaylist.get(userId, trimmed, nowMs);
      if (!row) throw new Error("creation de playlist sans resultat");
      return { ok: true, id: Number(row["id"]) };
    },

    listPlaylists(userId: number): Playlist[] {
      return statements.listPlaylists.all(userId).map((row) => ({
        id: Number(row["id"]),
        name: String(row["name"]),
        createdAt: Number(row["created_at"]),
        itemCount: Number(row["item_count"]),
      }));
    },

    /*
     * Toute lecture de playlist est portee par (id, compte) et rend null quand la
     * playlist appartient a quelqu un d autre (U6): les ids sont sequentiels, donc
     * enumerables, et etre connecte ne donne pas droit aux playlists des autres.
     */
    getPlaylistItems(playlistId: number, userId: number): PlaylistItem[] | null {
      if (!statements.ownedPlaylist.get(playlistId, userId)) return null;
      return statements.playlistItems.all(playlistId).map((row) => ({
        videoId: String(row["video_id"]),
        title: row["title"] === null ? null : String(row["title"]),
        position: Number(row["position"]),
      }));
    },

    /** Ajoute a la fin de la playlist. */
    addPlaylistItem(
      playlistId: number,
      userId: number,
      item: { videoId: string; title: string | null },
      nowMs: number,
    ): { ok: true; position: number } | Failure {
      if (!statements.ownedPlaylist.get(playlistId, userId)) {
        return fail("playlist_not_found", "aucune playlist de ce compte ne porte cet identifiant");
      }
      const row = statements.nextPosition.get(playlistId);
      if (Number(row?.["n"] ?? 0) >= LIMITS.itemsPerPlaylist) {
        return fail("playlist_full", `${LIMITS.itemsPerPlaylist} morceaux au maximum par playlist`);
      }
      const position = Number(row?.["next"] ?? 0);
      statements.addPlaylistItem.run(
        playlistId, item.videoId, clampText(item.title), position, nowMs,
      );
      return { ok: true, position };
    },
  };
}

export type Db = ReturnType<typeof openDatabase>;
