import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, resolveDbPath, LIMITS, MIGRATIONS, type Db } from "./db";

const T0 = 1_700_000_000_000;
const JOUR = 24 * 60 * 60 * 1000;

const PROFIL = { googleSub: "sub-leo", name: "Leopold", email: "leo@example.com" };

/** Dossiers temporaires des tests qui ont besoin d un vrai fichier, nettoyes apres coup. */
const tempDirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "syncmusic-db-"));
  tempDirs.push(dir);
  return join(dir, "test.db");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fresh(): Db {
  return openDatabase(":memory:");
}

function withUser(db: Db): number {
  return db.upsertUser(PROFIL, T0).id;
}

/*
 * Une base arretee a la migration livree, comme celles d avant la memoire des ecoutes
 * (U2). Elle sert a jouer la migration 2 sur des lignes existantes plutot que sur du
 * vide: c est le seul cas ou le remplissage de l instance de room a quelque chose a
 * faire. Le compte porte l id 1, que les tests reutilisent.
 */
function baseVersion1(path: string, roomItemKeys: readonly string[]): void {
  const raw = new DatabaseSync(path);
  raw.exec(MIGRATIONS[0]!);
  raw.exec("PRAGMA user_version = 1");
  raw.prepare(
    "INSERT INTO users (id, google_sub, name, email, created_at) VALUES (1, 'sub-leo', 'Leopold', null, ?)",
  ).run(T0);
  const insert = raw.prepare(`
    INSERT INTO history_entries (user_id, video_id, title, played_at, room_item_key)
    VALUES (1, 'dQw4w9WgXcQ', 'Get Lucky', ?, ?)
  `);
  // Un horodatage distinct par ligne: la lecture ordonne du plus recent au plus ancien,
  // donc l ordre d insertion se retrouve par un reverse, sans dependre des ids.
  roomItemKeys.forEach((key, i) => insert.run(T0 + i, key));
  raw.close();
}

describe("chemin de la base", () => {
  it("prend data/syncmusic.db par defaut", () => {
    expect(resolveDbPath(undefined, "/app/dist")).toMatch(/data\/syncmusic\.db$/);
  });

  it("refuse un chemin sous le dossier servi", () => {
    expect(() => resolveDbPath("/app/dist/syncmusic.db", "/app/dist")).toThrow(/dossier servi/);
  });

  it("accepte un dossier voisin dont le nom commence pareil", () => {
    expect(resolveDbPath("/app/dist-data/x.db", "/app/dist")).toBe("/app/dist-data/x.db");
  });
});

