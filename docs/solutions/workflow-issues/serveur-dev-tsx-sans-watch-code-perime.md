---
title: "tsx sans watch : le serveur de dev sert du code périmé, relancer dev:server après tout changement serveur"
date: 2026-08-27
category: workflow-issues
module: dev-server
problem_type: workflow_issue
component: development_workflow
severity: medium
symptoms:
  - "nouvelle route API en 404 (error: route inconnue) alors que le code est correct et smoke-testé sur un serveur frais"
  - "UI bloquée sur son état de chargement (« Un instant... ») après ajout d'un écran qui appelle la nouvelle route"
  - "le client Vite est à jour (hot reload) mais parle à un serveur démarré avant le nouveau code"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
applies_when:
  - "livraison de routes ou de logique serveur pendant que npm run dev:server tourne déjà"
  - "dev en deux process : Vite (5173, hot reload client) + tsx (8787, sans watch)"
  - "état en mémoire du process (rooms) qui interdit un restart automatique type tsx watch"
  - "symptôme d'erreur serveur incohérent avec le code ou le .env sous les yeux"
related_components:
  - api_layer
tags: [tsx, vite, hot-reload, stale-process, dev-server, in-memory-state, 404]
---

# tsx sans watch : le serveur de dev sert du code périmé

## Context

En développement, SyncMusic tourne sur deux process. `npm run dev` lance Vite sur le port 5173 et renvoie `/ws`, `/auth` et `/api` vers le serveur sur 8787 (vite.config.ts:16-21) ; Vite recharge le client à chaud à chaque sauvegarde. `npm run dev:server` lance le serveur Node avec tsx, sans watch : le script est `tsx --env-file-if-exists=.env server/index.ts` (package.json:12), aucun `--watch`, aucun redémarrage au changement de fichier. Le `.env` est lu une seule fois, au démarrage.

Les deux process ne vieillissent donc pas à la même vitesse. Le client dans le navigateur reflète toujours le code du disque ; le serveur reflète le code, et l'environnement, au moment où son process a démarré. Toute session qui livre du serveur avec son écran client peut se retrouver avec une UI neuve qui parle à un serveur ancien.

Ce n'est pas un incident isolé : cette famille de piège avait déjà mordu trois fois (session history) — des onglets restés connectés à une ancienne instance du serveur qui attendaient un participant « jamais prêt » (19/08), un serveur de test parasite squattant le port 8787 sans les identifiants Google et répondant « connexion Google non configurée » malgré un `.env` correct (26/08), et un `.env` rempli après le démarrage du serveur, sans effet jusqu'au restart (26/08).

Le cas du 27/08/2026 : les routes `/api/playlists` venaient d'être ajoutées (server/index.ts:266) et smoke-testées vertes sur un serveur fraîchement lancé. Sur l'écran « Mes playlists », créer une playlist affichait un bandeau « route inconnue » et la liste restait bloquée sur « Un instant... » : le process serveur en fond datait d'avant le commit qui ajoutait ces routes.

## Guidance

Le réflexe : **tout changement sous server/ ou shared/, et toute modification du `.env`, exigent de relancer `dev:server` à la main** (Ctrl+C puis `npm run dev:server`). Le client, lui, se recharge seul via Vite. Ce n'est pas symétrique, et c'est voulu (voir Why This Matters).

Quand une erreur serveur paraît incohérente avec le code sous les yeux, la première question n'est pas « où est mon bug » mais **« quel process écoute sur 8787, et depuis quand ? »** :

1. **Identifier le process et son âge.** Un serveur démarré avant le code qu'on teste ne peut pas le connaître ; un process parasite (serveur de test oublié) n'a peut-être même pas le bon environnement :

   ```bash
   lsof -nP -iTCP:8787 -sTCP:LISTEN        # qui ecoute, quel pid
   ps -o pid,etime,command -p <pid>         # etime = age du process
   ```

   Un `etime` supérieur à l'âge du dernier changement serveur suffit à conclure.

