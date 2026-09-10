import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { Memoire } from "./Memoire";
import type { ListeningSession, SessionTrack, Stats } from "../lib/memoire";

const T0 = 1_700_000_000_000; // 14/11/2023, quelle que soit la zone horaire du test
const HEURE = 3_600_000;
const noop = () => {};

const VIDE = { entries: [], coveredPlays: 0, distinctCount: 0 };

/** Des statistiques neutres, que chaque test deforme sur le seul point qu il vise. */
const stats = (partiel: Partial<Stats> = {}): Stats => ({
  totals: { listenedMs: 0, timedTrackCount: 0, trackCount: 0, sessionCount: 0 },
  topTracks: VIDE,
  topArtists: VIDE,
  topGenres: VIDE,
  sessions: { entries: [], nextBefore: null },
  ...partiel,
});

const seance = (n: number, tracks: SessionTrack[]): ListeningSession => ({
  roomInstanceId: `i${n}`,
  startedAt: T0 - n * HEURE,
  trackCount: tracks.length,
  listenedMs: tracks.reduce((somme, t) => somme + (t.listenedMs ?? 0), 0),
  tracks,
});

const morceau = (titre: string | null, extra: Partial<SessionTrack> = {}): SessionTrack => ({
  videoId: "kJQP7kiw5Fk",
  title: titre,
  channelTitle: null,
  playedAt: T0,
  listenedMs: null,
  ...extra,
});

/*
 * L etat du jour un, qui n est pas un cas limite: trois lignes, trois seances d un
 * morceau, aucune duree, aucun artiste (U8, AE10). C est ce que la base porte
 * reellement au moment ou l ecran est livre.
 */
const JOUR_UN: Stats = stats({
  totals: { listenedMs: 0, timedTrackCount: 0, trackCount: 3, sessionCount: 3 },
  sessions: {
    entries: [
      seance(0, [morceau("Despacito")]),
      seance(1, [morceau("Blinding Lights")]),
      seance(2, [morceau("Around the World")]),
    ],
    nextBefore: null,
  },
});

const rendu = (props: Partial<Parameters<typeof Memoire>[0]> = {}): string =>
  renderToStaticMarkup(
    <MemoryRouter>
      <Memoire account={{ name: "Leo" }} stats={null} onMore={noop} {...props} />
    </MemoryRouter>,
  );

describe("ecran de memoire des ecoutes", () => {
  it("invite un non-connecte a se connecter, sans lui montrer de compteurs vides", () => {
    const html = rendu({ account: null, stats: JOUR_UN });
    expect(html).toContain("Connecte-toi");
    expect(html).not.toContain("Séances");
    expect(html).not.toContain("Despacito");
  });

  /*
   * L ecran ne peut pas se rendre avec une identite inconnue: son type l interdit.
   * La garantie tient donc dans App, et App ne se rend pas ici — il lit window des
   * son premier hook, absent de l environnement node. On verifie la branche a la
   * source: c est la seule preuve accessible, et elle attrape la vraie regression,
   * celle ou quelqu un monte l ecran avant la reponse d identite.
   */
  it("n est pas monte tant que la reponse d identite n est pas arrivee", () => {
    const source = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    const branche = source.slice(source.indexOf('if (path === "/memoire")'));
    const attente = branche.indexOf("account === undefined");
    const montage = branche.indexOf("<Memoire");
    expect(attente).toBeGreaterThan(-1);
    expect(montage).toBeGreaterThan(-1);
    expect(attente).toBeLessThan(montage);
  });

  it("patiente tant que les statistiques ne sont pas arrivees, sans inviter ni zeroter", () => {
    const html = rendu({ stats: null });
    expect(html).toContain("Un instant");
    expect(html).not.toContain("Écoute un morceau");
    expect(html).not.toContain("memoire__valeur");
  });

  it("explique quoi faire a un compte qui n a rien ecoute, plutot que d afficher des zeros", () => {
    const html = rendu({ stats: stats() });
    expect(html).toContain("Écoute un morceau");
    expect(html).not.toContain("memoire__valeur");
    expect(html).not.toContain("Un instant");
  });

  it("affiche les compteurs de temps, de morceaux et de seances", () => {
    const html = rendu({
      stats: stats({ totals: { listenedMs: 390_000, timedTrackCount: 2, trackCount: 3, sessionCount: 2 } }),
    });
    expect(html).toContain("Temps écouté");
    expect(html).toContain("6 min 30");
    expect(html).toContain("Morceaux");
    expect(html).toContain("Séances");
  });

  it("ne rend pas de compteur de temps quand aucune ligne n est mesuree, et dit que la mesure commence", () => {
    const html = rendu({ stats: JOUR_UN });
    expect(html).not.toContain("Temps écouté");
    expect(html).not.toMatch(/\d+ min/);
    expect(html).toContain("La mesure des durées commence maintenant");
  });

  it("dit sur combien de morceaux le compteur de temps porte quand il n en couvre qu une partie", () => {
    const html = rendu({
      stats: stats({ totals: { listenedMs: 390_000, timedTrackCount: 2, trackCount: 3, sessionCount: 1 } }),
    });
    expect(html).toContain("Temps écouté");
    expect(html).toContain("2 morceaux sur 3");
    expect(html).not.toContain("0 min");
  });

  it("se tait sur la couverture quand le compteur de temps porte sur toutes les lignes", () => {
    const html = rendu({
      stats: stats({ totals: { listenedMs: 390_000, timedTrackCount: 3, trackCount: 3, sessionCount: 1 } }),
    });
    expect(html).toContain("Temps écouté");
    expect(html).not.toContain("morceaux sur 3");
  });

  it("ne rend aucun compteur de seances quand aucune ecoute ne porte de seance", () => {
    const html = rendu({
      stats: stats({ totals: { listenedMs: 0, timedTrackCount: 0, trackCount: 3, sessionCount: 0 } }),
    });
    expect(html).toContain("Morceaux");
    expect(html).not.toContain("Séances");
  });
});

