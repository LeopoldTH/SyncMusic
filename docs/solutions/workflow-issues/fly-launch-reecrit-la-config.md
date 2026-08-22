---
title: fly launch réécrit fly.toml et injecte un workflow, relire avant de déployer
date: 2026-08-22
category: workflow-issues
module: deploy
problem_type: workflow_issue
component: infrastructure
severity: high
symptoms:
  - "fly.toml réécrit en entier par fly launch : commentaires supprimés, internal_port passé de 8787 à 80"
  - ".github/workflows/fly-deploy.yml créé sans demande (auto-deploy on push exigeant un secret FLY_API_TOKEN)"
root_cause: missing_workflow_step
resolution_type: config_change
applies_when:
  - "fly launch sur un projet qui a déjà un fly.toml écrit à la main"
  - "deploy Fly.io d'une app dont l'état vit en mémoire d'un seul process (--ha=false obligatoire)"
related_components:
  - development_workflow
tags:
  - fly-io
  - fly-launch
  - fly-toml
  - github-actions
  - deploy
  - single-process-state
---

# fly launch réécrit fly.toml et injecte un workflow : relire avant de déployer

## Context

Déploiement de SyncMusic sur Fly.io le 21/08/2026. Un fly.toml écrit à la main existait déjà : `internal_port = 8787`, variables `ALLOWED_ORIGIN` et `PORT`, `auto_stop_machines`, VM 256mb, avec des commentaires explicatifs. Le serveur écoute sur le port fourni par l'env `PORT`, avec 8787 en défaut (server/index.ts:17, `const PORT = Number(process.env["PORT"] ?? 8787)`), et sert sur ce seul port à la fois le client compilé et les WebSockets. Les rooms vivent en mémoire du process (server/roomRegistry.ts), sans store externe.

Le port unique n'est pas un accident : le serveur a été refondu exprès pour servir l'application et le temps réel ensemble (commit `6c608ec`), d'abord pour l'ère du tunnel ngrok, avec la justification « un seul port, un seul tunnel — c'est aussi la forme qu'aura le vrai déploiement ». Le client dérive son URL WebSocket de l'origine de la page, donc aucune config client par environnement n'est nécessaire. (session history)

En lançant `fly launch --no-deploy` et en répondant « Yes » à « Would you like to use this fly.toml configuration for this app? », on s'attend à ce que le fichier soit repris tel quel. Observé le 21/08/2026 avec flyctl : ce n'est pas le cas.

## Guidance

Après tout `fly launch`, avant de déployer ou de committer, systématiquement :

1. **Relire fly.toml, `internal_port` en premier.** flyctl a réécrit le fichier malgré le « Yes » : commentaires supprimés, et `internal_port` passé de 8787 à 80 sur la foi de son heuristique (« Detected a Vite app », donc site statique supposé sur le port 80). `internal_port` doit rester égal au port que le serveur écoute réellement, ici 8787.

   ```bash
   git diff fly.toml
   ```

   Avant / après la correction :

   ```diff
   [http_service]
   -  internal_port = 80
   +  internal_port = 8787
   ```

2. **Vérifier `git status` pour les fichiers injectés.** fly launch a créé `.github/workflows/fly-deploy.yml` (deploy-on-push utilisant un secret `FLY_API_TOKEN`) sans le signaler clairement. Il a été embarqué dans un commit par un `git add .github` avant d'être repéré dans la sortie du commit (`create mode ... fly-deploy.yml`), puis retiré dans un commit de suivi : sans le secret configuré il échoue en rouge à chaque push, et la CI du projet est volontairement limitée à la vérification (typecheck + tests), le deploy reste manuel.

3. **Déployer avec `--ha=false`.** Le défaut de Fly crée 2 machines pour la haute disponibilité. Les rooms vivant dans la mémoire d'un seul process, deux machines = deux ensembles de rooms disjoints : les participants ne se voient pas. Un avertissement « This organization has no payment method, turning off high availability » est apparu une fois, c'est-à-dire que le comportement HA dépend de l'état de l'organisation : ne pas s'y fier, passer le flag explicitement.

   ```bash
   fly deploy --ha=false
   ```

État corrigé actuel de fly.toml (extrait) :

```toml
[env]
  ALLOWED_ORIGIN = 'https://syncmusic-leopold.fly.dev'
  PORT = '8787'

[http_service]
  internal_port = 8787
```

Vérification post-deploy effectuée : `curl -I https://syncmusic-leopold.fly.dev/` retourne 200 ; le handshake WebSocket retourne 101 avec l'Origin `https://syncmusic-leopold.fly.dev` et 403 avec un Origin étranger.

## Why This Matters

Trois conséquences évitées, toutes silencieuses au moment où fly launch les crée :

- **App morte au premier deploy.** Avec `internal_port = 80`, le proxy de Fly envoie le trafic vers le port 80 où rien n'écoute : page inaccessible et WebSockets morts, alors que le build et le deploy passent au vert.
- **CI rouge à chaque push.** Le workflow injecté échoue en permanence sans le secret `FLY_API_TOKEN`, et contredit le choix du projet de garder le deploy manuel.
- **Rooms en split-brain.** Deux machines HA donnent deux registres de rooms indépendants : un bug d'apparence aléatoire (ça dépend de la machine sur laquelle chaque client atterrit), difficile à diagnostiquer après coup. Le registre (server/roomRegistry.ts) est la seule source de vérité des rooms, en mémoire, avec expiration quand la room se vide ; et l'hypothèse mono-déploiement va jusque dans shared/protocol.ts, qui rejette tout champ inconnu au motif que « les deux navigateurs chargent la même version depuis le même déploiement ». (session history)

## When to Apply

- À chaque exécution de `fly launch`, même avec `--no-deploy` et même en répondant « Yes » à la réutilisation du fly.toml existant.
- Lors d'un rename d'app, d'un changement de région, ou de tout re-launch futur, notamment le chantier comptes/OAuth à venir qui touchera la config Fly (il ajoutera un `BASE_URL` obligatoire et un disque persistant pour SQLite).
- `--ha=false` s'applique tant que l'état (rooms) vit en mémoire d'un seul process ; il ne devient optionnel que si un store partagé remplace roomRegistry.

## Examples

Le diff réel constaté après `fly launch` (avant correction) :

```diff
 [http_service]
-  internal_port = 8787
+  internal_port = 80
```

Le fichier injecté puis retiré :

```
.github/workflows/fly-deploy.yml   # deploy-on-push via secret FLY_API_TOKEN, jamais configuré
```

Séquence de deploy validée :

```bash
git diff fly.toml          # internal_port = 8787 ?
git status                 # pas de .github/workflows/fly-deploy.yml ?
fly deploy --ha=false
curl -I https://syncmusic-leopold.fly.dev/   # attendu: 200
```

## Related

- Première entrée de docs/solutions/ : pas de doc lié existant.
- Docs devenues partiellement obsolètes par le déploiement (candidates à un refresh) : docs/a-faire.md (« U10, déploiement » listé comme restant), docs/plans/2026-08-21-0102-feat-comptes-utilisateurs-plan.md (dépendance U10 levée), docs/ecouter-a-deux.md (le runbook ngrok renvoie à un déploiement « autre étape » qui existe maintenant).
