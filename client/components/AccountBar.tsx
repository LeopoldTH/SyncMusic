import { Link } from "react-router-dom";
import type { Account } from "../lib/account";

interface Props {
  /** `undefined` tant que /api/me n a pas repondu, `null` pour un invite. */
  account: Account | null | undefined;
}

/*
 * Barre de compte, sur l accueil uniquement (KD7): partir vers Google ferme la socket,
 * ce qui detruirait une room ou l on est seul et laisserait un fantome dans les autres.
 */
export function AccountBar({ account }: Props) {
  // Avant la reponse, rien: un bouton « Se connecter » qui clignote une demi-seconde
  // avant de laisser place a un nom donne a croire qu on a ete deconnecte.
  if (account === undefined) return <div className="account-bar account-bar--vide" />;

  if (account === null) {
    return (
      <div className="account-bar">
        <a className="btn account-bar__google" href="/auth/login">Se connecter avec Google</a>
        <p className="hint account-bar__hint">Facultatif. Sans compte, tout marche pareil.</p>
      </div>
    );
  }

  return (
    <div className="account-bar">
      <span className="account-bar__name">Connecte comme <strong>{account.name}</strong></span>
      <Link className="account-bar__link" to="/compte">Mon compte</Link>
      <Link className="account-bar__link" to="/historique">Mon historique</Link>
    </div>
  );
}
