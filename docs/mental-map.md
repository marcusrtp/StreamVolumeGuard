# StreamVolume Guard - Mindmap de maintenabilité

```mermaid
graph TD
  A0[StreamVolume Guard] --> A1[Architecture]
  A0 --> A2[Fonctionnalités]
  A0 --> A3[Flux audio]
  A0 --> A4[Sécurité et conformité]
  A0 --> A5[Maintenabilité]
  A0 --> A6[Roadmap]

  A1 --> A1a[Manifest V3]
  A1 --> A1b[background.js]
  A1 --> A1c[content.js]
  A1 --> A1d[offscreen fallback]
  A1 --> A1e[storage/settings.js]
  A1a --> A1a1[Permissions minimales]
  A1b --> A1b1[État actif / profils / exclusions]
  A1b --> A1b2[Panic mode / statut global]
  A1c --> A1c1[Scan vidéo/audio]
  A1c --> A1c2[Cycle de vie des pipelines]
  A1c --> A1c3[Publication du status local]

  A2 --> A2a[Popup]
  A2 --> A2b[Options]
  A2 --> A2c[Page test]
  A2 --> A2d[Profils]
  A2 --> A2e[Réglages]
  A2a --> A2a1[ON/OFF]
  A2a --> A2a2[Etat Safe/Warning/Risky]
  A2a --> A2a3[Pics bloqués]
  A2b --> A2b1[Liste d\'exclusion domaines]
  A2b --> A2b2[Volume cible et boosts]
  A2b --> A2b3[Profils plate-formes]
  A2b --> A2b4[Aide + i18n]
  A2c --> A2c1[Alternance faible / fort / tres fort]
  A2c --> A2c2[Dashboard RMS + pic]
  A2c --> A2c3[Checklist stream]
  A2d --> A2d1[Doux]
  A2d --> A2d2[Normal]
  A2d --> A2d3[Stream]
  A2d --> A2d4[Night]
  A2e --> A2e1[chrome.storage.local]
  A2e --> A2e2[Sauvegarde + reprise]

  A3 --> A3a[audio/analyser.js]
  A3 --> A3b[audio/normalizer.js]
  A3 --> A3c[audio/limiter.js]
  A3 --> A3d[audio/stream-status.js]
  A3a --> A3a1[RMS + peak]
  A3b --> A3b1[Gain auto progressif]
  A3b --> A3b2[Compresseur doux]
  A3b --> A3b3[Limiter anti clipping]
  A3b --> A3b4[Contrat -63/-43/-4 vers -21 RMS]
  A3c --> A3c1[Tentative anti saturation]
  A3d --> A3d1[Safe, Warning, Risky]

  A4 --> A4a[No Tracker]
  A4 --> A4b[Traitement local]
  A4 --> A4c[Open source lisible]
  A4 --> A4d[Pas de collecte perso]

  A5 --> A5a[Tests]
  A5 --> A5b[Graphify]
  A5 --> A5c[Packaging]
  A5 --> A5d[Docs]
  A5a --> A5a1[unit.test.js]
  A5a --> A5a2[browser-smoke.js]
  A5a --> A5a3[build-targets.test.js]
  A5a --> A5a4[dist-packages.test.js]
  A5a --> A5a5[branding.test.js]
  A5b --> A5b1[graphify-out/GRAPH_REPORT.md]
  A5b --> A5b2[graphify-out/graph.html]
  A5c --> A5c1[tools/build-targets.js]
  A5c --> A5c2[dist/chromium, dist/firefox, mobile]
  A5d --> A5d1[README + guides]
  A5d --> A5d2[CHANGELOG]
  A5d --> A5d3[docs/mental-map.md]
  A5d --> A5d4[docs/maintenance-checklist.md]

  A6 --> A6a[Premium(verrouillage futur)]
  A6 --> A6b[Profils par plateforme]
  A6 --> A6c[TabCapture enrichi]
  A6 --> A6d[Mode Speech Priority]
  A6 --> A6e[Raccourcis clavier avancés]
  A6 --> A6f[Sync réglages]
  A6 --> A6g[Calibration OBS]

  classDef core fill:#1f4e79,stroke:#0f2e4a,color:#fff;
  classDef features fill:#2f6f44,stroke:#0f3d28,color:#f8fff9;
  classDef audio fill:#4b7dba,stroke:#244a74,color:#f7fbff;
  classDef safety fill:#b35a00,stroke:#6f3600,color:#fff9ea;
  classDef maintain fill:#8a5a44,stroke:#5a3b2a,color:#fffaf4;
  classDef roadmap fill:#6b46c1,stroke:#3e2478,color:#f8f5ff;

  class A1,A1a,A1b,A1c,A1d,A1e,A1a1,A1b1,A1b2,A1c1,A1c2,A1c3 core;
  class A2,A2a,A2b,A2c,A2d,A2e,A2a1,A2a2,A2a3,A2b1,A2b2,A2b3,A2b4,A2c1,A2c2,A2c3,A2d1,A2d2,A2d3,A2d4,A2e1,A2e2 features;
  class A3,A3a,A3b,A3c,A3d,A3a1,A3b1,A3b2,A3b3,A3b4,A3c1,A3d1 audio;
  class A4,A4a,A4b,A4c,A4d safety;
  class A5,A5a,A5b,A5c,A5d,A5a1,A5a2,A5a3,A5a4,A5a5,A5b1,A5b2,A5c1,A5c2,A5d1,A5d2,A5d3,A5d4 maintain;
  class A6,A6a,A6b,A6c,A6d,A6e,A6f,A6g roadmap;
```

## Légende visuelle
- Bleu foncé: cœur architecture et flux interne.
- Vert: fonctionnalités actives et livrées.
- Bleu clair: pipeline audio et traitements.
- Orange: sécurité conformité privacy.
- Brun: stabilité / maintenabilité.
- Violet: roadmap premium et évolutions.

## Ingrédients techniques complets
- Détection média avec un seul pipeline par élément.
- Gain automatique basé sur le niveau RMS estimé.
- Règles anti-clic (duck + rampes).
- Réduction de pics avec limiter dédié.
- Contrat audio documenté pour ne pas casser les niveaux validés.
- Statut temps réel (rms, peak, risk).
- Liste d'exclusion et gestion par domaine.
- Popup status + options + page test + mode panic.
- Export diagnostic local et documentation publique.