2. **Preuve discriminante : curl d'une route ancienne et d'une route nouvelle.** Un même process qui connaît une route livrée plus tôt mais pas la plus récente exécute un code entre les deux :

   ```bash
   curl -s http://localhost:8787/api/history      # route ancienne
   curl -s http://localhost:8787/api/playlists    # route nouvelle
   ```

   Sans session, `/api/history` répond 401 `{"error":"connexion requise"}` (server/index.ts:245) : la route existe, l'accès est refusé. Si une route plus récente répond 404 `{"error":"route inconnue"}` au même moment, ce n'est pas un bug du code : c'est le fallback d'un routeur JSON (server/auth.ts:436, et depuis U6 aussi server/index.ts:307) dans un process qui n'a jamais vu la route.

Résolution : relancer `dev:server`, retester. C'est tout.

## Why This Matters

Le symptôme est traître parce que l'UI à jour maquille le décalage. L'écran neuf s'affiche correctement (Vite l'a rechargé), le bandeau d'erreur vient d'un code qu'on vient d'écrire, et le réflexe naturel est de relire ce code, pas de soupçonner l'environnement. Chaque incident de cette famille a produit la même fausse piste : on a instrumenté le moteur avant de trouver des onglets branchés sur une vieille instance (session history), on a vérifié un `.env` pourtant correct avant de trouver le process parasite.

Le watch automatique (`tsx watch`) est **refusé délibérément**, pas oublié. Les rooms vivent en mémoire du process (server/roomRegistry.ts:36, une `Map` sans store externe ; décision KD9 du plan d'origine, « aucun compte, room éphémère », réaffirmée par KD3 du plan comptes) : chaque restart les détruit toutes. Un redémarrage automatique à chaque sauvegarde tuerait la room en plein test de synchronisation à deux fenêtres, le cœur du produit. Depuis la reconnexion automatique (livrée le 27/08, client/transport/socket.ts), les clients survivent au restart et se reconnectent seuls, mais ils retombent sur un serveur sans rooms : « Ta room précédente n'existe plus ». Le coût accepté est donc un relancement manuel, avec ce doc comme garde-fou contre le symptôme trompeur.

## When to Apply

- Dev local avec les deux process (`npm run dev` + `npm run dev:server`).
- Un changement vient d'être fait sous server/ ou shared/ (le code shared est chargé par le serveur aussi), ou dans `.env`.
- Symptômes typiques : 404 `{"error":"route inconnue"}` sur une route qui existe dans le code, message d'erreur d'une version antérieure (« connexion Google non configurée » malgré un `.env` correct), comportement « ancien » du serveur, ou un smoke test vert plus tôt qui « ne marche plus » dans le navigateur.
- Ne s'applique pas en production : `npm start` lance un process unique et le décalage n'existe que si on modifie le code sans redéployer.

## Examples

Le cas du 27/08/2026. L'écran « Mes playlists » affiche « route inconnue » à la création et la liste reste sur « Un instant... ». Le code venait d'être smoke-testé vert sur un serveur frais.

Âge du process :

```bash
$ lsof -nP -iTCP:8787 -sTCP:LISTEN
COMMAND   PID              USER   ...
node    89933  leopoldthomasset   ...
$ ps -o pid,etime,command -p 89933
  PID ELAPSED COMMAND
89933   23:25 node ... tsx --env-file-if-exists=.env server/index.ts
```

23 minutes d'uptime, antérieur au commit qui ajoutait les routes playlists.

Preuve discriminante :

```bash
$ curl -s http://localhost:8787/api/history
{"error":"connexion requise"}     # 401 : route connue du process
$ curl -s http://localhost:8787/api/playlists
{"error":"route inconnue"}        # 404 : route inconnue du meme process
```

Le process connaît `/api/history` (livrée avant son démarrage) mais pas `/api/playlists` (livrée après) : il exécute un code entre les deux. Ctrl+C, `npm run dev:server`, et tout fonctionne, vérifié par l'utilisateur.

## Related

- [fly-launch-reecrit-la-config.md](fly-launch-reecrit-la-config.md) : même contrainte de fond — l'état des rooms en mémoire d'un seul process — vue côté deploy (`--ha=false`) ; ici elle est vue côté dev (pas de watch).
