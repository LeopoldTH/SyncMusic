import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Queue } from "./Queue";
import type { QueueItem } from "../../shared/protocol";

const items: QueueItem[] = [
  { itemId: "q1", videoId: "kJQP7kiw5Fk", addedBy: "leo", title: "Luis Fonsi - Despacito ft. Daddy Yankee" },
  { itemId: "q2", videoId: "dQw4w9WgXcQ", addedBy: "pote", title: null },
];

const noop = () => {};

describe("file de lecture", () => {
  it("invite a ajouter quand la file est vide", () => {
    const html = renderToStaticMarkup(<Queue items={[]} currentItemId={null} nameOf={(id) => (id === "leo" ? "toi" : "Pote")} onRemove={noop} />);
    expect(html).toContain("Rien dans la file");
    expect(html).toContain("Colle un lien YouTube");
  });

  it("n affiche pas de bouton retirer sur le morceau en cours", () => {
    const html = renderToStaticMarkup(<Queue items={items} currentItemId="q1" nameOf={(id) => (id === "leo" ? "toi" : "Pote")} onRemove={noop} />);
    // Un seul bouton Retirer, pour le second morceau.
    expect(html.match(/class="queue__remove"/g)).toHaveLength(1);
    expect(html).toContain("queue__item--playing");
  });

  it("affiche un bouton retirer sur chaque morceau quand rien ne joue", () => {
    const html = renderToStaticMarkup(<Queue items={items} currentItemId={null} nameOf={(id) => (id === "leo" ? "toi" : "Pote")} onRemove={noop} />);
    expect(html.match(/class="queue__remove"/g)).toHaveLength(2);
  });
});

describe("titres", () => {
  it("affiche le titre quand il est connu", () => {
    const html = renderToStaticMarkup(<Queue items={items} currentItemId={null} nameOf={(id) => (id === "leo" ? "toi" : "Pote")} onRemove={noop} />);
    expect(html).toContain("Despacito");
  });

  it("retombe sur l identifiant tant que le titre n est pas revenu", () => {
    const html = renderToStaticMarkup(<Queue items={items} currentItemId={null} nameOf={(id) => (id === "leo" ? "toi" : "Pote")} onRemove={noop} />);
    expect(html).toContain("dQw4w9WgXcQ");
  });

  it("garde l identifiant en infobulle, pour retrouver la video", () => {
    const html = renderToStaticMarkup(<Queue items={items} currentItemId={null} nameOf={(id) => (id === "leo" ? "toi" : "Pote")} onRemove={noop} />);
    expect(html).toContain('title="kJQP7kiw5Fk"');
  });
});

describe("qui a ajoute quoi", () => {
  it("dit toi pour ses propres ajouts et ton pote pour les autres", () => {
    const html = renderToStaticMarkup(<Queue items={items} currentItemId={null} nameOf={(id) => (id === "leo" ? "toi" : "Pote")} onRemove={noop} />);
    expect(html).toContain("ajoute par toi");
    expect(html).toContain("ajoute par Pote");
  });

  it("n affiche jamais d identifiant technique de participant", () => {
    const html = renderToStaticMarkup(<Queue items={items} currentItemId={null} nameOf={(id) => (id === "leo" ? "toi" : "Pote")} onRemove={noop} />);
    expect(html).not.toContain("ajoute par leo");
    expect(html).not.toContain("ajoute par pote");
  });
});
