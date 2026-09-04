import { describe, it, expect } from "vitest";
import { createYouTubePlayer, faultFromErrorCode, type RawPlayer } from "./youtubePlayer";

/** Faux lecteur: on pilote sa position et son etat a la main. */
function fakeRaw(initial = { seconds: 0, state: 1 }) {
  const calls: string[] = [];
  const raw: RawPlayer & { seconds: number; state: number; calls: string[] } = {
    seconds: initial.seconds,
    state: initial.state,
    calls,
    getCurrentTime: () => raw.seconds,
    getPlayerState: () => raw.state,
    playVideo: () => { calls.push("play"); },
    pauseVideo: () => { calls.push("pause"); },
    seekTo: (s) => { calls.push("seek:" + s); raw.seconds = s; },
    setPlaybackRate: (r) => { calls.push("rate:" + r); },
    loadVideoById: (v) => { calls.push("load:" + v); raw.seconds = 0; },
  };
  return raw;
}

const visible = () => 1;
const hidden = () => 0;
const noGesture = () => false;
const gestured = () => true;

describe("fraicheur de la position", () => {
  it("declare la position gelee quand elle n avance plus en lecture", () => {
    const raw = fakeRaw({ seconds: 30, state: 1 });
    const p = createYouTubePlayer({ raw, visibleFraction: visible, hasUserGesture: noGesture });

    expect(p.observe(0).fresh).toBe(true);
    raw.seconds = 31;
    expect(p.observe(1_000).fresh).toBe(true);
    // La position ne bouge plus: le lecteur ne rapporte plus rien.
    expect(p.observe(2_500).fresh).toBe(false);
  });

  it("ne declare pas gelee une position a l arret volontaire", () => {
    const raw = fakeRaw({ seconds: 30, state: 2 });
    const p = createYouTubePlayer({ raw, visibleFraction: visible, hasUserGesture: noGesture });
    p.observe(0);
    expect(p.observe(5_000).fresh).toBe(true);
  });

  it("marque comme non observee une position lue juste apres un positionnement", () => {
    const raw = fakeRaw({ seconds: 30, state: 1 });
    const p = createYouTubePlayer({ raw, visibleFraction: visible, hasUserGesture: noGesture });
    p.observe(0);
    p.seekTo(90_000, 1_000);
    expect(p.observe(1_100).fresh).toBe(false);
    raw.seconds = 91;
    expect(p.observe(2_400).fresh).toBe(true);
  });
});

describe("chargement d un morceau", () => {
  it("signale la remise a 1 de la vitesse, une seule fois", () => {
    const raw = fakeRaw();
    const p = createYouTubePlayer({ raw, visibleFraction: visible, hasUserGesture: noGesture });
    p.load("kJQP7kiw5Fk", 0);
    expect(p.takeRateReset()).toBe(true);
    expect(p.takeRateReset()).toBe(false);
  });
});

describe("porte de visibilite", () => {
  it("refuse une lecture automatique quand le lecteur n est pas assez visible", () => {
    const raw = fakeRaw({ seconds: 0, state: 2 });
    const p = createYouTubePlayer({ raw, visibleFraction: hidden, hasUserGesture: noGesture });
    p.play({ automatic: true }, 0);
    expect(raw.calls).not.toContain("play");
  });

  it("autorise une lecture demandee par un geste utilisateur meme peu visible", () => {
    const raw = fakeRaw({ seconds: 0, state: 2 });
    const p = createYouTubePlayer({ raw, visibleFraction: hidden, hasUserGesture: noGesture });
    p.play({ automatic: false }, 0);
    expect(raw.calls).toContain("play");
  });

  it("autorise une reprise automatique onglet cache une fois la session demarree", () => {
    // Mesure du 2026-08-19: une reprise pilotee fonctionne onglet cache. Sans cette
    // regle, un onglet en arriere-plan resterait indefiniment non pret et aucune
    // barriere ne se fermerait: le produit ne marcherait pas dans son seul cas d usage.
    const raw = fakeRaw({ seconds: 0, state: 2 });
    let fraction = 1;
    const p = createYouTubePlayer({ raw, visibleFraction: () => fraction, hasUserGesture: noGesture });

    p.play({ automatic: true }, 0);

    fraction = 0; // l utilisateur passe sur un autre onglet
    p.play({ automatic: true }, 1_000);
    expect(raw.calls.filter((c) => c === "play")).toHaveLength(2);
  });

  it("autorise une premiere lecture peu visible quand l utilisateur a agi", () => {
    // Cas central du produit: ton pote appuie sur Lecture, ton onglet est derriere le
    // jeu, et tu as toi-meme rejoint la room au clavier quelques minutes plus tot.
    const raw = fakeRaw({ seconds: 0, state: 2 });
    const p = createYouTubePlayer({ raw, visibleFraction: hidden, hasUserGesture: gestured });
    p.play({ automatic: true }, 0);
    expect(raw.calls).toContain("play");
  });

  it("refuse tant que la session n a jamais demarre, meme au deuxieme essai", () => {
    const raw = fakeRaw({ seconds: 0, state: 2 });
    const p = createYouTubePlayer({ raw, visibleFraction: hidden, hasUserGesture: noGesture });
    p.play({ automatic: true }, 0);
    p.play({ automatic: true }, 1_000);
    expect(raw.calls).not.toContain("play");
  });
});

describe("codes d erreur du lecteur", () => {
  it("nomme l absence d en-tete Referer derriere le code 153", () => {
    expect(faultFromErrorCode(153)).toEqual({ kind: "referer_missing" });
    expect(faultFromErrorCode(101)).toEqual({ kind: "player_error", code: 101 });
  });

});

describe("fin de piste", () => {
  it("signale la fin une seule fois", () => {
    const raw = fakeRaw({ seconds: 200, state: 1 });
    const p = createYouTubePlayer({ raw, visibleFraction: visible, hasUserGesture: gestured });
    p.observe(0);
    expect(p.takeEnded()).toBe(false);

    raw.state = 0; // ENDED
    p.observe(1_000);
    expect(p.takeEnded()).toBe(true);
    expect(p.takeEnded()).toBe(false);
  });

  it("ne re-signale pas la fin tant qu on reste sur l etat termine", () => {
    // Sans le front montant, chaque tour renverrait une fin et le serveur avancerait
    // la file en boucle.
    const raw = fakeRaw({ seconds: 200, state: 0 });
    const p = createYouTubePlayer({ raw, visibleFraction: visible, hasUserGesture: gestured });
    p.observe(0);
    expect(p.takeEnded()).toBe(true);
    p.observe(1_000);
    p.observe(2_000);
    expect(p.takeEnded()).toBe(false);
  });

  it("re-arme la detection au chargement du morceau suivant", () => {
    const raw = fakeRaw({ seconds: 200, state: 0 });
    const p = createYouTubePlayer({ raw, visibleFraction: visible, hasUserGesture: gestured });
    p.observe(0);
    p.takeEnded();

    p.load("dQw4w9WgXcQ", 1_000);
    raw.state = 1;
    p.observe(2_000);
    expect(p.takeEnded()).toBe(false);

    raw.state = 0;
    p.observe(3_000);
    expect(p.takeEnded()).toBe(true);
  });

  it("ne confond pas une pause avec une fin", () => {
    const raw = fakeRaw({ seconds: 200, state: 1 });
    const p = createYouTubePlayer({ raw, visibleFraction: visible, hasUserGesture: gestured });
    p.observe(0);
    raw.state = 2; // PAUSED
    p.observe(1_000);
    expect(p.takeEnded()).toBe(false);
  });
});
