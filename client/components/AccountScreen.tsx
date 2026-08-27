import { useState } from "react";
import { Link } from "react-router-dom";
import type { Account } from "../lib/account";

interface Props {
  /*
   * `null` pour un invite. Jamais « pas encore su »: App attend la reponse avant de
   * monter cet ecran, sinon le brouillon du champ se figerait vide avant que le nom
   * arrive, et l utilisateur trouverait un champ blanc a la place du sien.
   */
  account: Account | null;
  onSave: (name: string) => void;
  onLogout: () => void;
  error: string | null;
  /** La face de la machine (charte Console). Par appareil, donc offerte aussi aux invites. */
  theme: "jour" | "nuit";
  onTheme: (theme: "jour" | "nuit") => void;
}

function ThemePicker({ theme, onTheme }: { theme: "jour" | "nuit"; onTheme: (t: "jour" | "nuit") => void }) {
  return (
    <div className="theme">
      <span className="etiquette">Theme</span>
      <div className="theme__choices">
        <button
          type="button"
          className={theme === "jour" ? "btn btn--active" : "btn"}
          onClick={() => onTheme("jour")}
        >
          Jour
        </button>
        <button
          type="button"
          className={theme === "nuit" ? "btn btn--active" : "btn"}
          onClick={() => onTheme("nuit")}
        >
          Nuit
        </button>
      </div>
    </div>
  );
}

/*
 * Ecran de compte. Le nom se modifie ici et vaut partout (KD5): il n y a pas de
 * renommage par room, ce qui epargnerait un message de protocole pour un gain minime.
 */
export function AccountScreen({ account, onSave, onLogout, error, theme, onTheme }: Props) {
  const [draft, setDraft] = useState(account?.name ?? "");

  if (account === null) {
    return (
      <main className="join">
        <h1>Mon compte</h1>
        <p className="join__baseline">Tu n es pas connecte.</p>
        <ThemePicker theme={theme} onTheme={onTheme} />
        <div className="account-screen__foot">
          <Link className="account-bar__link" to="/">Retour a l accueil</Link>
        </div>
      </main>
    );
  }

  const trimmed = draft.trim();

  return (
    <main className="join">
      <h1>Mon compte</h1>
      <p className="join__baseline">Ce nom est celui que les autres voient en room.</p>

      <form
        className="account-screen__form"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed.length > 0) onSave(trimmed);
        }}
      >
        <label className="join__field">
          <span>Ton nom</span>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={account.name}
            maxLength={20}
            aria-label="Ton nom"
          />
        </label>
        <button type="submit" className="btn btn--primary" disabled={trimmed.length === 0}>
          Enregistrer
        </button>
      </form>

      {error === null ? null : <p className="error">{error}</p>}

      <ThemePicker theme={theme} onTheme={onTheme} />

      <div className="account-screen__foot">
        <Link className="account-bar__link" to="/">Retour a l accueil</Link>
        <button type="button" className="btn account-screen__logout" onClick={onLogout}>
          Se deconnecter
        </button>
      </div>
    </main>
  );
}
