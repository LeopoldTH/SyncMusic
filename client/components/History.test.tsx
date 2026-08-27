import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { History } from "./History";
import type { HistoryPage } from "../lib/history";

const T0 = 1_700_000_000_000;
const noop = () => {};

const rendu = (props: Partial<Parameters<typeof History>[0]> = {}): string =>
  renderToStaticMarkup(
    <MemoryRouter>
      <History account={{ name: "Leo" }} page={null} onMore={noop} nowMs={T0} {...props} />
    </MemoryRouter>,
  );

describe("ecran historique", () => {
  it("invite un non-connecte a se connecter", () => {
    const html = rendu({ account: null });
    expect(html).toContain("Connecte-toi");
    expect(html).not.toContain("Pas encore de donnees");
  });

  it("patiente tant que la page n est pas arrivee", () => {
    expect(rendu({ page: null })).toContain("Un instant");
  });

  it("explique quoi faire quand l historique est vide", () => {
    const html = rendu({ page: { entries: [], nextBefore: null } });
    expect(html).toContain("Pas encore de donnees");
    expect(html).toContain("Ecoute un morceau en room");
  });

  it("affiche le titre, ou l identifiant tant que le titre n etait pas connu", () => {
    const page: HistoryPage = {
      entries: [
        { videoId: "kJQP7kiw5Fk", title: "Despacito", playedAt: T0 },
        { videoId: "dQw4w9WgXcQ", title: null, playedAt: T0 },
      ],
      nextBefore: null,
    };
    const html = rendu({ page });
    expect(html).toContain("Despacito");
    expect(html).toContain("dQw4w9WgXcQ");
    expect(html).toContain("history__title--raw");
  });

  it("date les ecoutes en langage courant", () => {
    const page: HistoryPage = {
      entries: [
        { videoId: "kJQP7kiw5Fk", title: "Ce matin", playedAt: T0 },
        { videoId: "dQw4w9WgXcQ", title: "La veille", playedAt: T0 - 24 * 60 * 60 * 1000 },
      ],
      nextBefore: null,
    };
    const html = rendu({ page });
    expect(html).toContain("aujourd hui");
    expect(html).toContain("hier");
  });

  it("ne propose voir plus que quand une page suivante existe", () => {
    const entry = { videoId: "kJQP7kiw5Fk", title: "Despacito", playedAt: T0 };
    expect(rendu({ page: { entries: [entry], nextBefore: `${T0}.1` } })).toContain("Voir plus");
    expect(rendu({ page: { entries: [entry], nextBefore: null } })).not.toContain("Voir plus");
  });
});