describe("migrations", () => {
  it("cree les cinq tables et pose la derniere version", () => {
    const path = tempDbPath();
    openDatabase(path).close();

    const raw = new DatabaseSync(path);
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map((row) => String(row["name"]));
    expect(tables).toEqual(expect.arrayContaining([
      "users", "sessions", "history_entries", "playlists", "playlist_items",
    ]));
    expect(Number(raw.prepare("PRAGMA user_version").get()?.["user_version"])).toBe(MIGRATIONS.length);
    raw.close();
  });

  it("porte les cinq colonnes de la memoire des ecoutes sur une base neuve (U2)", () => {
    const path = tempDbPath();
    openDatabase(path).close();

    const raw = new DatabaseSync(path);
    const colonnes = raw.prepare("PRAGMA table_info(history_entries)").all()
      .map((row) => String(row["name"]));
    raw.close();
    expect(colonnes).toEqual(expect.arrayContaining([
      "listened_ms", "channel_title", "thumbnail_url", "genres", "room_instance_id",
    ]));
  });

  it("migre une base en version 1 sans perdre ses lignes", () => {
    const path = tempDbPath();
    baseVersion1(path, ["inst-1#i1"]);

    const db = openDatabase(path);
    const entries = db.listHistory(1, 10);
    db.close();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ videoId: "dQw4w9WgXcQ", title: "Get Lucky", playedAt: T0 });

    const raw = new DatabaseSync(path);
    expect(Number(raw.prepare("PRAGMA user_version").get()?.["user_version"])).toBe(2);
    raw.close();
  });

  it("remplit l instance de room depuis le prefixe des cles deja stockees (KTD4)", () => {
    const path = tempDbPath();
    // Une cle bien formee, une sans separateur, une dont le prefixe serait vide.
    baseVersion1(path, ["inst-1#i1", "sans-separateur", "#i1"]);

    const db = openDatabase(path);
    const instances = db.listHistory(1, 10).map((e) => e.roomInstanceId).reverse();
    db.close();
    expect(instances).toEqual(["inst-1", null, null]);
  });

  it("rend null les colonnes neuves des lignes migrees, sans planter a la lecture (R4)", () => {
    const path = tempDbPath();
    baseVersion1(path, ["inst-1#i1"]);

    const db = openDatabase(path);
    const entry = db.listHistory(1, 10)[0];
    db.close();
    expect(entry).toMatchObject({
      listenedMs: null, channelTitle: null, thumbnailUrl: null, genres: null,
    });
  });

  it("laisse la version et la table intactes quand une migration echoue", () => {
    const path = tempDbPath();
    baseVersion1(path, ["inst-1#i1"]);
    // L index existe deja: la migration 2 echoue a sa derniere instruction, apres avoir
    // ajoute ses colonnes. La transaction par script doit donc defaire des ALTER reussis.
    const prepare = new DatabaseSync(path);
    prepare.exec("CREATE INDEX history_by_session ON history_entries(user_id)");
    prepare.close();

    expect(() => openDatabase(path)).toThrow();

    const raw = new DatabaseSync(path);
    expect(Number(raw.prepare("PRAGMA user_version").get()?.["user_version"])).toBe(1);
    expect(Number(raw.prepare("SELECT COUNT(*) AS n FROM history_entries").get()?.["n"])).toBe(1);
    const colonnes = raw.prepare("PRAGMA table_info(history_entries)").all()
      .map((row) => String(row["name"]));
    raw.close();
    expect(colonnes).not.toContain("room_instance_id");
  });

  it("sert le regroupement par seance et par compte par un index (KTD4)", () => {
    const path = tempDbPath();
    openDatabase(path).close();

    const raw = new DatabaseSync(path);
    const plan = raw.prepare(`
      EXPLAIN QUERY PLAN
      SELECT room_instance_id, MIN(played_at) AS debut FROM history_entries
      WHERE user_id = 1 GROUP BY room_instance_id
    `).all().map((row) => String(row["detail"])).join(" | ");
    raw.close();
    // Sans index, le regroupement par seance passerait par un scan complet: c est
    // exactement ce que KTD4 refuse en faisant de l instance une colonne.
    expect(plan).toContain("history_by_session");
  });

  it("ne rejoue rien a la reouverture et garde les donnees", () => {
    const path = tempDbPath();
    const first = openDatabase(path);
    const userId = withUser(first);
    first.close();

    const second = openDatabase(path);
    expect(second.upsertUser(PROFIL, T0).id).toBe(userId);
    second.close();
  });

  it("cree le dossier parent s il manque", () => {
    const path = join(tempDbPath(), "..", "sous", "dossier", "test.db");
    expect(() => openDatabase(path).close()).not.toThrow();
  });
});

