/*
 * Service des fichiers du client construit.
 *
 * Ecrit a la main plutot qu avec une dependance: le besoin tient en trente lignes, et
 * la seule partie delicate est le confinement des chemins, qu il vaut mieux avoir sous
 * les yeux qu enfoui dans une bibliotheque.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export function createStaticHandler(rootDir: string) {
  const root = resolve(rootDir);

  /*
   * Confinement: on resout le chemin demande puis on verifie qu il reste sous la
   * racine. Sans ce controle, une requete du genre `/../../etc/passwd` sortirait du
   * dossier servi. Le prefixe teste inclut le separateur, sinon un dossier voisin
   * nomme `dist-prive` passerait le test face a une racine `dist`.
   */
  function safePath(urlPath: string): string | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
    } catch {
      return null;
    }
    if (decoded.includes("\0")) return null;
    const candidate = resolve(join(root, decoded));
    if (candidate !== root && !candidate.startsWith(root + sep)) return null;
    return candidate;
  }

  return async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }

    const target = safePath(request.url ?? "/");
    if (target === null) {
      response.writeHead(400).end();
      return;
    }

    let file = target;
    try {
      const info = await stat(file);
      if (info.isDirectory()) file = join(file, "index.html");
      else if (!info.isFile()) throw new Error("ni fichier ni dossier");
      await stat(file);
    } catch {
      /*
       * Toute adresse inconnue rend la page: l application est une page unique, et un
       * lien partage vers une room doit fonctionner meme si le serveur ne connait pas
       * cette route.
       */
      file = join(root, "index.html");
      try {
        await stat(file);
      } catch {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
          .end("Application non construite. Lance `npm run build`.");
        return;
      }
    }

    const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    // Les fichiers construits portent une empreinte dans leur nom, la page non.
    const cache = file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable";

    response.writeHead(200, {
      "content-type": type,
      "cache-control": cache,
      // YouTube exige de recevoir l en-tete Referer depuis juillet 2025 (erreur 153).
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-content-type-options": "nosniff",
    });

    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(file).pipe(response);
  };
}
