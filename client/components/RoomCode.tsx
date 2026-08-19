import { useState } from "react";

interface Props {
  code: string;
}

/*
 * Le code sert a une seule chose: etre transmis a quelqu un. Il est donc cliquable
 * pour etre copie, plutot qu affiche puis recopie a la main.
 */
export function RoomCode({ code }: Props) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_600);
    } catch {
      // Presse-papier refuse (contexte non securise, permission): on ne casse rien,
      // le code reste lisible et recopiable a la main.
    }
  }

  return (
    <button type="button" className="code" onClick={copy} title="Copier le code de la room">
      <span className="code__value">{code}</span>
      <span className="code__hint">{copied ? "copie" : "copier"}</span>
    </button>
  );
}
