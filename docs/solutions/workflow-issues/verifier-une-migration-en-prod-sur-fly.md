---
title: "Vérifier une migration en production sur Fly : la machine dort, et l'image n'a pas sqlite3"
date: 2026-09-14
category: workflow-issues
module: deploy
problem_type: workflow_issue
component: infrastructure
severity: medium
symptoms:
  - "« app has no started VMs » après un déploiement réussi, identique au message affiché quand le déploiement n'est pas encore fini"
  - "`exec: \"sqlite3\": executable file not found in $PATH` sur fly ssh console"
  - "compte de lignes qui ne correspond pas au chiffre noté dans le plan, sans qu'aucune ligne n'ait été perdue"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
applies_when:
  - "déploiement Fly d'une app en auto_stop_machines avec min_machines_running = 0"
  - "migration de schéma SQLite appliquée au démarrage, sur un volume durable"
  - "inspection de la base de production depuis une image de conteneur sans binaire sqlite3"
related_components:
  - database
  - development_workflow
tags:
  - fly-io
  - auto-stop
  - migration
  - sqlite
  - user-version
  - post-deploy
  - runbook
---

# Vérifier une migration en production sur Fly : la machine dort, et l'image n'a pas sqlite3

## Context

SyncMusic tourne sur une seule machine Fly, avec une base SQLite sur un volume durable (`DB_PATH = '/data/syncmusic.db'`, fly.toml). Les migrations sont un tableau ordonné appliqué au démarrage : `MIGRATIONS` (server/db.ts:26), comparé à `PRAGMA user_version` (server/db.ts:329), chaque script dans sa transaction, la version passant à `index + 1` (server/db.ts:339). `openDatabase` est appelé à l'initialisation du module (server/index.ts:131), donc bien avant `http.listen` (server/index.ts:844) : **si une migration lève, le process s'arrête avant d'écouter le port**. Une seule machine, donc l'application est indisponible jusqu'au redéploiement de la version précédente.

Le 14/09/2026, la PR #3 (« mémoire des écoutes ») a livré la migration 2 : cinq colonnes nullables ajoutées à `history_entries`, un `UPDATE` de backfill, et deux index. Elle a été mergée et déployée par la CI. Il fallait vérifier en production que `user_version` valait bien 2, que le backfill était complet et qu'aucune ligne n'avait disparu.

Deux pièges ont bloqué cette vérification coup sur coup. Aucun n'est un échec de déploiement, et les deux ressemblent à un.

## Guidance

### 1. « has no started VMs » ne dit rien sur la santé du déploiement

`fly ssh console` exige une machine démarrée. Or fly.toml porte `auto_stop_machines = 'stop'`, `auto_start_machines = true` et `min_machines_running = 0` : la machine s'éteint dès qu'elle est inactive. Le même message apparaît donc dans deux situations opposées :

```
Error: app syncmusic-leopold has no started VMs.
It may be unhealthy or not have been deployed yet.
```

