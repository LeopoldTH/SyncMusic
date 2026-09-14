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
    // L index existe deja: la migration 2 echoue sur l un de ses index, apres avoir
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

  it("sert la recherche du titre le plus recent d une video par un index (U7, R7)", () => {
    const path = tempDbPath();
    openDatabase(path).close();

    const raw = new DatabaseSync(path);
    const plan = raw.prepare(`
      EXPLAIN QUERY PLAN
      SELECT (SELECT t.title FROM history_entries t
               WHERE t.user_id = 1 AND t.video_id = h.video_id AND t.title IS NOT NULL
               ORDER BY t.played_at DESC, t.id DESC LIMIT 1) AS title
      FROM history_entries h
      WHERE h.user_id = 1 AND h.listened_ms IS NOT NULL
      GROUP BY h.video_id
    `).all().map((row) => String(row["detail"])).join(" | ");
    raw.close();
    /*
     * Le top morceaux lance cette sous-requete pour chaque video du classement. Sans
     * index dessus, chacune relit tout l historique du compte et le cout grimpe plus
     * vite que le nombre de lignes: mesure du 09/09/2026, 37 ms a 5 000 lignes contre
     * 2,2 ms avec. Ce test echoue si l index cesse d etre celui que SQLite choisit.
     */
    expect(plan).toContain("history_by_video");
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
 *
 * L horloge d ecriture de chaque test vaut au moins le premier depart plus la duree
 * cumulee: une ligne ne peut pas avoir entendu plus que le temps ecoule, et l ecriture
 * plafonne a ce temps (revue du 11/09/2026, #7).
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

    expect(db.addListenedMs({ roomItemKey: "inst-1#i1", listenedMs: 10_000 }, T0 + 10_000)).toBe(1);
    expect(db.listHistory(user, 10)[0]?.listenedMs).toBe(10_000);
  });

  it("additionne au lieu de remplacer quand le morceau est rejoue (AE7, KTD3)", () => {
    const db = fresh();
    const user = withUser(db);
    db.recordListen({ userId: user, ...ECOUTE }, T0);

    db.addListenedMs({ roomItemKey: "inst-1#i1", listenedMs: 30_000 }, T0 + 30_000);
    db.addListenedMs({ roomItemKey: "inst-1#i1", listenedMs: 20_000 }, T0 + 50_000);

    expect(db.listHistory(user, 10)[0]?.listenedMs).toBe(50_000);
  });

  it("ne fait jamais decroitre une duree (R1)", () => {
    const db = fresh();
    const user = withUser(db);
    db.recordListen({ userId: user, ...ECOUTE }, T0);
    db.addListenedMs({ roomItemKey: "inst-1#i1", listenedMs: 30_000 }, T0 + 30_000);

    db.addListenedMs({ roomItemKey: "inst-1#i1", listenedMs: -10_000 }, T0 + 40_000);

    expect(db.listHistory(user, 10)[0]?.listenedMs).toBe(30_000);
  });

  /*
   * Le plafond de #7 se calcule avec l horloge du serveur. Si elle recule (ajustement
   * NTP), il passe sous la duree deja ecrite: sans le MAX exterieur, l UPDATE la
   * rabaisserait, ce que R1 interdit (revue du 11/09/2026, #7).
   */
  it("une horloge serveur qui recule ne rabaisse pas une duree deja ecrite (R1)", () => {
    const db = fresh();
    const user = withUser(db);
    db.recordListen({ userId: user, ...ECOUTE }, T0);
    db.addListenedMs({ roomItemKey: "inst-1#i1", listenedMs: 30_000 }, T0 + 30_000);

    // L horloge recule de vingt secondes: le plafond ne vaudrait plus que 10 000 ms.
    db.addListenedMs({ roomItemKey: "inst-1#i1", listenedMs: 5_000 }, T0 + 10_000);

    expect(db.listHistory(user, 10)[0]?.listenedMs).toBe(30_000);
  });

  it("touche la ligne de chaque compte qui porte la cle, avec la meme duree", () => {
    const db = fresh();
    const leo = withUser(db);
    const ami = db.upsertUser({ googleSub: "sub-ami", name: "Ami", email: null }, T0).id;
    db.recordListen({ userId: leo, ...ECOUTE }, T0);
    db.recordListen({ userId: ami, ...ECOUTE }, T0);

    expect(db.addListenedMs({ roomItemKey: "inst-1#i1", listenedMs: 25_000 }, T0 + 25_000)).toBe(2);
    expect(db.listHistory(leo, 10)[0]?.listenedMs).toBe(25_000);
    expect(db.listHistory(ami, 10)[0]?.listenedMs).toBe(25_000);
  });

  it("n ecrit rien quand aucune ligne ne porte cette cle", () => {
    const db = fresh();
    const user = withUser(db);
    db.recordListen({ userId: user, ...ECOUTE }, T0);

    expect(db.addListenedMs({ roomItemKey: "inst-9#i1", listenedMs: 10_000 }, T0 + 10_000)).toBe(0);
    expect(db.listHistory(user, 10)[0]?.listenedMs).toBeNull();
  });

  it("ne touche ni au premier horodatage ni aux autres seances", () => {
    const db = fresh();
    const user = withUser(db);
    db.recordListen({ userId: user, ...ECOUTE }, T0);
    db.recordListen({
      userId: user, ...ECOUTE, roomItemKey: "inst-2#i1", roomInstanceId: "inst-2",
    }, T0 + JOUR);

    db.addListenedMs({ roomItemKey: "inst-1#i1", listenedMs: 10_000 }, T0 + 10_000);

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
    }, T0 + 10_000);

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
    }, T0 + 10_000);

    expect(db.listHistory(user, 10)[0]).toMatchObject({
      title: "Get Lucky", channelTitle: "DaftPunkVEVO",
    });
  });

  it("tronque un titre trop long comme le fait l ecriture au depart commun", () => {
    const db = fresh();
    const user = withUser(db);
    db.recordListen({ userId: user, ...ECOUTE, title: null }, T0);

    db.addListenedMs({ roomItemKey: "inst-1#i1", listenedMs: 1, title: "x".repeat(500) }, T0 + 1);

    expect(db.listHistory(user, 10)[0]?.title).toHaveLength(LIMITS.titleChars);
  });

  /*
   * Revue du 11/09/2026, #7. Une position de stagnation hostile se lit comme une duree
   * arbitraire; l ecriture la ramene au temps ecoule depuis le premier depart commun,
   * seul majorant que le client ne controle pas.
   */
  it("ecrit le temps ecoule depuis le premier depart, pas une duree qui le depasse (revue du 11/09/2026, #7)", () => {
    const db = fresh();
    const user = withUser(db);
    db.recordListen({ userId: user, ...ECOUTE }, T0);

    db.addListenedMs({ roomItemKey: "inst-1#i1", listenedMs: 90_000 }, T0 + 60_000);

    expect(db.listHistory(user, 10)[0]?.listenedMs).toBe(60_000);
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

/*
 * Lectures agregees de l ecran de statistiques (U7). Toutes bornees par le compte du
 * demandeur: c est la seule garde de vie privee ici, les autres modules n en posant
 * aucune sur ces colonnes.
 *
 * Le semeur donne a chaque test le droit de ne decrire que ce qui compte pour lui.
 * La cle de morceau et l instance sont du bruit dans une assertion sur un classement.
 */
describe("statistiques d ecoute (U7)", () => {
  interface Semis {
    videoId?: string;
    title?: string | null;
    channelTitle?: string | null;
    thumbnailUrl?: string | null;
    instance?: string;
    at?: number;
    /** Absente = ligne jamais mesuree, comme les trois lignes de la base reelle. */
    ms?: number;
  }

  function semeur(db: Db, userId: number): (semis?: Semis) => void {
    let n = 0;
    return (semis: Semis = {}) => {
      n += 1;
      const instance = semis.instance ?? "inst-1";
      const roomItemKey = `${instance}#u${userId}-i${n}`;
      const at = semis.at ?? T0 + n;
      db.recordListen({
        userId,
        videoId: semis.videoId ?? "dQw4w9WgXcQ",
        title: semis.title === undefined ? "Get Lucky" : semis.title,
        channelTitle: semis.channelTitle ?? null,
        thumbnailUrl: semis.thumbnailUrl ?? null,
        roomItemKey,
        roomInstanceId: instance,
      }, at);
      // L ecriture suit l ecoute qu elle mesure: plus tot, le plafond de la revue du
      // 11/09/2026 (#7) rognerait la duree semee.
      if (semis.ms !== undefined) db.addListenedMs({ roomItemKey, listenedMs: semis.ms }, at + semis.ms);
    };
  }

  describe("compteurs cumules (R6)", () => {
    it("compte les lignes jouees, les durees connues et les seances", () => {
      const db = fresh();
      const user = withUser(db);
      const semer = semeur(db, user);
      semer({ ms: 30_000 });
      semer({ ms: 12_000 });
      semer({ instance: "inst-2" });

      expect(db.readListeningTotals(user)).toEqual({
        listenedMs: 42_000,
        timedTrackCount: 2,
        trackCount: 3,
        sessionCount: 2,
      });
    });

    /*
     * R9: le total de temps ne porte pas sur tout l historique quand des lignes n ont
     * pas de duree. Il rend donc sur combien de lignes il porte, faute de quoi l ecran
     * afficherait « 30 secondes ecoutees » pour une soiree entiere.
     */
    it("ignore les lignes sans duree et dit sur combien de lignes il porte (R9)", () => {
      const db = fresh();
      const user = withUser(db);
      const semer = semeur(db, user);
      semer({ ms: 30_000 });
      semer();
      semer();

      expect(db.readListeningTotals(user)).toMatchObject({
        listenedMs: 30_000, timedTrackCount: 1, trackCount: 3,
      });
    });

    it("rend des compteurs a zero pour un compte sans aucune ecoute", () => {
      const db = fresh();
      expect(db.readListeningTotals(withUser(db))).toEqual({
        listenedMs: 0, timedTrackCount: 0, trackCount: 0, sessionCount: 0,
      });
    });
  });

  describe("classement des morceaux (R7, KTD10)", () => {
    /*
     * Covers AE4. Trois morceaux ecoutes: le classement en rend trois et annonce trois
     * entrees distinctes. C est ce nombre, pas celui des lignes, qui laisse l ecran
     * decider s il a le droit d ecrire « top » (Assumption: cinq entrees distinctes).
     */
    it("rend ses trois entrees et son compte d entrees distinctes a faible volume (AE4)", () => {
      const db = fresh();
      const user = withUser(db);
      const semer = semeur(db, user);
      semer({ videoId: "video-a", ms: 30_000 });
      semer({ videoId: "video-b", ms: 20_000 });
      semer({ videoId: "video-c", ms: 10_000 });

      const top = db.listTopTracks(user, 10);
      expect(top.entries.map((e) => e.videoId)).toEqual(["video-a", "video-b", "video-c"]);
      expect(top).toMatchObject({ coveredPlays: 3, distinctCount: 3 });
    });

    it("classe par temps cumule, pas par nombre d ecoutes", () => {
      const db = fresh();
      const user = withUser(db);
      const semer = semeur(db, user);
      semer({ videoId: "video-court", ms: 5_000 });
      semer({ videoId: "video-court", instance: "inst-2", ms: 5_000 });
      semer({ videoId: "video-long", ms: 60_000 });

      expect(db.listTopTracks(user, 10).entries).toEqual([
        expect.objectContaining({ videoId: "video-long", listenedMs: 60_000, playCount: 1 }),
        expect.objectContaining({ videoId: "video-court", listenedMs: 10_000, playCount: 2 }),
      ]);
    });

    it("agrege un morceau joue dans deux seances et garde son titre le plus recent non nul", () => {
      const db = fresh();
      const user = withUser(db);
      const semer = semeur(db, user);
      semer({ title: "Ancien titre", channelTitle: "Ancienne chaine", at: T0, ms: 10_000 });
      semer({
        title: "Nouveau titre", channelTitle: "Nouvelle chaine", thumbnailUrl: "https://img/nouvelle.jpg",
        instance: "inst-2", at: T0 + JOUR, ms: 20_000,
      });
      semer({ title: null, instance: "inst-3", at: T0 + 2 * JOUR, ms: 5_000 });

      expect(db.listTopTracks(user, 10).entries).toEqual([{
        videoId: "dQw4w9WgXcQ",
        title: "Nouveau titre",
        channelTitle: "Nouvelle chaine",
        thumbnailUrl: "https://img/nouvelle.jpg",
        listenedMs: 35_000,
        playCount: 3,
      }]);
    });

    /*
     * KTD10: a egalite de temps cumule, l identifiant decroissant departage, comme
     * l index d historique. Sans cet ordre, deux ouvertures de l ecran renverraient le
     * meme classement dans deux ordres differents.
     */
    it("departe une egalite par identifiant decroissant, identique sur deux appels", () => {
      const db = fresh();
      const user = withUser(db);
      const semer = semeur(db, user);
      semer({ videoId: "video-a", ms: 30_000 });
      semer({ videoId: "video-b", ms: 30_000 });

      const premier = db.listTopTracks(user, 10).entries.map((e) => e.videoId);
      expect(premier).toEqual(["video-b", "video-a"]);
      expect(db.listTopTracks(user, 10).entries.map((e) => e.videoId)).toEqual(premier);
    });

    it("s arrete a la limite demandee sans mentir sur le nombre d entrees distinctes", () => {
      const db = fresh();
      const user = withUser(db);
      const semer = semeur(db, user);
      for (const suffix of ["a", "b", "c", "d"]) semer({ videoId: `video-${suffix}`, ms: 10_000 });

      const top = db.listTopTracks(user, 2);
      expect(top.entries).toHaveLength(2);
      expect(top).toMatchObject({ coveredPlays: 4, distinctCount: 4 });
    });

    it("rend un classement vide pour un compte sans aucune ecoute", () => {
      const db = fresh();
      expect(db.listTopTracks(withUser(db), 10)).toEqual({
        entries: [], coveredPlays: 0, distinctCount: 0,
      });
    });
  });

  describe("classement des artistes (R7, R9)", () => {
    /*
     * Covers AE9. Le classement ne porte pas sur les vingt ecoutes, douze n ayant pas
     * d artiste. Il le dit, faute de quoi l ecran presenterait un classement de huit
     * lignes comme le portrait d une soiree de vingt.
     */
    it("annonce une couverture de huit ecoutes sur vingt quand douze n ont pas d artiste (AE9)", () => {
      const db = fresh();
      const user = withUser(db);
      const semer = semeur(db, user);
      for (let i = 0; i < 8; i += 1) semer({ channelTitle: `Chaine ${i}`, ms: 10_000 });
      for (let i = 0; i < 12; i += 1) semer({ channelTitle: null, ms: 10_000 });

      expect(db.readListeningTotals(user).trackCount).toBe(20);
      expect(db.listTopArtists(user, 50)).toMatchObject({ coveredPlays: 8, distinctCount: 8 });
    });

    it("cumule le temps de plusieurs morceaux d une meme chaine", () => {
      const db = fresh();
      const user = withUser(db);
      const semer = semeur(db, user);
      semer({ videoId: "video-a", channelTitle: "Daft Punk", ms: 30_000 });
      semer({ videoId: "video-b", channelTitle: "Daft Punk", ms: 20_000 });
      semer({ videoId: "video-c", channelTitle: "Justice", ms: 40_000 });

      expect(db.listTopArtists(user, 10).entries).toEqual([
        { channelTitle: "Daft Punk", listenedMs: 50_000, playCount: 2 },
        { channelTitle: "Justice", listenedMs: 40_000, playCount: 1 },
      ]);
    });

    it("departe une egalite de facon stable sur deux appels", () => {
      const db = fresh();
      const user = withUser(db);
      const semer = semeur(db, user);
      semer({ channelTitle: "Daft Punk", ms: 30_000 });
      semer({ channelTitle: "Justice", ms: 30_000 });

      const premier = db.listTopArtists(user, 10).entries.map((e) => e.channelTitle);
      expect(premier).toEqual(["Justice", "Daft Punk"]);
      expect(db.listTopArtists(user, 10).entries.map((e) => e.channelTitle)).toEqual(premier);
    });
  });

  /*
   * R9 et l etape 3 de U7: une ligne sans duree pese zero seconde. La garder dans un
   * classement au temps la ferait figurer en queue tout en gonflant le denominateur
   * que le classement annonce.
   */
  it("n ecrit aucune ligne sans duree dans les classements au temps, ni dans leur couverture", () => {
    const db = fresh();
    const user = withUser(db);
    const semer = semeur(db, user);
    semer({ videoId: "video-mesure", channelTitle: "Daft Punk", ms: 30_000 });
    semer({ videoId: "video-inconnue", channelTitle: "Justice" });
    semer({ videoId: "video-inconnue-2", channelTitle: "Justice" });

    const tracks = db.listTopTracks(user, 10);
    expect(tracks.entries.map((e) => e.videoId)).toEqual(["video-mesure"]);
    expect(tracks).toMatchObject({ coveredPlays: 1, distinctCount: 1 });

    const artists = db.listTopArtists(user, 10);
    expect(artists.entries.map((e) => e.channelTitle)).toEqual(["Daft Punk"]);
    expect(artists).toMatchObject({ coveredPlays: 1, distinctCount: 1 });
  });

  describe("classement des genres (R12, KTD10, KTD12)", () => {
    it("compte un morceau dans chacun de ses genres, par parcours du tableau JSON", () => {
      const db = fresh();
      const user = withUser(db);
      const semer = semeur(db, user);
      semer({ videoId: "video-a", ms: 10_000 });
      db.setVideoGenres("video-a", ["Electronic music", "Pop music"]);

      expect(db.listTopGenres(user, 10).entries).toEqual([
        { genre: "Electronic music", trackCount: 1 },
        { genre: "Pop music", trackCount: 1 },
      ]);
    });

    it("classe par nombre de morceaux decroissant", () => {
      const db = fresh();
      const user = withUser(db);
      const semer = semeur(db, user);
      semer({ videoId: "video-a", ms: 10_000 });
      semer({ videoId: "video-b", instance: "inst-2", ms: 10_000 });
      db.setVideoGenres("video-a", ["Pop music"]);
      db.setVideoGenres("video-b", ["Pop music", "Jazz"]);

      expect(db.listTopGenres(user, 10).entries).toEqual([
        { genre: "Pop music", trackCount: 2 },
        { genre: "Jazz", trackCount: 1 },
      ]);
    });

    /*
     * KTD10: une etiquette de genre n a pas d identifiant a departager, l ordre
     * alphabetique tient donc lieu de departage stable.
     */
    it("departe deux genres a egalite par ordre alphabetique, identique sur deux appels", () => {
      const db = fresh();
      const user = withUser(db);
      const semer = semeur(db, user);
      semer({ videoId: "video-a", ms: 10_000 });
      db.setVideoGenres("video-a", ["Rock music", "Jazz"]);

      const premier = db.listTopGenres(user, 10).entries.map((e) => e.genre);
      expect(premier).toEqual(["Jazz", "Rock music"]);
      expect(db.listTopGenres(user, 10).entries.map((e) => e.genre)).toEqual(premier);
    });

    /*
     * KTD12: NULL est « jamais interrogee », [] est « interrogee, aucun genre ». Les
     * deux sont hors de tout classement, mais seule la premiere reste a interroger.
     */
    it("ne classe ni une ligne jamais interrogee ni une ligne interrogee sans genre", () => {
      const db = fresh();
      const user = withUser(db);
      const semer = semeur(db, user);
      semer({ videoId: "video-jamais", ms: 10_000 });
      semer({ videoId: "video-sans-genre", instance: "inst-2", ms: 10_000 });
      db.setVideoGenres("video-sans-genre", []);

      expect(db.listTopGenres(user, 10)).toEqual({
        entries: [], coveredPlays: 0, distinctCount: 0,
      });
      expect(db.listVideoIdsWithoutGenres(10)).toEqual(["video-jamais"]);
    });

    /*
     * Le classement des genres compte des morceaux, pas du temps (etape 5 de U7): une
     * ligne sans duree y compte donc pleinement. La base reelle du jour un ne porte
     * aucune duree, et un classement de genres vide y serait une perte seche.
     */
    it("compte une ligne sans duree, le classement portant sur des morceaux et non du temps", () => {
      const db = fresh();
      const user = withUser(db);
      const semer = semeur(db, user);
      semer({ videoId: "video-a" });
      db.setVideoGenres("video-a", ["Pop music"]);

      expect(db.listTopGenres(user, 10)).toEqual({
        entries: [{ genre: "Pop music", trackCount: 1 }], coveredPlays: 1, distinctCount: 1,
      });
    });

    it("annonce la couverture du classement en ecoutes reellement classees (R9)", () => {
      const db = fresh();
      const user = withUser(db);
      const semer = semeur(db, user);
      semer({ videoId: "video-a", ms: 10_000 });
      semer({ videoId: "video-b", instance: "inst-2", ms: 10_000 });
      semer({ videoId: "video-c", instance: "inst-3", ms: 10_000 });
      db.setVideoGenres("video-a", ["Pop music", "Jazz"]);
      db.setVideoGenres("video-b", ["Pop music"]);

      expect(db.listTopGenres(user, 10)).toMatchObject({ coveredPlays: 2, distinctCount: 2 });
    });

    /*
     * Une seule colonne abimee ne doit pas eteindre l ecran entier. `parseGenres` est
     * deja tolerante cote lecture de ligne; la lecture agregee passe par SQLite, qui
     * leve « malformed JSON » sur la premiere valeur illisible sans garde.
     */
    it("survit a une colonne de genres illisible", () => {
      const path = tempDbPath();
      const db = openDatabase(path);
      const user = withUser(db);
      const semer = semeur(db, user);
      semer({ videoId: "video-a", ms: 10_000 });
      semer({ videoId: "video-abimee", instance: "inst-2", ms: 10_000 });
      db.setVideoGenres("video-a", ["Pop music"]);
      db.close();

      const raw = new DatabaseSync(path);
      raw.prepare("UPDATE history_entries SET genres = ? WHERE video_id = ?")
        .run("pas du json", "video-abimee");
      raw.close();

      const reopened = openDatabase(path);
      const genres = reopened.listTopGenres(user, 10);
      reopened.close();
      expect(genres).toEqual({
        entries: [{ genre: "Pop music", trackCount: 1 }], coveredPlays: 1, distinctCount: 1,
      });
    });
  });

  describe("seances (R8, AE6)", () => {
    it("groupe deux morceaux d une meme instance en une seance, deux instances en deux (AE6)", () => {
      const db = fresh();
      const user = withUser(db);
      const semer = semeur(db, user);
      semer({ videoId: "video-a", instance: "inst-1" });
      semer({ videoId: "video-b", instance: "inst-1" });
      expect(db.listSessions(user, 10)).toHaveLength(1);

      const autre = db.upsertUser({ googleSub: "sub-ami", name: "Ami", email: null }, T0).id;
      const semerAutre = semeur(db, autre);
      semerAutre({ videoId: "video-a", instance: "inst-7" });
      semerAutre({ videoId: "video-b", instance: "inst-8" });
      expect(db.listSessions(autre, 10)).toHaveLength(2);
    });

    it("porte ses morceaux dans l ordre de lecture, son compte et sa duree totale (R8)", () => {
      const db = fresh();
      const user = withUser(db);
      const semer = semeur(db, user);
      semer({ videoId: "video-a", at: T0, ms: 30_000 });
      semer({ videoId: "video-b", at: T0 + 60_000, ms: 20_000 });
      semer({ videoId: "video-c", at: T0 + 120_000, ms: 10_000 });

      const [seance] = db.listSessions(user, 10);
      expect(seance).toMatchObject({
        roomInstanceId: "inst-1", startedAt: T0, trackCount: 3, listenedMs: 60_000,
      });
      expect(seance?.tracks.map((t) => t.videoId)).toEqual(["video-a", "video-b", "video-c"]);
    });

    it("porte une duree totale egale a la somme de ses lignes mesurees quand l une manque", () => {
      const db = fresh();
      const user = withUser(db);
      const semer = semeur(db, user);
      semer({ videoId: "video-a", at: T0, ms: 30_000 });
      semer({ videoId: "video-b", at: T0 + 60_000 });
      semer({ videoId: "video-c", at: T0 + 120_000, ms: 10_000 });

      expect(db.listSessions(user, 10)[0]).toMatchObject({ trackCount: 3, listenedMs: 40_000 });
    });

    it("rend la plus recente en premier", () => {
      const db = fresh();
      const user = withUser(db);
      const semer = semeur(db, user);
      semer({ instance: "inst-ancienne", at: T0 });
      semer({ instance: "inst-recente", at: T0 + JOUR });

      expect(db.listSessions(user, 10).map((s) => s.roomInstanceId))
        .toEqual(["inst-recente", "inst-ancienne"]);
    });

    it("distingue deux seances du meme jour par leur heure de debut", () => {
      const db = fresh();
      const user = withUser(db);
      const semer = semeur(db, user);
      semer({ instance: "inst-midi", at: T0 });
      semer({ instance: "inst-soir", at: T0 + 8 * 60 * 60 * 1000 });

      expect(db.listSessions(user, 10).map((s) => s.startedAt))
        .toEqual([T0 + 8 * 60 * 60 * 1000, T0]);
    });

    /*
     * Une seance a cheval sur minuit garde la date de son premier morceau: sinon la
     * soiree du vendredi se lirait « samedi » des que le dernier morceau passe minuit.
     */
    it("porte la date de son premier morceau meme a cheval sur minuit", () => {
      const db = fresh();
      const user = withUser(db);
      const avantMinuit = Date.UTC(2026, 8, 4, 23, 40);
      const semer = semeur(db, user);
      semer({ videoId: "video-a", at: avantMinuit });
      semer({ videoId: "video-b", at: avantMinuit + 40 * 60 * 1000 });

      expect(db.listSessions(user, 10)[0]).toMatchObject({ startedAt: avantMinuit, trackCount: 2 });
    });

    /*
     * KTD8: le curseur porte sur la seance, jamais sur la ligne. Un curseur de ligne
     * couperait une seance en deux entre deux pages, et son compte de morceaux comme
     * sa duree seraient faux des deux cotes.
     */
    it("pagine par seance sans jamais en couper une en deux", () => {
      const db = fresh();
      const user = withUser(db);
      const semer = semeur(db, user);
      for (const [index, instance] of ["inst-1", "inst-2", "inst-3"].entries()) {
        semer({ videoId: "video-a", instance, at: T0 + index * JOUR });
        semer({ videoId: "video-b", instance, at: T0 + index * JOUR + 60_000 });
      }

      const premiere = db.listSessions(user, 2);
      expect(premiere.map((s) => s.roomInstanceId)).toEqual(["inst-3", "inst-2"]);
      expect(premiere.map((s) => s.tracks.length)).toEqual([2, 2]);

      const derniere = premiere[premiere.length - 1]!;
      const suivante = db.listSessions(user, 2, {
        startedAt: derniere.startedAt, roomInstanceId: derniere.roomInstanceId,
      });
      expect(suivante.map((s) => s.roomInstanceId)).toEqual(["inst-1"]);
      expect(suivante[0]?.tracks).toHaveLength(2);
    });

    /*
     * L instance departe deux seances qui commencent a la milliseconde pres, faute de
     * quoi le curseur n aurait pas d ordre total a suivre et rendrait deux fois la
     * meme seance, ou en sauterait une.
     */
    it("continue apres un curseur meme entre deux seances de meme heure de debut", () => {
      const db = fresh();
      const user = withUser(db);
      const semer = semeur(db, user);
      for (const instance of ["inst-a", "inst-b", "inst-c"]) semer({ instance, at: T0 });

      const premiere = db.listSessions(user, 2);
      expect(premiere.map((s) => s.roomInstanceId)).toEqual(["inst-c", "inst-b"]);

      const derniere = premiere[premiere.length - 1]!;
      expect(db.listSessions(user, 2, {
        startedAt: derniere.startedAt, roomInstanceId: derniere.roomInstanceId,
      }).map((s) => s.roomInstanceId)).toEqual(["inst-a"]);
    });

    it("rend une liste vide pour un compte sans aucune ecoute", () => {
      const db = fresh();
      expect(db.listSessions(withUser(db), 10)).toEqual([]);
    });

    /*
     * Les lignes d avant la migration 2 dont la cle ne portait pas de separateur sont
     * restees sans instance. Sans identite de seance, une telle ligne ne peut ni etre
     * placee dans une seance ni servir de curseur: elle reste hors du regroupement,
     * et le compteur de seances l ignore de la meme facon.
     */
    it("laisse hors des seances une ligne sans instance", () => {
      const path = tempDbPath();
      const db = openDatabase(path);
      const user = withUser(db);
      const semer = semeur(db, user);
      semer({ videoId: "video-a", instance: "inst-1" });
      semer({ videoId: "video-orpheline", instance: "inst-2" });
      db.close();

      const raw = new DatabaseSync(path);
      raw.prepare("UPDATE history_entries SET room_instance_id = NULL WHERE video_id = ?")
        .run("video-orpheline");
      raw.close();

      const reopened = openDatabase(path);
      const seances = reopened.listSessions(user, 10);
      const totals = reopened.readListeningTotals(user);
      reopened.close();
      expect(seances.map((s) => s.roomInstanceId)).toEqual(["inst-1"]);
      expect(totals).toMatchObject({ trackCount: 2, sessionCount: 1 });
    });
  });

  /*
   * La seule garde de vie privee de cet ecran: aucune de ces colonnes n est protegee
   * ailleurs. Les deux comptes partagent tout ce qui pourrait servir de jointure — la
   * meme video, la meme instance de room, les memes genres, les genres etant ecrits
   * pour tous les comptes a la fois (U6). Les lignes de l ami sont les plus recentes
   * et les plus longues: une requete oubliant le compte les ferait donc gagner partout,
   * y compris sur le titre « le plus recent non nul ».
   */
  it("ne laisse jamais un compte voir les lignes d un autre", () => {
    const db = fresh();
    const leo = withUser(db);
    const ami = db.upsertUser({ googleSub: "sub-ami", name: "Ami", email: null }, T0).id;
    const PARTAGEE = { videoId: "video-partagee", instance: "inst-1" };
    semeur(db, leo)({
      ...PARTAGEE, title: "Titre vu par Leo", channelTitle: "Daft Punk",
      thumbnailUrl: "https://img/leo.jpg", at: T0, ms: 30_000,
    });
    const semerAmi = semeur(db, ami);
    semerAmi({
      ...PARTAGEE, title: "Titre vu par Ami", channelTitle: "Justice",
      thumbnailUrl: "https://img/ami.jpg", at: T0 + 10 * JOUR, ms: 90_000,
    });
    semerAmi({ ...PARTAGEE, channelTitle: "Justice", at: T0 + 11 * JOUR, ms: 90_000 });
    semerAmi({ ...PARTAGEE, instance: "inst-2", channelTitle: "Justice", at: T0 + 12 * JOUR, ms: 90_000 });
    db.setVideoGenres("video-partagee", ["Jazz"]);

    expect(db.readListeningTotals(leo)).toEqual({
      listenedMs: 30_000, timedTrackCount: 1, trackCount: 1, sessionCount: 1,
    });
    expect(db.listTopTracks(leo, 10)).toEqual({
      entries: [{
        videoId: "video-partagee",
        title: "Titre vu par Leo",
        channelTitle: "Daft Punk",
        thumbnailUrl: "https://img/leo.jpg",
        listenedMs: 30_000,
        playCount: 1,
      }],
      coveredPlays: 1,
      distinctCount: 1,
    });
    expect(db.listTopArtists(leo, 10)).toEqual({
      entries: [{ channelTitle: "Daft Punk", listenedMs: 30_000, playCount: 1 }],
      coveredPlays: 1,
      distinctCount: 1,
    });
    expect(db.listTopGenres(leo, 10)).toEqual({
      entries: [{ genre: "Jazz", trackCount: 1 }], coveredPlays: 1, distinctCount: 1,
    });
    const seances = db.listSessions(leo, 10);
    expect(seances.map((s) => s.roomInstanceId)).toEqual(["inst-1"]);
    expect(seances[0]).toMatchObject({ trackCount: 1, listenedMs: 30_000 });
    expect(seances[0]?.tracks.map((t) => t.title)).toEqual(["Titre vu par Leo"]);
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
