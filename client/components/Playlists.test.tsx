import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { Playlists, SendPlaylist } from "./Playlists";
import type { Playlist } from "../lib/playlists";

const noop = () => {};

const deux: Playlist[] = [
  { id: 1, name: "Soiree", itemCount: 3 },
  { id: 2, name: "Calme", itemCount: 0 },
];

const rendu = (props: Partial<Parameters<typeof Playlists>[0]> = {}): string =>
  renderToStaticMarkup(
    <MemoryRouter>
      <Playlists
        account={{ name: "Leo" }}
        playlists={null}
        selectedId={null}
        items={null}
        recent={null}
        error={null}
        onSelect={noop}
        onCreate={noop}
        onAddLink={noop}
        onAddEntry={noop}
        onAddResult={noop}
        {...props}
      />
    </MemoryRouter>,
  );

describe("ecran playlists", () => {
  it("invite un non-connecte a se connecter", () => {
    expect(rendu({ account: null })).toContain("Connecte-toi");
  });

  it("explique quoi faire quand il n y a aucune playlist", () => {
    const html = rendu({ playlists: [] });
    expect(html).toContain("Pas encore de playlist");
    expect(html).toContain("Nom de la playlist");
  });

  it("liste les playlists avec leur nombre de morceaux", () => {
    const html = rendu({ playlists: deux });
    expect(html).toContain("Soiree");
    expect(html).toContain("3 morceaux");
    expect(html).toContain("vide");
  });

  it("montre le detail de la playlist selectionnee, avec les trois sources d ajout", () => {
    const html = rendu({
      playlists: deux,
      selectedId: 1,
      items: [{ videoId: "kJQP7kiw5Fk", title: "Despacito" }],
      recent: [{ videoId: "dQw4w9WgXcQ", title: "Never Gonna", playedAt: 1 }],
    });
    expect(html).toContain("Despacito");
    expect(html).toContain("Colle un lien YouTube");
    expect(html).toContain("Depuis ton historique");
    expect(html).toContain("Never Gonna");
    // Troisieme source, livree avec la barre de recherche (R8).
    expect(html).toContain("Par recherche");
    expect(html).toContain("Cherche un titre, un artiste");
  });

  /*
   * L historique peut etre vide, la recherche reste offerte: c est justement le cas
   * ou elle sert le plus, un compte neuf n ayant rien a piocher derriere lui.
   */
  it("offre la recherche meme sans historique", () => {
    const html = rendu({ playlists: deux, selectedId: 1, items: [], recent: [] });
    expect(html).toContain("Par recherche");
    expect(html).not.toContain("Depuis ton historique");
  });

  it("ne montre pas de detail sans selection", () => {
    expect(rendu({ playlists: deux })).not.toContain("Depuis ton historique");
  });
});

describe("selecteur d envoi en room", () => {
  const renduSend = (playlists: Playlist[] | null): string =>
    renderToStaticMarkup(<MemoryRouter><SendPlaylist playlists={playlists} onSend={noop} /></MemoryRouter>);

  it("reste muet tant que la liste n est pas arrivee", () => {
    expect(renduSend(null)).toBe("");
  });

  it("mene vers la creation quand il n y a aucune playlist", () => {
    const html = renduSend([]);
    expect(html).toContain("Pas encore de playlist");
    expect(html).toContain("/playlists");
  });

  it("propose les playlists et le bouton d envoi", () => {
    const html = renduSend(deux);
    expect(html).toContain("Soiree");
    expect(html).toContain("Envoyer dans la file");
  });
});
