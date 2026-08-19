import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SyncBadge } from "./SyncBadge";

const base = {
  connected: true, waitingFor: [], waitingSinceMs: null, nowMs: 0,
  hasPeer: true, playing: true, thresholdMs: 600,
};

describe("etat de synchronisation", () => {
  it("annonce la perte de connexion avant tout le reste", () => {
    const html = renderToStaticMarkup(
      <SyncBadge {...base} connected={false} waitingFor={["pote"]} waitingSinceMs={0} nowMs={5_000} pairGapMs={120} />
    );
    expect(html).toContain("Hors ligne");
    expect(html).not.toContain("pote");
  });

  it("nomme qui on attend et depuis combien de temps", () => {
    const html = renderToStaticMarkup(
      <SyncBadge {...base} waitingFor={["pote"]} waitingSinceMs={10_000} nowMs={22_000} pairGapMs={null} />
    );
    expect(html).toContain("pote");
    expect(html).toContain("12 s");
  });

  it("invite a partager le code quand on est vraiment seul", () => {
    const html = renderToStaticMarkup(<SyncBadge {...base} hasPeer={false} pairGapMs={null} />);
    expect(html).toContain("code de la room");
  });

  it("ne dit pas qu on est seul quand le second participant est la", () => {
    // Bug observe: l en-tete annoncait "avec Toto" pendant que la pastille disait
    // qu on attendait un second participant. Deux etats distincts, un seul message.
    const html = renderToStaticMarkup(<SyncBadge {...base} hasPeer pairGapMs={null} />);
    expect(html).not.toContain("En attente d un second participant");
    expect(html).toContain("Mesure en cours");
  });

  it("dit pret a jouer quand personne ne lit encore", () => {
    const html = renderToStaticMarkup(<SyncBadge {...base} hasPeer playing={false} pairGapMs={null} />);
    expect(html).toContain("Pret a jouer");
    expect(html).toContain("lancez un morceau");
  });

  it("dit en phase sous le seuil", () => {
    const html = renderToStaticMarkup(<SyncBadge {...base} pairGapMs={180.4} />);
    expect(html).toContain("En phase");
    expect(html).toContain("180 ms");
    expect(html).toContain("sync--ok");
  });

  it("dit decalage audible au-dessus du seuil, et rappelle la tolerance", () => {
    const html = renderToStaticMarkup(<SyncBadge {...base} pairGapMs={735} />);
    expect(html).toContain("Decalage audible");
    expect(html).toContain("735 ms");
    expect(html).toContain("600 ms");
    expect(html).toContain("sync--drift");
  });

  it("traite l avance et le retard de la meme facon", () => {
    // Le signe dit qui est devant, ce qui n interesse personne: seule l amplitude compte.
    const avance = renderToStaticMarkup(<SyncBadge {...base} pairGapMs={-735} />);
    const retard = renderToStaticMarkup(<SyncBadge {...base} pairGapMs={735} />);
    expect(avance).toBe(retard);
  });
});