describe("comptes", () => {
  it("cree une seule ligne pour un meme sub et rafraichit l email", () => {
    const db = fresh();
    const first = db.upsertUser(PROFIL, T0);
    const second = db.upsertUser({ ...PROFIL, email: "nouveau@example.com" }, T0 + JOUR);
    expect(second.id).toBe(first.id);
    expect(second.email).toBe("nouveau@example.com");
  });

  it("rafraichit le nom venu de Google tant que l utilisateur ne l a pas choisi", () => {
    const db = fresh();
    db.upsertUser(PROFIL, T0);
    expect(db.upsertUser({ ...PROFIL, name: "Leo T." }, T0).name).toBe("Leo T.");
  });

  it("n ecrase pas le nom choisi par l utilisateur (KTD7)", () => {
    const db = fresh();
    const user = withUser(db);
    db.setUserName(user, "Leo");
    const refreshed = db.upsertUser({ ...PROFIL, name: "Leopold", email: "autre@example.com" }, T0);
    expect(refreshed.name).toBe("Leo");
    // Le nom est protege, l email reste une donnee d affichage rafraichie.
    expect(refreshed.email).toBe("autre@example.com");
  });

  it("accepte un compte sans email", () => {
    const db = fresh();
    expect(db.upsertUser({ ...PROFIL, email: null }, T0).email).toBeNull();
  });
});

describe("sessions", () => {
  it("retrouve le compte derriere un identifiant valide", () => {
    const db = fresh();
    const user = withUser(db);
    db.createSession("secret", user, T0);
    expect(db.findSession("secret", T0 + 1)?.id).toBe(user);
  });

  it("rend null pour un identifiant inconnu", () => {
    const db = fresh();
    db.createSession("secret", withUser(db), T0);
    expect(db.findSession("autre", T0 + 1)).toBeNull();
  });

  it("rend null passe l expiration", () => {
    const db = fresh();
    db.createSession("secret", withUser(db), T0);
    expect(db.findSession("secret", T0 + 61 * JOUR)).toBeNull();
  });

  it("repousse l expiration a l usage", () => {
    const db = fresh();
    db.createSession("secret", withUser(db), T0);
    db.renewSession("secret", T0 + 59 * JOUR);
    expect(db.findSession("secret", T0 + 61 * JOUR)).not.toBeNull();
  });

  it("ne repousse jamais au-dela du plafond dur de 180 jours", () => {
    const db = fresh();
    db.createSession("secret", withUser(db), T0);
    // Renouvellements a repetition, toujours avant expiration: la session meurt quand meme.
    for (let jour = 50; jour < 180; jour += 50) db.renewSession("secret", T0 + jour * JOUR);
    expect(db.findSession("secret", T0 + 181 * JOUR)).toBeNull();
  });

  it("ne ressuscite pas une session deja expiree", () => {
    const db = fresh();
    db.createSession("secret", withUser(db), T0);
    db.renewSession("secret", T0 + 61 * JOUR);
    expect(db.findSession("secret", T0 + 62 * JOUR)).toBeNull();
  });

  it("invalide la session sur-le-champ a la deconnexion", () => {
    const db = fresh();
    db.createSession("secret", withUser(db), T0);
    db.deleteSession("secret");
    expect(db.findSession("secret", T0 + 1)).toBeNull();
  });

  it("purge les sessions expirees et garde les valides", () => {
    const db = fresh();
    const user = withUser(db);
    db.createSession("vieille", user, T0 - 200 * JOUR);
    db.createSession("fraiche", user, T0);
    expect(db.deleteExpiredSessions(T0)).toBe(1);
    expect(db.findSession("fraiche", T0 + 1)).not.toBeNull();
  });

  it("ne garde pas l identifiant en clair en base (KTD4)", () => {
    const path = tempDbPath();
    const db = openDatabase(path);
    db.createSession("secret", withUser(db), T0);
    db.close();

    const raw = new DatabaseSync(path);
    const stored = String(raw.prepare("SELECT id FROM sessions").get()?.["id"]);
    raw.close();
    expect(stored).not.toBe("secret");
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuse une session sans compte (foreign_keys)", () => {
    expect(() => fresh().createSession("secret", 999, T0)).toThrow();
  });
});

