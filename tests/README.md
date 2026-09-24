# Tests automatiques de Folio

Les tests pilotent le vrai éditeur (`public/web-editor.html`) dans Chromium, avec une
fausse API (crédits, sessions, paiement) : aucun accès réseau ni compte Stripe/Supabase
n'est nécessaire. Ce dossier n'est pas déployé sur Vercel (`.vercelignore`).

## Lancer les tests

```bash
cd tests
npm ci
npx playwright install chromium   # une seule fois
npm test                          # toutes les suites (~4 min)
npm test -- structure             # une suite précise (filtre sur le nom)
```

Chaque ligne `✔` / `✘` est une vérification ; le résumé final liste les suites et le
code de sortie vaut 1 en cas d'échec. Les PDF exportés pendant les tests sont écrits dans
`tests/.output/` (ignoré par Git) pour pouvoir les ouvrir en cas d'échec.

## Suites

| Suite | Ce qui est vérifié |
|---|---|
| `api` | `/api/status`, `consume`, `checkout`, `webhook` : injections d'UID refusées, crédits atomiques, webhook rejoué sans double crédit, sessions signées, limite des sessions gratuites par IP |
| `open` | 17 PDF difficiles s'ouvrent : protégés (RC4, AES-128/256, mot de passe), tronqués, arbre de pages corrompu, en-tête décalé, > 3,5 Mo, A0, rotation, formulaires |
| `edit` | détection du fond et de la couleur du texte, police d'origine, Unicode (ł, cyrillique, →), zoom sans décalage, export |
| `form` | champs AcroForm (texte, case, radio, liste, multiligne) remplis nativement, texte libre, PDF sans `/DA` |
| `geometry` | aperçu = export sur page pivotée à 90°, page recadrée (CropBox) et page normale |
| `annotations` | surligneur adapté aux fonds sombres, cadre, stylo, note, cache, gomme, annulation |
| `sign` | signature dessinée / tapée / image (WebP), déplacement, suppression, pipette |
| `misc` | PDF chiffrés exportés sans mot de passe, export de secours en images, extraire, fusionner (fichiers protégés et abîmés), 6 conversions, restauration après rechargement |
| `payment` | UID (format, cookie de secours, restauration), 1 crédit par document, jeton de session falsifié refusé, paiement Stripe, accès à vie, limitation de débit |
| `structure` | **32 tableaux et mises en page** (voir ci-dessous) |

## Suite « structure » : tableaux et mises en page

`fixtures/tables/` contient 32 PDF avec leur « vérité terrain » (`.json` : texte et
position de chaque cellule) :

- `a*` — PDF écrits directement : grilles serrées ou larges, sans bordures, filets
  horizontaux, lignes zébrées, en-tête sombre, filets verticaux seuls, cellules
  colorées, cellules dans un seul `TJ`, texte glyphe par glyphe, colonnes à chasse fixe,
  paragraphe justifié, deux colonnes, libellé / valeur ;
- `b*` — tableaux HTML imprimés par Chromium (bordures fusionnées, marges serrées,
  zébrures, facture, cellules colorées, police serif, styles mélangés, tableaux côte à côte) ;
- `c*` — documents Word et Excel convertis par LibreOffice ;
- `d*` — tableau en paysage (`/Rotate 90`) et facture mixte.

Pour chaque fichier :

1. **Détection** : chaque cellule doit donner exactement un bloc de texte, jamais fusionné
   avec la cellule voisine ni coupé (une cellule que l'auteur a répartie sur deux lignes
   donne un bloc par ligne).
2. **Modification** : plusieurs cellules sont modifiées (texte plus long ou plus court),
   puis le PDF exporté est comparé pixel par pixel à l'original. Les bordures du tableau
   doivent être intactes, et ni les autres textes ni les autres cellules ne doivent changer.
3. **Propriétés** : les mêmes cellules sont modifiées une seconde fois, en changeant aussi
   la taille de police (×1,6 à ×3), la police, la couleur du texte, le fond et la couleur
   de masquage. Les contrôles au pixel près sont les mêmes. La suite vérifie aussi qu'une
   police agrandie l'est vraiment quand la cellule a de la place.

## Ajouter des PDF de test

- Déposer un PDF dans `fixtures/pdfs/` : il est automatiquement testé par la suite `open`.
- Pour un tableau, ajouter un générateur dans `generators/` (ou un PDF avec son `.json`
  dans `fixtures/tables/`) : la suite `structure` le prend en compte automatiquement.

Régénérer toutes les fixtures (nécessite Python avec `reportlab`, `pikepdf`,
`python-docx`, `openpyxl`, ainsi que LibreOffice) :

```bash
pip install reportlab pikepdf python-docx openpyxl
npm run fixtures
```