- **avant** que le déploiement soit fini (on est simplement trop tôt) ;
- **après** un déploiement parfaitement réussi (la machine s'est déjà rendormie).

Le texte suggère « unhealthy or not deployed » dans les deux cas. Il est trompeur dans le second.

**Le discriminant n'est pas `STATE`, c'est `VERSION`.** `fly status` donne le numéro d'image de la machine :

```bash
fly status -a syncmusic-leopold
```

Une VERSION inchangée signifie qu'on interroge encore l'ancien code, et toute vérification faite là ne veut rien dire. Une VERSION incrémentée avec un `LAST UPDATED` du jour prouve que le nouveau code a démarré — donc que la migration s'est exécutée sans lever, puisque sinon le process se serait arrêté avant d'écouter.

### 2. Réveiller la machine par une requête, pas par `fly machine start`

L'auto-start existe précisément pour ça. Une requête HTTP ordinaire réveille la machine **et** vérifie la santé de l'app dans le même geste :

```bash
curl -s -o /dev/null -w "%{http_code} en %{time_total}s\n" --max-time 90 https://syncmusic-leopold.fly.dev/
```

Mesuré le 14/09/2026 : `200` en 10,5 s à froid. Un démarrage à froid dépasse largement le délai par défaut de curl, d'où le `--max-time` généreux : sans lui, un timeout se lit comme une app morte.

### 3. L'image n'a pas `sqlite3`, passer par `node:sqlite`

L'image du conteneur est une image Node. `fly ssh console -C "sqlite3 ..."` échoue :

```
exec: "sqlite3": executable file not found in $PATH
```

Le projet utilise déjà `node:sqlite` (le module SQLite intégré à Node), disponible dans l'image. **Ouvrir en lecture seule** pour ne rien verrouiller ni créer de fichiers WAL sur la base de production :

```bash
fly ssh console -a syncmusic-leopold -C "node -e \"const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/syncmusic.db',{readOnly:true});console.log(JSON.stringify(d.prepare('PRAGMA user_version').get()))\""
```

Deux détails de quoting, sans lesquels la commande est inécrivable :

- la commande traverse **deux** shells (le local, puis celui de la machine). Guillemets doubles échappés à l'extérieur pour `node -e`, guillemets simples à l'intérieur pour le JavaScript et le SQL ;
- **`char(35)` remplace `'#'`** dans le SQL. Un apostrophe littéral dans la requête entre en collision avec les guillemets simples du script. `char(35)` est le même caractère, sans le conflit.

### 4. Les requêtes de contrôle, et ce qu'elles signifient

```sql
PRAGMA user_version                                    -- doit valoir le numéro de la migration livrée
SELECT COUNT(*) FROM history_entries                    -- ne doit jamais avoir baissé
SELECT COUNT(*) FROM history_entries
  WHERE room_instance_id IS NULL
    AND instr(room_item_key, char(35)) > 1              -- doit valoir 0 : backfill complet
```

Le compte de lignes se compare au **compte relevé juste avant le déploiement**, pas à un chiffre noté dans un plan des semaines plus tôt. Le 14/09/2026 il valait 17 alors que le plan disait 3 : la différence venait des tests du propriétaire entre-temps, pas de la migration. Une migration qui ajoute des colonnes n'ajoute ni ne retire jamais de lignes, donc seule une **baisse** est un signal.

Vérifier aussi le taux de remplissage des nouvelles colonnes, pour ne pas confondre « la migration a raté » avec « ces colonnes ne se remplissent que sur une nouvelle écriture » :

```sql
SELECT COUNT(*) AS total,
       SUM(listened_ms IS NOT NULL) AS avec_duree,
       SUM(room_instance_id IS NOT NULL) AS avec_instance
FROM history_entries
```

### 5. Sauvegarde : le volume est snapshoté tout seul

Fly prend un snapshot quotidien du volume, rétention 5 jours. Un instantané délibéré juste avant le merge reste utile pour la traçabilité, et **ne demande pas de machine démarrée** :

```bash
fly volumes list -a syncmusic-leopold          # récupérer l'identifiant du volume
fly volumes snapshots list <vol_id>            # voir les snapshots automatiques et leurs dates
fly volumes snapshots create <vol_id>
```

Un snapshot pris pendant que la machine est arrêtée est cohérent par construction : rien n'écrit dans la base.

## Why This Matters

Le coût d'une mauvaise lecture est asymétrique. « has no started VMs » lu comme un échec de déploiement conduit au geste prévu par le plan de retour arrière : redéployer l'image précédente. On annule alors un déploiement parfaitement sain, sur une application mono-machine, donc avec une coupure — pour un message qui ne disait rien d'autre que « personne n'utilisait l'app depuis un moment ».

L'inverse est aussi possible et plus grave : interroger la base **avant** que le déploiement soit terminé, voir `user_version = 1`, et conclure que la migration a échoué alors qu'elle n'avait simplement pas encore tourné.

La distinction n'est visible nulle part dans le message d'erreur. Elle l'est dans `fly status`, en une ligne.

Ces trois pièges appartiennent à la même famille que les deux learnings voisins : **le process interrogé n'est pas celui qu'on croit**. En dev c'est un serveur tsx démarré avant le code testé ; en déploiement c'est une machine encore sur l'ancienne image, ou éteinte.

## When to Apply

- Après tout déploiement portant une nouvelle entrée dans `MIGRATIONS` (server/db.ts). La migration 3 est déjà anticipée, pour nettoyer les noms de chaîne YouTube portant le suffixe « - Topic » : une migration livrée ne se modifie jamais, on en ajoute une.
- Dès qu'une commande `fly ssh` échoue sur « has no started VMs » : regarder `fly status` avant de conclure quoi que ce soit.
- Pour toute inspection de la base de production, y compris hors migration.
- Ne s'applique pas en dev local, où `data/syncmusic.db` est accessible directement — mais ce fichier est la base de test réelle du propriétaire, à ne pas ouvrir sans raison.

## Examples

Séquence complète du 14/09/2026, après le merge de la PR #3.

**Trop tôt.** La CI tournait encore ; la machine était sur la version 21, celle de la veille :

```
 PROCESS │ ID             │ VERSION │ STATE   │ LAST UPDATED
 app     │ 82205da7903908 │ 21      │ stopped │ 2026-09-13T13:31:45Z
```

**Après le déploiement.** Même `STATE stopped`, mais la version a bougé :

```
 PROCESS │ ID             │ VERSION │ STATE   │ LAST UPDATED
 app     │ 82205da7903908 │ 22      │ stopped │ 2026-09-14T08:50:10Z
```

Seule cette ligne distingue les deux situations. L'état `stopped` est identique.

**Réveil et santé :**

```
accueil: HTTP 200 en 10.480709s
api/stats sans session: HTTP 401
```

Le 401 est le bon résultat : la route existe et refuse l'accès, elle ne plante pas.

**Vérification du schéma :**

```json
{"version":{"user_version":2},"lignes":{"n":17},"backfill_manquant":{"n":0}}
```

**Remplissage des nouvelles colonnes :**

```json
{"total":17,"avec_duree":0,"avec_artiste":0,"avec_genres":0,"avec_instance":17,"dernier":1788541650575}
```

Lecture : `avec_instance` à 17 sur 17 prouve que le backfill a tourné, c'était le seul calcul que la migration avait à faire. Les autres colonnes à zéro ne sont pas un échec : elles ne se remplissent que sur une écoute postérieure au déploiement. `dernier` converti donne le 04/09/2026, soit dix jours avant — confirmation qu'aucune écoute n'avait encore emprunté le nouveau chemin, et que la vérification de bout en bout restait à faire.

## Related

- [serveur-dev-tsx-sans-watch-code-perime.md](serveur-dev-tsx-sans-watch-code-perime.md) : même famille de piège, vue côté dev. Là-bas on interroge un process tsx démarré avant le code testé ; ici une machine encore sur l'ancienne image. Dans les deux cas la première question n'est pas « où est mon bug » mais « quel process réponds-je, et de quand date-t-il ».
- [fly-launch-reecrit-la-config.md](fly-launch-reecrit-la-config.md) : l'autre moitié du runbook de déploiement. Il couvre ce qu'il faut relire *avant* de déployer (`internal_port`, workflow injecté, `--ha=false`) et sa vérification post-deploy s'arrête à la surface HTTP : `curl -I` à 200 et le handshake WebSocket. Ce doc-ci prend la suite au niveau de la base.
- Aucune procédure de vérification de migration n'existait dans le dépôt avant ce doc : recherche faite le 14/09/2026 sur `docs/`, `README.md`, `.github/`, `fly.toml` et `package.json`. Le dépôt n'a pas d'issues GitHub ouvertes ou fermées.
- Candidat à un pointeur : `docs/a-faire.md:54` renvoie aux « gotchas du deploy » de fly-launch uniquement.
