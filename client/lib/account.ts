/*
 * Etat du compte cote client.
 *
 * Les trois appels vivent ici plutot que dans les composants, pour que le chemin
 * d erreur soit le meme partout: une reponse inattendue, un serveur muet, ou des
 * routes de connexion absentes (deploiement sans identifiants Google) valent tous
 * « invite », jamais un ecran casse. Le compte debloque, il ne conditionne rien (KD1).
 */

export interface Account {
  name: string;
}

/** `null` = invite. Toute reponse autre que 200 vaut invite, y compris 401 et 404. */
export async function fetchAccount(): Promise<Account | null> {
  try {
    const response = await fetch("/api/me", { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    const name = (payload as { name?: unknown }).name;
    return typeof name === "string" && name.length > 0 ? { name } : null;
  } catch {
    return null;
  }
}

export type SaveResult = { ok: true; name: string } | { ok: false; reason: string };

export async function saveAccountName(name: string): Promise<SaveResult> {
  try {
    const response = await fetch("/api/name", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const reason = (payload as { error?: unknown } | null)?.error;
      return { ok: false, reason: typeof reason === "string" ? reason : "nom refuse" };
    }
    const saved = (payload as { name?: unknown }).name;
    return { ok: true, name: typeof saved === "string" ? saved : name };
  } catch {
    return { ok: false, reason: "serveur injoignable" };
  }
}

/*
 * La deconnexion supprime la session, mais la socket deja ouverte garde l identite
 * qu elle a recue a son upgrade (KTD5). Recharger la page est donc necessaire, pas
 * cosmetique: sans ca on reste sous son nom de compte dans la room en cours.
 */
export async function logout(): Promise<void> {
  try {
    await fetch("/auth/logout", { method: "POST" });
  } catch {
    // Reseau coupe: on recharge quand meme, le cookie sera revalide au prochain appel.
  }
}