describe("historique", () => {
  const ECOUTE = {
    videoId: "dQw4w9WgXcQ", title: "Get Lucky",
    roomItemKey: "inst-1#i1", roomInstanceId: "inst-1",
  };

  it("ne cree qu une entree pour un meme morceau, sans erreur au second passage", () => {
    const db = fresh();
    const user = withUser(db);
    expect(db.recordListen({ userId: user, ...ECOUTE }, T0)).toBe(true);
    expect(db.recordListen({ userId: user, ...ECOUTE }, T0 + 5_000)).toBe(false);
    expect(db.listHistory(user, 10)).toHaveLength(1);
  });

  it("donne son entree a chaque compte present au meme depart", () => {
    const db = fresh();
    const leo = withUser(db);
    const ami = db.upsertUser({ googleSub: "sub-ami", name: "Ami", email: null }, T0).id;
    db.recordListen({ userId: leo, ...ECOUTE }, T0);
    db.recordListen({ userId: ami, ...ECOUTE }, T0);
    expect(db.listHistory(leo, 10)).toHaveLength(1);
    expect(db.listHistory(ami, 10)).toHaveLength(1);
  });

  it("compte a nouveau le meme morceau dans une autre room", () => {
    const db = fresh();
    const user = withUser(db);
    db.recordListen({ userId: user, ...ECOUTE }, T0);
    db.recordListen({
      userId: user, ...ECOUTE, roomItemKey: "inst-2#i1", roomInstanceId: "inst-2",
    }, T0 + JOUR);
    expect(db.listHistory(user, 10)).toHaveLength(2);
  });

  it("rend le plus recent en premier", () => {
    const db = fresh();
    const user = withUser(db);
    db.recordListen({ userId: user, ...ECOUTE, roomItemKey: "a" }, T0);
    db.recordListen({ userId: user, ...ECOUTE, roomItemKey: "b" }, T0 + 1_000);
    expect(db.listHistory(user, 10).map((e) => e.playedAt)).toEqual([T0 + 1_000, T0]);
  });

  it("continue la liste apres un curseur, meme a date identique", () => {
    const db = fresh();
    const user = withUser(db);
    for (const key of ["a", "b", "c"]) db.recordListen({ userId: user, ...ECOUTE, roomItemKey: key }, T0);

    const first = db.listHistory(user, 2);
    const last = first[1];
    expect(last).toBeDefined();
    const next = db.listHistory(user, 2, { playedAt: last!.playedAt, id: last!.id });
    expect(next).toHaveLength(1);
    expect(next.map((e) => e.id)).not.toContain(last!.id);
  });

  it("accepte un titre inconnu et tronque un titre trop long", () => {
    const db = fresh();
    const user = withUser(db);
    db.recordListen({ userId: user, ...ECOUTE, title: null, roomItemKey: "a" }, T0);
    db.recordListen({ userId: user, ...ECOUTE, title: "x".repeat(500), roomItemKey: "b" }, T0 + 1);
    const [long, sansTitre] = db.listHistory(user, 10);
    expect(sansTitre?.title).toBeNull();
    expect(long?.title).toHaveLength(LIMITS.titleChars);
  });

  /*
   * L instance vient de l appelant, qui construit la cle: la base ne redecoupe plus
   * `<instance>#<item>` (KTD4). Une instance qui ne ressemble pas au prefixe de la cle
   * est la preuve que rien n est rededuit ici; le decoupage ne vit plus que dans la
   * migration 2, pour les lignes anciennes.
   */
  it("inscrit l instance de room que l appelant fournit (KTD4)", () => {
    const db = fresh();
    const user = withUser(db);
    db.recordListen({ userId: user, ...ECOUTE }, T0);
    db.recordListen({
      userId: user, ...ECOUTE, roomItemKey: "sans-separateur", roomInstanceId: "inst-9",
    }, T0 + 1);
    expect(db.listHistory(user, 10).map((e) => e.roomInstanceId)).toEqual(["inst-9", "inst-1"]);
  });

  it("garde le nom de chaine et la miniature quand oEmbed les a fournis (R2, R3)", () => {
    const db = fresh();
    const user = withUser(db);
    db.recordListen({
      userId: user,
      ...ECOUTE,
      channelTitle: "DaftPunkVEVO",
      thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    }, T0);
    expect(db.listHistory(user, 10)[0]).toMatchObject({
      channelTitle: "DaftPunkVEVO",
      thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    });
  });

  it("enregistre quand meme un morceau sans artiste, miniature ni duree (R4)", () => {
    const db = fresh();
    const user = withUser(db);
    db.recordListen({ userId: user, ...ECOUTE }, T0);
    expect(db.listHistory(user, 10)[0]).toMatchObject({
      channelTitle: null, thumbnailUrl: null, genres: null, listenedMs: null,
    });
  });

  it("tronque un nom de chaine trop long comme un titre", () => {
    const db = fresh();
    const user = withUser(db);
    db.recordListen({ userId: user, ...ECOUTE, channelTitle: "x".repeat(500) }, T0);
    expect(db.listHistory(user, 10)[0]?.channelTitle).toHaveLength(LIMITS.titleChars);
  });

  it("relit les genres en liste et distingue le tableau vide de la colonne absente (KTD12)", () => {
    const path = tempDbPath();
    const db = openDatabase(path);
    const user = withUser(db);
    ["a", "b", "c"].forEach((key, i) => db.recordListen({ userId: user, ...ECOUTE, roomItemKey: key }, T0 + i));
    db.close();

    // U6 n existe pas encore: on pose les genres a la main, comme il les ecrira.
    const raw = new DatabaseSync(path);
    const set = raw.prepare("UPDATE history_entries SET genres = ? WHERE room_item_key = ?");
    set.run('["Hip hop music","Pop music"]', "a");
    set.run("[]", "b");
    raw.close();

    const reopened = openDatabase(path);
    const genres = reopened.listHistory(user, 10).map((e) => e.genres).reverse();
    reopened.close();
    expect(genres).toEqual([["Hip hop music", "Pop music"], [], null]);
  });

  it("lit une colonne de genres illisible comme jamais interrogee", () => {
    const path = tempDbPath();
    const db = openDatabase(path);
    const user = withUser(db);
    db.recordListen({ userId: user, ...ECOUTE }, T0);
    db.close();

    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE history_entries SET genres = ?").run("pas du json");
    raw.close();

    const reopened = openDatabase(path);
    const genres = reopened.listHistory(user, 10)[0]?.genres;
    reopened.close();
    expect(genres).toBeNull();
  });
});

