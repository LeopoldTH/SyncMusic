import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, resolveDbPath, LIMITS, type Db } from "./db";

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
  it("cree les cinq tables et pose la version", () => {
    const path = tempDbPath();
    openDatabase(path).close();

    const raw = new DatabaseSync(path);
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map((row) => String(row["name"]));
    expect(tables).toEqual(expect.arrayContaining([
      "users", "sessions", "history_entries", "playlists", "playlist_items",
    ]));
    expect(Number(raw.prepare("PRAGMA user_version").get()?.["user_version"])).toBe(1);
    raw.close();
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
  const ECOUTE = { videoId: "dQw4w9WgXcQ", title: "Get Lucky", roomItemKey: "inst-1#i1" };

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
    db.recordListen({ userId: user, ...ECOUTE, roomItemKey: "inst-2#i1" }, T0 + JOUR);
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
    db.recordListen({ userId: user, videoId: "abc", title: null, roomItemKey: "inst-1#i1" }, T0);
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
