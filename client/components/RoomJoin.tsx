import { useState } from "react";
import { AccountBar } from "./AccountBar";
import type { Account } from "../lib/account";

interface Props {
  /** `undefined` tant que /api/me n a pas repondu, `null` pour un invite. */
  account: Account | null | undefined;
  initialName: string;
  onCreate: (name: string) => void;
  onJoin: (code: string, name: string) => void;
  error: string | null;
}

export function RoomJoin({ account, initialName, onCreate, onJoin, error }: Props) {
  const [name, setName] = useState(initialName);
  const [code, setCode] = useState("");

  /*
   * Connecte, le nom du compte fait autorite (KD5) et le champ pseudo disparait: le
   * serveur ignorerait de toute facon ce qu on y taperait. Le protocole exige un nom
   * non vide, donc on envoie celui du compte.
   */
  const pseudo = account ? account.name : name.trim();
  const ready = pseudo.length > 0;

  return (
    <main className="join">
      <h1>SyncMusic</h1>
      <p className="join__baseline">La meme musique, au meme instant, chacun chez soi.</p>

      <AccountBar account={account} />

      {account ? null : (
        <label className="join__field">
          <span>Ton pseudo</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Tape un pseudo"
            maxLength={20}
            autoComplete="nickname"
            aria-label="Ton pseudo"
          />
        </label>
      )}

      <button
        type="button"
        className="btn btn--primary"
        onClick={() => onCreate(pseudo)}
        disabled={!ready}
      >
        Creer une room
      </button>

      <div className="join__sep">ou</div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const cleaned = code.trim().toUpperCase();
          if (cleaned.length > 0 && ready) onJoin(cleaned, pseudo);
        }}
      >
        <input
          className="join__code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Code a quatre lettres"
          maxLength={4}
          autoComplete="off"
          aria-label="Code de room"
        />
        <button type="submit" className="btn" disabled={!ready}>Rejoindre</button>
      </form>

      {ready || account ? null : <p className="hint join__nudge">Choisis un pseudo pour commencer.</p>}
      {error === null ? null : <p className="error">{error}</p>}
    </main>
  );
}