/*
 * U4, KTD3. L accumulation est un chemin distinct de la deduplication: le depart
 * commun cree la ligne et garde son premier horodatage, la fin de morceau ajoute a la
 * duree. Elle vise la cle de morceau seule, sans compte: a la destruction d une room
 * plus aucune session n existe, et les lignes n existent que pour des comptes
 * connectes puisque le depart commun applique deja la garde.
 */
describe("duree jouee accumulee (U4)", () => {
  const ECOUTE = {
    videoId: "dQw4w9WgXcQ", title: "Get Lucky",
    roomItemKey: "inst-1#i1", roomInstanceId: "inst-1",
  };

  it("ajoute la duree a une ligne existante sans qu aucun compte soit fourni (U4)", () => {
    const db = fresh();
    const user = withUser(db);
    db.recordListen({ userId: user, ...ECOUTE }, T0);

    expect(db.addListenedMs({ roomItemKey: "inst-1#i1", listenedMs: 10_000 })).toBe(1);
    expect(db.listHistory(user, 10)[0]?.listenedMs).toBe(10_000);
  });

  it("additionne au lieu de remplacer quand le morceau est rejoue (AE7, KTD3)", () => {
    const db = fresh();
    const user = withUser(db);
    db.recordListen({ userId: user, ...ECOUTE }, T0);

    db.addListenedMs({ roomItemKey: "inst-1#i1", listenedMs: 30_000 });
    db.addListenedMs({ roomItemKey: "inst-1#i1", listenedMs: 20_000 });

    expect(db.listHistory(user, 10)[0]?.listenedMs).toBe(50_000);
  });

  it("ne fait jamais decroitre une duree (R1)", () => {
    const db = fresh();
    const user = withUser(db);
    db.recordListen({ userId: user, ...ECOUTE }, T0);
    db.addListenedMs({ roomItemKey: "inst-1#i1", listenedMs: 30_000 });

    db.addListenedMs({ roomItemKey: "inst-1#i1", listenedMs: -10_000 });

    expect(db.listHistory(user, 10)[0]?.listenedMs).toBe(30_000);
  });

  it("touche la ligne de chaque compte qui porte la cle, avec la meme duree", () => {
    const db = fresh();
    const leo = withUser(db);
    const ami = db.upsertUser({ googleSub: "sub-ami", name: "Ami", email: null }, T0).id;
    db.recordListen({ userId: leo, ...ECOUTE }, T0);
    db.recordListen({ userId: ami, ...ECOUTE }, T0);

    expect(db.addListenedMs({ roomItemKey: "inst-1#i1", listenedMs: 25_000 })).toBe(2);
    expect(db.listHistory(leo, 10)[0]?.listenedMs).toBe(25_000);
    expect(db.listHistory(ami, 10)[0]?.listenedMs).toBe(25_000);
  });

  it("n ecrit rien quand aucune ligne ne porte cette cle", () => {
    const db = fresh();
    const user = withUser(db);
    db.recordListen({ userId: user, ...ECOUTE }, T0);

    expect(db.addListenedMs({ roomItemKey: "inst-9#i1", listenedMs: 10_000 })).toBe(0);
    expect(db.listHistory(user, 10)[0]?.listenedMs).toBeNull();
  });

  it("ne touche ni au premier horodatage ni aux autres seances", () => {
    const db = fresh();
    const user = withUser(db);
    db.recordListen({ userId: user, ...ECOUTE }, T0);
    db.recordListen({
      userId: user, ...ECOUTE, roomItemKey: "inst-2#i1", roomInstanceId: "inst-2",
    }, T0 + JOUR);

    db.addListenedMs({ roomItemKey: "inst-1#i1", listenedMs: 10_000 });

    const [recente, ancienne] = db.listHistory(user, 10);
    expect(ancienne).toMatchObject({ playedAt: T0, listenedMs: 10_000 });
    expect(recente).toMatchObject({ playedAt: T0 + JOUR, listenedMs: null });
  });

  it("complete le nom de chaine et la miniature que la ligne portait a vide (R2, R3)", () => {
    const db = fresh();
    const user = withUser(db);
    db.recordListen({ userId: user, ...ECOUTE, title: null }, T0);

    db.addListenedMs({
      roomItemKey: "inst-1#i1",
      listenedMs: 10_000,
      title: "Get Lucky",
      channelTitle: "DaftPunkVEVO",
      thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    });

    expect(db.listHistory(user, 10)[0]).toMatchObject({
      title: "Get Lucky",
      channelTitle: "DaftPunkVEVO",
      thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    });
  });

  it("n ecrase jamais une valeur deja presente par une valeur vide", () => {
    const db = fresh();
    const user = withUser(db);
    db.recordListen({ userId: user, ...ECOUTE, channelTitle: "DaftPunkVEVO" }, T0);

    db.addListenedMs({
      roomItemKey: "inst-1#i1", listenedMs: 10_000, title: null, channelTitle: null,
    });

    expect(db.listHistory(user, 10)[0]).toMatchObject({
      title: "Get Lucky", channelTitle: "DaftPunkVEVO",
    });
  });

  it("tronque un titre trop long comme le fait l ecriture au depart commun", () => {
    const db = fresh();
    const user = withUser(db);
    db.recordListen({ userId: user, ...ECOUTE, title: null }, T0);

    db.addListenedMs({ roomItemKey: "inst-1#i1", listenedMs: 1, title: "x".repeat(500) });

    expect(db.listHistory(user, 10)[0]?.title).toHaveLength(LIMITS.titleChars);
  });
});

