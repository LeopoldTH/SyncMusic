import { useState } from "react";

interface Props {
  onCreate: () => void;
  onJoin: (code: string) => void;
  error: string | null;
}

export function RoomJoin({ onCreate, onJoin, error }: Props) {
  const [code, setCode] = useState("");

  return (
    <div className="join">
      <h1>SyncMusic</h1>
      <p>Ecoutez la meme file YouTube au meme instant, chacun chez soi.</p>

      <button type="button" onClick={onCreate}>Creer une room</button>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          onJoin(code.trim().toUpperCase());
        }}
      >
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Code a quatre lettres"
          maxLength={4}
          aria-label="Code de room"
        />
        <button type="submit">Rejoindre</button>
      </form>

      {error === null ? null : <p className="error">{error}</p>}
    </div>
  );
}
