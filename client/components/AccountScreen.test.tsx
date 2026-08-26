import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { AccountScreen } from "./AccountScreen";
import type { Account } from "../lib/account";

const noop = () => {};

function rendu(account: Account | null, error: string | null = null): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AccountScreen account={account} onSave={noop} onLogout={noop} error={error} />
    </MemoryRouter>,
  );
}

describe("ecran de compte", () => {
  it("renvoie un invite vers l accueil sans lui montrer de champ", () => {
    const html = rendu(null);
    expect(html).toContain("Tu n es pas connecte");
    expect(html).not.toContain("Enregistrer");
  });

  it("pre-remplit le champ avec le nom du compte", () => {
    const html = rendu({ name: "Leo" });
    expect(html).toContain('value="Leo"');
    expect(html).toContain("Enregistrer");
    expect(html).toContain("Se deconnecter");
  });

  it("dit que ce nom est celui vu en room (KD5)", () => {
    expect(rendu({ name: "Leo" })).toContain("celui que les autres voient en room");
  });

  it("borne la saisie a la limite du protocole", () => {
    expect(rendu({ name: "Leo" })).toContain('maxLength="20"');
  });

  it("affiche le refus du serveur", () => {
    expect(rendu({ name: "Leo" }, "nom trop long")).toContain("nom trop long");
  });
});
