import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { RoomJoin } from "./RoomJoin";
import type { Account } from "../lib/account";

const noop = () => {};

function rendu(account: Account | null | undefined): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <RoomJoin account={account} initialName="Bob" onCreate={noop} onJoin={noop} error={null} />
    </MemoryRouter>,
  );
}

describe("accueil, invite", () => {
  it("montre le champ pseudo et le bouton de connexion", () => {
    const html = rendu(null);
    expect(html).toContain("Ton pseudo");
    expect(html).toContain("Se connecter avec Google");
  });

  it("garde le pseudo retenu de la derniere fois", () => {
    expect(rendu(null)).toContain('value="Bob"');
  });
});

describe("accueil, connecte", () => {
  it("retire le champ pseudo: le serveur ignorerait ce qu on y taperait (KD5)", () => {
    const html = rendu({ name: "Leo" });
    expect(html).not.toContain("Ton pseudo");
    expect(html).toContain("Connecte comme");
  });

  it("n exige plus de choisir un pseudo pour commencer", () => {
    const html = rendu({ name: "Leo" });
    expect(html).not.toContain("Choisis un pseudo");
    // Creer et rejoindre sont actifs sans rien taper.
    expect(html).not.toContain("disabled");
  });

  it("laisse le nudge a l invite qui n a rien tape", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <RoomJoin account={null} initialName="" onCreate={noop} onJoin={noop} error={null} />
      </MemoryRouter>,
    );
    expect(html).toContain("Choisis un pseudo");
  });
});
