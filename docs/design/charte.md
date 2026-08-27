# Charte de design — « Console »

Direction retenue le 27/08/2026, après comparaison de trois pistes sur maquettes
(canvas de référence : https://claude.ai/code/artifact/271e2ff7-6a7e-4c81-8ab7-25cc99e93a75 —
les pistes écartées, Cadran et Pochette, y restent consultables en page 2).

## L'idée

L'app est une **machine audio**, pas une page web. Chaque zone de l'écran est un
module posé sur un châssis : cadre net, ombre franche, étiquette gravée en
en-tête. Les boutons sont des boutons physiques qui s'enfoncent. Ce parti pris
vient du produit lui-même — on manipule du son à deux, comme sur du matériel —
et c'est lui qui rend l'app reconnaissable entre toutes.

Deux faces de la même machine :

- **Jour** (défaut) : aluminium clair, encre noire.
- **Nuit** : châssis anodisé noir, pour l'usage « à côté d'un jeu, le soir ».

Le choix vit dans l'écran de compte et se mémorise **par appareil**
(localStorage, comme le réglage de latence). Les deux faces partagent les mêmes
tokens : seules les valeurs changent, aucun composant ne se duplique.

## Tokens

Le bloc de référence, prêt à remplacer le `:root` de `client/styles.css` au
moment du re-skin. La face s'applique via `data-theme="nuit"` sur `<html>`.

```css
:root {
  /* face jour (défaut) */
  --bg: #d7d5cf;        /* le châssis */
  --panel: #e8e6e0;     /* un module */
  --inset: #17161a;     /* un enfoncement: écran vidéo, zone d'affichage */
  --field: #ffffff;     /* un champ de saisie */
  --text: #17161a;
  --muted: #6f6d66;
  --line: #b3b1a9;      /* séparations secondaires */
  --border: #17161a;    /* le cadre des modules et boutons */
  --shadow: #17161a;    /* l'ombre franche */
  --accent: #ff4d00;    /* action primaire, uniquement */
  --accent-press: #c93d00; /* accent pressé/survolé */
  --led: #4ef28a;       /* état de sync/connexion, uniquement */
  --inset-text: #d7d5cf;/* texte posé sur un enfoncement */
  --radius: 0;
}

[data-theme="nuit"] {
  --bg: #141317;
  --panel: #1e1d22;
  --inset: #0b0a0d;
  --field: #0b0a0d;
  --text: #e8e6e0;
  --muted: #8a887f;
  --line: #35333b;
  --border: #3a383f;
  --shadow: #060608;
  --accent-press: #ff7940;
  --inset-text: #e8e6e0;
}
```

`--accent` et `--led` ne changent pas de face : l'orange et la LED verte sont
l'identité, le châssis n'est que le support. Seul l'état pressé/survolé de
l'accent varie : `#c93d00` en jour, `#ff7940` en nuit — aucune autre couleur
dérivée n'est permise.

Deux exceptions au style, volontaires : un identifiant technique (id YouTube)
garde sa casse d'origine même dans un contexte en majuscules, et le contenu de
l'enfoncement écran peut utiliser des gris intermédiaires entre `--inset` et
`--muted` pour ses éléments fantômes.

## Typographie

- **Archivo Black** — le nom de l'app, les titres d'écrans, les grandes valeurs
  (le « 012 MS »). Jamais en dessous de 14px.
- **Chivo Mono** — tout le reste : étiquettes, corps, boutons, chiffres. Les
  étiquettes de modules sont en majuscules, `letter-spacing: 0.2em`,
  10–11px, graisse 700.
- Chargées via Google Fonts. Fallbacks : `sans-serif` pour Archivo Black,
  `monospace` pour Chivo Mono.
- Les accents se gardent sur les majuscules (LÉA, MÊME, CRÉER), et les
  deux-points prennent une espace fine insécable avant (`&#8239;:`).

## Règles de construction

- **Un module** = `background: var(--panel); border: 2px solid var(--border);
  box-shadow: 5px 5px 0 var(--shadow);` (3px sur mobile). En-tête d'étiquette
  séparé par un `border-bottom: 2px solid var(--border)`.
- **Aucun arrondi, nulle part** (`--radius: 0` est une règle, pas un défaut).
- **Un bouton** = un bloc bordé avec une ombre 3px ; au clic il s'enfonce
  (`transform: translate(2px, 2px)` + ombre réduite à 1px). L'action primaire
  est le seul bloc `--accent`.
- **La LED verte est sacrée** : elle ne signale que l'état de synchronisation ou
  de connexion. Tout autre usage est une faute.
- **Icônes en SVG inline uniquement** (stroke ou fill encre), grille 16–24px.
  Jamais d'emoji, jamais de glyphe texte (▶, ↳…) en guise d'icône. Les flèches
  dans un libellé (« ← RETOUR ») sont du texte et restent du texte.
- **L'écart en millisecondes est la signature** : partout où la sync s'affiche,
  le chiffre est en grand (Archivo Black), la LED à côté.
- **Zones tactiles ≥ 44px** sur mobile.
- La **barre de recherche** (chantier suivant) est un module en pointillés
  `border: 2px dashed var(--muted)` tant qu'elle n'est pas livrée, puis un
  module plein comme les autres.

## Interdits

Dégradés, glassmorphism, coins arrondis, ombres floues, emojis, textes gris sur
fond gris sans contraste vérifié, toute couleur hors tokens. Si un nouvel écran
a besoin d'une couleur qui n'existe pas ici, c'est la charte qu'on discute, pas
une exception qu'on glisse.

## État d'application

La charte est figée ; le code de `client/styles.css` est encore sur l'ancien
thème sombre. Le re-skin est un chantier à part entière (tous les composants),
à mener avant ou avec la barre de recherche pour qu'elle naisse déjà habillée.
