# Changelog

Toutes les modifications notables de StreamVolume Guard sont documentées ici.

Le changelog public est volontairement consolidé : les micro-corrections faites avant la première vraie publication sont regroupées dans des versions lisibles pour les testeurs.

## Non publié

### Corrigé

- Ajout d'un garde-fou contre les pics transitoires au début des changements de niveau dans le smoke test navigateur.
- Stabilisation du ducking de transition du normalizer avec des constantes nommées, pour conserver la protection anti-pic sans laisser passer de sursaut audible.
- Lissage des grands boosts vers un son faible pour éviter qu'il monte trop haut avant de redescendre.
- Resserrement du trim de sortie et du smoke test pour vérifier une égalisation plus proche de la cible pendant l'écoute.
- Export diagnostic enrichi avec une synthèse streamer exploitable, sans URL complète ni titre de page.
- Ajout d'un indicateur de qualité dans l'export diagnostic pour savoir si le fichier est exploitable ou incomplet.
- Ajout d'un test streamer guidé dans la page locale pour valider rapidement faible, fort et très fort avant un live.
- Ajout de la page de test et des guides testeurs essentiels dans les distributions publiques.
- Clarification du README pour guider les débutants vers les fichiers `.zip` de la release GitHub.
- Profils par plateforme clarifiés dans les options avec badge recommandé/personnalisé et sélection plus explicite.

## [0.1.3] - 2026-06-27

### Corrigé

- Stabilisation de la page de test audio brute : les boutons `Son faible`, `Son fort` et `Son très fort` utilisent désormais un seul WAV continu avec segments internes.
- Suppression du changement de source audio entre `Son très fort` et `Son fort`, pour réduire les grésillements audibles sans extension activée.
- Ajout de fondus et de protections contre les clics rapides sur la page de test.
- Alignement du smoke test navigateur avec les niveaux encodés dans les WAV, au lieu d'utiliser `audio.volume` pour simuler les écarts.

### Vérification

- Tests unitaires Node.
- Smoke test navigateur réel avec extension chargée.
- Tests de packaging multi-navigateurs.
- Builds Chromium, Firefox, Firefox Android et source Safari régénérés.

## [0.1.2] - 2026-06-26

### Ajouté

- Builds prêts à tester pour Chromium, Firefox, Firefox Android et source Safari.
- Notes de release publiques réutilisables dans `store/release-0.1.2.md`.
- Fallback manuel `Capture onglet` sur Chromium desktop avec document offscreen.
- Mode Panic pour baisser immédiatement le niveau d'un onglet actif.
- Profils recommandés par plateforme : YouTube, Twitch, TikTok, Kick, Spotify web et Deezer web.
- Profils locaux par domaine, sans compte utilisateur, sans serveur et sans synchronisation.
- Profil OBS recommandé.
- Page de test locale avec sons faible, fort et tres fort.
- Bloc de résultats live sur la page de test : cible, gain, RMS brut, sortie traitée, risque, médias et pics contenus.
- Slider `Volume moyen voulu` dans les Options, avec plage étendue jusqu'à `-36 dB`.
- Export diagnostic JSON local depuis les Options pour aider les testeurs a reporter un bug manuellement.

### Corrigé

- Correction du cas où l'activation pouvait couper le son d'un onglet déjà en lecture.
- Reconfiguration des pipelines audio existants quand les réglages changent, sans recréer `createMediaElementSource()`.
- Application explicite des réglages via le bouton `Appliquer les réglages`, avec retour visuel après envoi aux onglets ouverts.
- Propagation des changements de cible RMS aux onglets déjà traités.
- Stabilisation de l'égalisation entre les sons faible, fort et très fort sur la page de test.
- Ajout de micro-rampes de volume sur la page de test et dans le pipeline audio pour réduire les clics entre les niveaux.
- Remise à zéro rapide de la correction de sortie après un gros changement de niveau, pour éviter qu'un son faible reste trop bas après un son très fort.
- Alignement du champ `Cible RMS dB` avec la limite réelle `-14 dB` déjà appliquée par le slider.
- Restriction du message local `WLG_TEST_PAGE_STATUS` à l'origine de la page de test au lieu d'un `postMessage` global.
- Protection contre le double traitement d'un meme element audio ou video.
- Respect des domaines exclus, y compris avec la capture d'onglet.
- Arret de la capture d'onglet lors d'une navigation ou fermeture d'onglet.
- Textes Options et popup clarifiés en français et anglais.

### Confidentialité

- Aucun tracker.
- Aucune télémétrie automatique.
- Aucune collecte d'audio, d'historique, de titre de page ou d'URL complete.
- Diagnostic généré localement et partagé uniquement si l'utilisateur l'exporte volontairement.
- Les manifests Firefox déclarent explicitement `data_collection_permissions.required = ["none"]`.

### Vérification

- Tests unitaires Node.
- Smoke test navigateur réel sur Chromium avec extension chargée depuis `dist/chromium`.
- Tests de packaging multi-navigateurs.
- Test de cohérence branding et textes publics.
- Controle des permissions et absence d'appel reseau produit.

### Pourquoi

Cette version est la première base publique crédible pour testeurs : elle regroupe la stabilisation audio, les options essentielles, les builds multi-navigateurs et les diagnostics locaux sans multiplier les numéros de version visibles.

## [0.1.1] - 2026-06-25

### Ajouté

- Documentation d'installation pour Chrome, Brave, Firefox, Firefox Android et source Safari.
- README réorganisé pour favoriser l'adoption : promesse streamer, confiance, installation, tests, limites et roadmap.
- Checklist testeur publique pour guider les retours audio et les diagnostics.
- Roadmap d'implémentation priorisée pour les prochaines fonctions.
- Description courte GitHub et éléments de présentation pour Discord.
- Social preview GitHub `assets/social-preview.png`.
- Regle de maintenance : tout changement public doit verifier si `CHANGELOG.md` doit etre mis a jour.

### Changé

- Renommage public du projet vers StreamVolume Guard avec identite Guard Signal.
- Positionnement privacy-first : open source, sans tracker et sans collecte de donnees.
- Chemins d'installation generiques avec `chemin vers StreamVolume Guard`, sans chemin personnel.

### Pourquoi

Cette version prépare le projet pour un dépôt public propre : compréhensible, testable et partageable sans exposer de données privées.

## [0.1.0] - 2026-06-25

### Ajouté

- Première version MVP de StreamVolume Guard.
- Extension Chromium Manifest V3.
- Détection des éléments HTML `video` et `audio`.
- Normalisation audio locale via Web Audio API.
- Analyse RMS approximative.
- Gain automatique lissé.
- Reduction rapide des sons trop forts.
- Remontée progressive des sons faibles.
- Compresseur doux.
- Limiteur de sécurité autour de `-1 dB`.
- Profils Doux, Normal, Stream, OBS recommandé et Nuit.
- Popup avec ON/OFF, site actif, profil actif, gain actuel et diagnostics.
- Page Options.
- Stockage local avec `chrome.storage.local`.
- Liste d'exclusion de domaines.
- Architecture séparée dans `audio/`, `popup/`, `options/`, `storage/`, `license/`, `tests/` et `docs/`.
- Module `license/capabilities.js` pour garder une séparation propre avec de futures capacités avancées.

### Confidentialité

- Traitement audio local sur la machine de l'utilisateur.
- Aucun backend.
- Aucune dependance payante.
- Aucun compte utilisateur.
- Aucune collecte inutile de donnees.

### Pourquoi

Cette version pose le coeur du produit : aider les streamers à réduire les écarts de volume et les pics audio dans le navigateur, avec un traitement local, lisible et maintenable.