describe("classements de la memoire", () => {
  const troisMorceaux = stats({
    totals: { listenedMs: 600_000, timedTrackCount: 3, trackCount: 3, sessionCount: 1 },
    topTracks: {
      entries: [
        { videoId: "a", title: "Un", listenedMs: 300_000, playCount: 1 },
        { videoId: "b", title: "Deux", listenedMs: 200_000, playCount: 1 },
        { videoId: "c", title: null, listenedMs: 100_000, playCount: 1 },
      ],
      coveredPlays: 3, distinctCount: 3,
    },
  });

  // Couvre AE4.
  it("n annonce aucun top sous cinq entrees distinctes, et affiche quand meme la liste", () => {
    const html = rendu({ stats: troisMorceaux });
    expect(html).not.toMatch(/\btop\b/i);
    expect(html).toContain("Morceaux écoutés");
    expect(html).toContain(">Un<");
    expect(html).toContain(">Deux<");
  });

  it("appelle top un classement a cinq entrees distinctes", () => {
    const cinq = stats({
      totals: { listenedMs: 600_000, timedTrackCount: 5, trackCount: 5, sessionCount: 1 },
      topTracks: {
        entries: [1, 2, 3, 4, 5].map((n) => ({
          videoId: `v${n}`, title: `Titre ${n}`, listenedMs: n * 1000, playCount: 1,
        })),
        coveredPlays: 5, distinctCount: 5,
      },
    });
    expect(rendu({ stats: cinq })).toContain("Top morceaux");
  });

  it("compte le seuil sur les entrees distinctes, pas sur les lignes classees", () => {
    const deuxMorceauxDixFois = stats({
      totals: { listenedMs: 600_000, timedTrackCount: 20, trackCount: 20, sessionCount: 1 },
      topTracks: {
        entries: [
          { videoId: "a", title: "Un", listenedMs: 300_000, playCount: 10 },
          { videoId: "b", title: "Deux", listenedMs: 200_000, playCount: 10 },
        ],
        coveredPlays: 20, distinctCount: 2,
      },
    });
    expect(rendu({ stats: deuxMorceauxDixFois })).not.toMatch(/\btop\b/i);
  });

  it("affiche l identifiant d un morceau dont le titre n a jamais ete connu", () => {
    const html = rendu({ stats: troisMorceaux });
    expect(html).toContain(">c<");
    expect(html).toContain("memoire__nom--brut");
  });

  it("dit sur combien d ecoutes un classement partiel est construit", () => {
    const partiel = stats({
      totals: { listenedMs: 300_000, timedTrackCount: 2, trackCount: 7, sessionCount: 1 },
      topTracks: {
        entries: [{ videoId: "a", title: "Un", listenedMs: 300_000, playCount: 2 }],
        coveredPlays: 2, distinctCount: 1,
      },
    });
    expect(rendu({ stats: partiel })).toContain("Construit sur 2 écoutes sur 7");
  });

  // Couvre AE10.
  it("ne rend aucun classement quand aucune ligne ne porte ni duree ni artiste", () => {
    const html = rendu({ stats: JOUR_UN });
    expect(html).not.toContain("Artistes écoutés");
    expect(html).not.toContain("Morceaux écoutés");
    expect(html).not.toContain("Genres écoutés");
  });

  it("garde dans le classement des morceaux celui qu aucun artiste ne nomme", () => {
    const sansArtiste = stats({
      totals: { listenedMs: 300_000, timedTrackCount: 1, trackCount: 1, sessionCount: 1 },
      topTracks: {
        entries: [{ videoId: "a", title: "Orphelin", listenedMs: 300_000, playCount: 1 }],
        coveredPlays: 1, distinctCount: 1,
      },
    });
    const html = rendu({ stats: sansArtiste });
    expect(html).toContain("Orphelin");
    expect(html).not.toContain("Artistes écoutés");
  });

  it("dit qu un morceau peut compter dans plusieurs genres, et les nomme au pluriel", () => {
    const genres = stats({
      totals: { listenedMs: 300_000, timedTrackCount: 2, trackCount: 2, sessionCount: 1 },
      topGenres: {
        entries: [{ genre: "Electronic music", trackCount: 2 }, { genre: "Pop music", trackCount: 1 }],
        coveredPlays: 2, distinctCount: 2,
      },
    });
    const html = rendu({ stats: genres });
    expect(html).toContain("Genres écoutés");
    expect(html).toContain("Un morceau peut compter dans plusieurs genres");
    expect(html).toContain("Electronic music");
  });
});

