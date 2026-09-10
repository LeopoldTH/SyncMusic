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

  /*
   * Couvre R13. La phrase disait « Sans compte, tout marche pareil », ce que la
   * memoire des ecoutes rend faux: le compte garde les soirees et permet de les
   * revoir. Il reste facultatif, l accueil cesse seulement d affirmer le contraire.
   */
  it("dit a un invite ce que le compte apporte, sans affirmer qu il ne change rien", () => {
    const html = rendu(null);
    expect(html).toContain("Se connecter avec Google");
    expect(html).toContain("/auth/login");
    expect(html).toContain("Facultatif");
    expect(html).toContain("tes écoutes sont gardées et tu peux les revoir");
    expect(html).not.toContain("tout marche pareil");
  });

  it("affiche le nom du compte et mene a l ecran de compte", () => {
    const html = rendu({ name: "Leo" });
    expect(html).toContain("Leo");
    expect(html).toContain("/compte");
    expect(html).not.toContain("Se connecter avec Google");
  });

  it("mene a la memoire des ecoutes depuis le profil", () => {
    expect(rendu({ name: "Leo" })).toContain("/memoire");
  });
});
