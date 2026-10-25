# AltiCorrige

PWA de **correction des altitudes** de tracés GPS (GPX, KML, KMZ) à partir du service public d’altimétrie de l’IGN (Géoplateforme – RGE ALTI).

## Fonctionnalités

- Import **GPX**, **KML** ou **KMZ**
- Correction des altitudes via `https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json` (ressource `ign_rge_alti_wld`)
- Traitement par lots (respect de la limite ~5 req/s)
- Profil altimétrique interactif
- Calcul des **dénivelés + et −**
- Export du tracé corrigé en **`xxx_corr.gpx`** ou **`xxx_corr.kml`**
- PWA installable, service worker avec **cache-busting**

## Déploiement GitHub Pages

1. Créer un dépôt GitHub (ex. `alticorrige`).
2. Pousser le contenu de ce dossier à la racine (ou dans `/docs`).
3. Dans **Settings → Pages** : source = branche `main` (ou `gh-pages`), dossier `/` (ou `/docs`).
4. L’application sera disponible à `https://<user>.github.io/alticorrige/`.

Fichier `.nojekyll` inclus pour éviter le traitement Jekyll.

### Mise à jour du service worker

À chaque déploiement, modifier la constante `CACHE_VERSION` dans `sw.js` (ou laisser la date du jour déjà incluse) pour forcer le renouvellement du cache côté clients.

## Utilisation locale

Servir le dossier en HTTPS ou localhost (requis pour le service worker et certaines APIs) :

```bash
npx serve .
# ou
python3 -m http.server 8080
```

## Licence

Code libre. Les données altimétriques restent sous licence IGN / open data Géoplateforme.