/*
 * U6, KTD5, KTD12. Le genre est une propriete de la video, pas de l ecoute: on liste
 * des identifiants de video, pas des lignes, et un seul appel a YouTube remplit toutes
 * les lignes qui partagent l identifiant, quel que soit le compte ou la seance.
 */
describe("genres par video (U6)", () => {
  const ECOUTE = {
    videoId: "dQw4w9WgXcQ", title: "Get Lucky",
    roomItemKey: "inst-1#i1", roomInstanceId: "inst-1",
  };

  it("ne rend qu une fois une video jamais interrogee, meme ecoutee plusieurs fois", () => {
    const db = fresh();
    const user = withUser(db);
    db.recordListen({ userId: user, ...ECOUTE }, T0);
    db.recordListen({ userId: user, ...ECOUTE, roomItemKey: "inst-2#i1", roomInstanceId: "inst-2" }, T0 + 1);
    db.recordListen({ userId: user, ...ECOUTE, videoId: "kJQP7kiw5Fk", roomItemKey: "inst-2#i2" }, T0 + 2);

    expect(db.listVideoIdsWithoutGenres(10).sort()).toEqual(["dQw4w9WgXcQ", "kJQP7kiw5Fk"]);
  });

  it("rend les plus recemment jouees d abord et s arrete a la limite", () => {
    const db = fresh();
    const user = withUser(db);
    ["a", "b", "c"].forEach((suffix, i) => db.recordListen({
      userId: user, ...ECOUTE, videoId: `video-${suffix}`, roomItemKey: `inst-1#${suffix}`,
    }, T0 + i));

    // Une soiree d hier se remplit avant les archives quand la borne d un passage
    // ne suffit pas a tout couvrir (U6).
    expect(db.listVideoIdsWithoutGenres(2)).toEqual(["video-c", "video-b"]);
  });

  it("ecrit les genres sur toutes les lignes de la video, tous comptes et seances confondus", () => {
    const db = fresh();
    const leo = withUser(db);
    const ami = db.upsertUser({ googleSub: "sub-ami", name: "Ami", email: null }, T0).id;
    db.recordListen({ userId: leo, ...ECOUTE }, T0);
    db.recordListen({ userId: ami, ...ECOUTE }, T0);
    db.recordListen({ userId: leo, ...ECOUTE, roomItemKey: "inst-2#i1", roomInstanceId: "inst-2" }, T0 + 1);

    expect(db.setVideoGenres("dQw4w9WgXcQ", ["Pop music", "Rock music"])).toBe(3);
    expect(db.listHistory(leo, 10).map((entry) => entry.genres)).toEqual([
      ["Pop music", "Rock music"], ["Pop music", "Rock music"],
    ]);
    expect(db.listHistory(ami, 10)[0]?.genres).toEqual(["Pop music", "Rock music"]);
  });

  /*
   * KTD12: un tableau vide est une valeur pleine, « interrogee, aucun genre ». C est
   * ce qui empeche de redemander la meme video a YouTube a chaque ouverture.
   */
  it("sort de la liste a interroger une video marquee sans genre", () => {
    const db = fresh();
    const user = withUser(db);
    db.recordListen({ userId: user, ...ECOUTE }, T0);

    db.setVideoGenres("dQw4w9WgXcQ", []);

    expect(db.listVideoIdsWithoutGenres(10)).toEqual([]);
    expect(db.listHistory(user, 10)[0]?.genres).toEqual([]);
  });

  it("ne touche pas les lignes d une autre video", () => {
    const db = fresh();
    const user = withUser(db);
    db.recordListen({ userId: user, ...ECOUTE }, T0);
    db.recordListen({ userId: user, ...ECOUTE, videoId: "kJQP7kiw5Fk", roomItemKey: "inst-1#i2" }, T0 + 1);

    expect(db.setVideoGenres("dQw4w9WgXcQ", ["Pop music"])).toBe(1);
    expect(db.listVideoIdsWithoutGenres(10)).toEqual(["kJQP7kiw5Fk"]);
  });
});

