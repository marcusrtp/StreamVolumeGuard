# Contrat De Stabilite - StreamVolume Guard

Ce document sert a reprendre le projet sans casser la base validee. Il ne decrit pas une nouvelle fonctionnalite : il fige les comportements critiques a proteger.

## 1. Contrat Audio A Ne Pas Casser

Page de test locale, source brute :

- `Son faible` : environ `-63 dB RMS`.
- `Son fort` : environ `-43 dB RMS`.
- `Son tres fort` : environ `-4 dB RMS`, avec environ `-1 dB` de marge sous le pic numerique maximum.

Avec l'extension active sur l'onglet de test :

- les trois sons doivent finir proches de `-21 dB RMS` avec le profil Stream ;
- le `Peak OBS estime` doit rester proche de `-18 dB` ;
- l'ecart RMS max attendu apres stabilisation est `0.5 dB` ;
- l'ecart Peak OBS max attendu apres stabilisation est `1.5 dB` ;
- le son faible ne doit pas monter au-dessus des autres avant de redescendre ;
- le son tres fort ne doit pas chuter durablement sous les autres ;
- les changements de niveau ne doivent pas creer de grésillement evident.

Interpretation importante :

- `Avant brut` contourne volontairement l'extension et doit faire entendre une grosse difference entre faible, fort et tres fort.
- `Avec extension`, `Alternance` et les boutons principaux avec l'extension active doivent au contraire finir presque au meme volume.

## 2. Fichiers Critiques

Sources de verite a lire avant de modifier le comportement audio :

- `audio/normalizer.js` : gain automatique, rampes, corrections de sortie et anti-clic.
- `audio/analyser.js` : calcul RMS et peak.
- `audio/limiter.js` : limiteur de securite.
- `audio/stream-status.js` : etat Safe / Warning / Risky.
- `storage/settings.js` : profils, cibles RMS, limites et migrations.
- `content.js` : detection media, activation, refresh des reglages.
- `test-page.html` : sons de test et UX de validation locale.
- `tests/technical-smoke.html` et `tests/browser-smoke.js` : validation navigateur reelle.

Ne pas utiliser comme source de verite principale :

- `dist/` : genere par `node tools/build-targets.js`.
- `release-assets/` : genere par `node tools/package-release.js`.
- `graphify-out/` : genere par `graphify update .`.

## 3. Regles Avant Toute Modification Audio

- Ne pas changer les niveaux bruts `-63 / -43 / -4 dB RMS` sans modifier les tests, la page de test et le README ensemble.
- Ne pas modifier `createMediaElementSource()` pour un media deja traite.
- Ne pas ajouter de dependance ou de build tool pour corriger un probleme local.
- Ne pas masquer un probleme audio par un texte ou une tolerance plus large.
- Toujours verifier la source et `dist/chromium` avant d'annoncer que le pipeline est stable.

## 4. Verification Complete

Depuis le dossier du projet :

```powershell
node tests/unit.test.js
node --check background.js
node --check content.js
node --check popup/popup.js
node --check options/options.js
node --check audio/normalizer.js
node tests/browser-smoke.js
node tools/build-targets.js
node tests/build-targets.test.js
node tests/dist-packages.test.js
node tests/branding.test.js
$env:WLG_EXTENSION_DIR="chemin vers StreamVolume Guard\dist\chromium"
node tests/browser-smoke.js
git diff --check
graphify update .
```

Le smoke test navigateur est obligatoire pour tout changement audio. Les tests unitaires seuls ne suffisent pas.

## 5. Controle Privacy Et Publication

Avant de partager un build :

- verifier qu'aucun tracker, endpoint analytics ou telemetrie automatique n'a ete ajoute ;
- verifier que les diagnostics restent locaux et exportes volontairement ;
- verifier que les zips publics ne contiennent pas `.git`, `.codex`, `.agents`, `graphify-out` ou `release-assets` ;
- ne pas creer de tag ou de release GitHub sans demande explicite du mainteneur.

## 6. Checklist De Reprise Rapide

- [ ] Lire `AGENTS.md`.
- [ ] Lire `graphify-out/GRAPH_REPORT.md` si disponible.
- [ ] Identifier les fichiers reels concernes avant d'ouvrir `dist/`.
- [ ] Lancer `node tests/unit.test.js`.
- [ ] Si le comportement audio change, lancer `node tests/browser-smoke.js`.
- [ ] Regenerer `dist/` si une source distribuee a change.
- [ ] Lancer le smoke sur `dist/chromium`.
- [ ] Mettre a jour `CHANGELOG.md` pour tout changement visible testeur.