describe("fiches de seance", () => {
  const soiree = stats({
    totals: { listenedMs: 390_000, timedTrackCount: 2, trackCount: 2, sessionCount: 1 },
    sessions: {
      entries: [seance(0, [
        morceau("Around the World", { listenedMs: 210_000 }),
        morceau("Da Funk", { channelTitle: "Daft Punk", listenedMs: 180_000 }),
      ])],
      nextBefore: null,
    },
  });

  it("affiche la date, l heure de debut et les morceaux de chaque seance", () => {
    const html = rendu({ stats: soiree });
    expect(html).toContain("novembre 2023");
    expect(html).toMatch(/\d{2}:\d{2}/);
    expect(html).toContain("Around the World");
    expect(html).toContain("Da Funk");
    expect(html).toContain("Daft Punk");
  });

  it("distingue deux seances du meme jour par leur heure de debut", () => {
    const html = rendu({
      stats: stats({
        totals: { listenedMs: 0, timedTrackCount: 0, trackCount: 2, sessionCount: 2 },
        sessions: {
          entries: [seance(0, [morceau("Tard")]), seance(5, [morceau("Tot")])],
          nextBefore: null,
        },
      }),
    });
    const heures = [...html.matchAll(/(\d{2}:\d{2})/g)].map((m) => m[1]);
    expect(heures).toHaveLength(2);
    expect(heures[0]).not.toBe(heures[1]);
  });

  it("affiche la duree totale d une seance a cote de sa date", () => {
    expect(rendu({ stats: soiree })).toContain("6 min 30");
  });

  it("n affiche aucune duree pour une seance dont aucune ligne n est mesuree, et garde ses morceaux", () => {
    const html = rendu({ stats: JOUR_UN });
    expect(html).toContain("Despacito");
    expect(html).toContain("novembre 2023");
    expect(html).not.toMatch(/\d+ min/);
    expect(html).not.toMatch(/\d+ s</);
  });

  it("ne suppose pas plusieurs morceaux dans une seance qui n en porte qu un", () => {
    const html = rendu({ stats: JOUR_UN });
    expect(html).toContain("1 morceau<");
    expect(html).not.toContain("1 morceaux");
  });

  // Couvre AE10 cote seances: trois morceaux et trois seances s affichent bel et bien.
  it("affiche trois morceaux et trois seances au jour un", () => {
    const html = rendu({ stats: JOUR_UN });
    expect(html).toContain("3 séances");
    expect(html).toContain("Despacito");
    expect(html).toContain("Blinding Lights");
    expect(html).toContain("Around the World");
  });

  it("ne propose voir plus que quand une page de seances suivante existe", () => {
    const avecSuite = stats({
      totals: { listenedMs: 0, timedTrackCount: 0, trackCount: 1, sessionCount: 1 },
      sessions: { entries: [seance(0, [morceau("Un")])], nextBefore: `${T0}.i0` },
    });
    expect(rendu({ stats: avecSuite })).toContain("Voir plus");
    expect(rendu({ stats: JOUR_UN })).not.toContain("Voir plus");
  });
});

describe("charte Console sur l ecran de memoire", () => {
  const MARQUEUR = "/* --- Memoire des ecoutes";
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const bloc = css.slice(css.indexOf(MARQUEUR));

  it("a bien sa section dediee dans la feuille de style", () => {
    expect(css).toContain(MARQUEUR);
    expect(bloc).toContain(".memoire__");
  });

  it("ne pose aucune couleur hors des tokens de la charte", () => {
    const declares = [...css.matchAll(/^\s*(--[a-z-]+):/gm)].map((m) => m[1]);
    for (const [, token] of bloc.matchAll(/var\((--[a-z-]+)\)/g)) {
      expect(declares).toContain(token);
    }
    expect(bloc).not.toMatch(/#[0-9a-f]{3}/i);
    expect(bloc).not.toMatch(/rgba?\(/);
  });

  it("ne pose pas la LED verte sur un compteur: elle ne dit que la synchro", () => {
    expect(bloc).not.toContain("--led");
  });

  it("ne pose l accent sur aucune action: l ecran n en porte pas de primaire", () => {
    expect(bloc).not.toContain("var(--accent");
    expect(rendu({ stats: JOUR_UN })).not.toContain("btn--primary");
  });

  it("rend dans les deux faces: aucune couleur en ligne, tout vient des tokens", () => {
    const html = rendu({ stats: JOUR_UN });
    expect(html).not.toContain("style=");
    expect(html).not.toContain("jour");
    expect(html).not.toContain("nuit");
  });

  it("n affiche aucune miniature: leur traitement visuel n est pas tranche", () => {
    expect(rendu({ stats: JOUR_UN })).not.toContain("<img");
  });
});