describe("playlists", () => {
  it("cree une playlist et la liste avec son nombre de morceaux", () => {
    const db = fresh();
    const user = withUser(db);
    const created = db.createPlaylist(user, "Trajet", T0);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    db.addPlaylistItem(created.id, user, { videoId: "abc", title: null }, T0);
    expect(db.listPlaylists(user)).toEqual([
      { id: created.id, name: "Trajet", createdAt: T0, itemCount: 1 },
    ]);
  });

  it("refuse un nom vide ou trop long", () => {
    const db = fresh();
    const user = withUser(db);
    expect(db.createPlaylist(user, "   ", T0)).toMatchObject({ code: "playlist_name_invalid" });
    expect(db.createPlaylist(user, "x".repeat(LIMITS.playlistNameChars + 1), T0))
      .toMatchObject({ code: "playlist_name_invalid" });
  });

  it("refuse au-dela du plafond de playlists", () => {
    const db = fresh();
    const user = withUser(db);
    for (let i = 0; i < LIMITS.playlistsPerUser; i++) db.createPlaylist(user, `p${i}`, T0);
    expect(db.createPlaylist(user, "de trop", T0)).toMatchObject({ code: "too_many_playlists" });
  });

  it("ajoute a la fin, dans l ordre", () => {
    const db = fresh();
    const user = withUser(db);
    const created = db.createPlaylist(user, "Trajet", T0);
    if (!created.ok) throw new Error("playlist non creee");
    db.addPlaylistItem(created.id, user, { videoId: "un", title: "Un" }, T0);
    db.addPlaylistItem(created.id, user, { videoId: "deux", title: null }, T0 + 1);
    expect(db.getPlaylistItems(created.id, user)).toEqual([
      { videoId: "un", title: "Un", position: 0 },
      { videoId: "deux", title: null, position: 1 },
    ]);
  });

  it("refuse au-dela du plafond de morceaux", () => {
    const db = fresh();
    const user = withUser(db);
    const created = db.createPlaylist(user, "Trajet", T0);
    if (!created.ok) throw new Error("playlist non creee");
    for (let i = 0; i < LIMITS.itemsPerPlaylist; i++) {
      db.addPlaylistItem(created.id, user, { videoId: `v${i}`, title: null }, T0);
    }
    expect(db.addPlaylistItem(created.id, user, { videoId: "trop", title: null }, T0))
      .toMatchObject({ code: "playlist_full" });
  });

  it("ignore la playlist d un autre compte, en lecture comme en ecriture", () => {
    const db = fresh();
    const leo = withUser(db);
    const ami = db.upsertUser({ googleSub: "sub-ami", name: "Ami", email: null }, T0).id;
    const created = db.createPlaylist(leo, "Privee", T0);
    if (!created.ok) throw new Error("playlist non creee");

    expect(db.getPlaylistItems(created.id, ami)).toBeNull();
    expect(db.addPlaylistItem(created.id, ami, { videoId: "abc", title: null }, T0))
      .toMatchObject({ code: "playlist_not_found" });
    expect(db.getPlaylistItems(created.id, leo)).toEqual([]);
  });
});

describe("suppression d un compte", () => {
  it("emporte ses sessions, son historique et ses playlists (ON DELETE CASCADE)", () => {
    const path = tempDbPath();
    const db = openDatabase(path);
    const user = withUser(db);
    db.createSession("secret", user, T0);
    db.recordListen({
      userId: user, videoId: "abc", title: null, roomItemKey: "inst-1#i1", roomInstanceId: "inst-1",
    }, T0);
    const created = db.createPlaylist(user, "Trajet", T0);
    if (!created.ok) throw new Error("playlist non creee");
    db.addPlaylistItem(created.id, user, { videoId: "abc", title: null }, T0);
    db.close();

    const raw = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    raw.prepare("DELETE FROM users WHERE id = ?").run(user);
    const restes = ["sessions", "history_entries", "playlists", "playlist_items"].map((table) =>
      Number(raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"]),
    );
    raw.close();
    expect(restes).toEqual([0, 0, 0, 0]);
  });
});
