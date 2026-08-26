import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { AccountBar } from "./AccountBar";

const rendu = (account: Parameters<typeof AccountBar>[0]["account"]): string =>
  renderToStaticMarkup(<MemoryRouter><AccountBar account={account} /></MemoryRouter>);

describe("barre de compte", () => {
  it("ne montre rien tant que le serveur n a pas repondu", () => {
    const html = rendu(undefined);
    expect(html).not.toContain("Se connecter");
    expect(html).toContain("account-bar--vide");
  });

  it("propose la connexion a un invite, en disant qu elle est facultative", () => {
    const html = rendu(null);
    expect(html).toContain("Se connecter avec Google");
    expect(html).toContain("/auth/login");
    expect(html).toContain("Sans compte, tout marche pareil");
  });

  it("affiche le nom du compte et mene a l ecran de compte", () => {
    const html = rendu({ name: "Leo" });
    expect(html).toContain("Leo");
    expect(html).toContain("/compte");
    expect(html).not.toContain("Se connecter avec Google");
  });
});
