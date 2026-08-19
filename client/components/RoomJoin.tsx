import { useState } from "react";

interface Props {
  onCreate: () => void;
  onJoin: (code: string) => void;
  error: string | null;
}

export function RoomJoin({ onCreate, onJoin, error }: Props) {
  const [code, setCode] = useState("");

  return (
    <main className="join">
      <h1>SyncMusic</h1>
      <p className="join__baseline">La meme musique, au meme instant, chacun chez soi.</p>

      <button type="button" className="btn btn--primary" onClick={onCreate}>
        Creer une room
      </button>

      <div className="join__sep">ou</div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const cleaned = code.trim().toUpperCase();
          if (cleaned.length > 0) onJoin(cleaned);
        }}
      >
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Code a quatre lettres"
          maxLength={4}
          autoComplete="off"
          aria-label="Code de room"
        />
        <button type="submit" className="btn">Rejoindre</button>
      </form>

      {error === null ? null : <p className="error">{error}</p>}
    </main>
  );
}
