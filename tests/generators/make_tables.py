# Corpus "structure": tableaux et mises en page variés, avec vérité terrain.
# Coordonnées de la vérité terrain en unités de page (pu) : origine en haut à gauche, y vers le bas.
import json, os, random, pikepdf
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib.colors import HexColor, white, black
from reportlab.pdfbase.pdfmetrics import stringWidth

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'fixtures', 'tables')
W, H = A4
random.seed(7)
FIRST = ['Jean', 'Marie', 'Paul', 'Lucie', 'Hugo', 'Emma', 'Louis', 'Chloé', 'Nina', 'Tom']
LAST = ['Dupont', 'Martin', 'Bernard', 'Petit', 'Durand', 'Leroy', 'Moreau', 'Simon']
CITY = ['Paris', 'Lyon', 'Nantes', 'Lille', 'Brest', 'Nice', 'Metz', 'Rouen']
def cellvals(n_rows):
    rows = [['Ref', 'Client', 'Ville', 'Qté', 'Montant']]
    for i in range(n_rows):
        rows.append([f'A{100+i}', f'{random.choice(FIRST)} {random.choice(LAST)}', random.choice(CITY),
                     str(random.randint(1, 99)), f'{random.randint(10, 9999)},{random.randint(10,99)} €'])
    return rows

class Doc:
    def __init__(self, name):
        self.name = name; self.path = os.path.join(OUT, name + '.pdf')
        self.c = canvas.Canvas(self.path, pagesize=A4)
        self.gt = {'cells': [], 'rules': [], 'lines': []}
    def save(self):
        self.c.showPage(); self.c.save()
        json.dump({'pages': [self.gt]}, open(self.path.replace('.pdf', '.json'), 'w'), ensure_ascii=False, indent=0)

def table(d, x0, ytop, cols, row_h, rows, font='Helvetica', size=10, pad=4, grid=True, hrules=None,
          vrules_only=False, zebra=None, header_fill=None, header_color=white, right_cols=(), lw=0.8, bold_header=True):
    c = d.c
    tw = sum(cols); th = row_h * len(rows)
    for r, row in enumerate(rows):
        top = ytop - r * row_h
        fill = header_fill if (r == 0 and header_fill) else (zebra if (zebra and r % 2 == 1) else None)
        if fill:
            c.setFillColor(HexColor(fill)); c.rect(x0, top - row_h, tw, row_h, fill=1, stroke=0)
        x = x0
        for ci, txt in enumerate(row):
            f = font + '-Bold' if (r == 0 and bold_header and font in ('Helvetica', 'Times-Roman', 'Courier')) else font
            if f == 'Times-Roman-Bold': f = 'Times-Bold'
            c.setFont(f, size)
            c.setFillColor(header_color if (r == 0 and header_fill) else black)
            sw = stringWidth(txt, f, size)
            tx = x + cols[ci] - pad - sw if ci in right_cols else x + pad
            base = top - row_h / 2 - size * 0.35
            c.drawString(tx, base, txt)
            d.gt['cells'].append({'text': txt, 'box': [x, H - top, cols[ci], row_h], 'row': r, 'col': ci})
            x += cols[ci]
    c.setStrokeColor(black); c.setLineWidth(lw)
    if grid:
        xs = [x0]
        for w in cols: xs.append(xs[-1] + w)
        for xx in xs:
            c.line(xx, ytop, xx, ytop - th); d.gt['rules'].append([xx, H - ytop, xx, H - ytop + th])
        if not vrules_only:
            for r in range(len(rows) + 1):
                yy = ytop - r * row_h
                c.line(x0, yy, x0 + tw, yy); d.gt['rules'].append([x0, H - yy, x0 + tw, H - yy])
    for r in (hrules or []):
        yy = ytop - r * row_h
        c.line(x0, yy, x0 + tw, yy); d.gt['rules'].append([x0, H - yy, x0 + tw, H - yy])

def para_lines(d, x, ytop, lines, font='Helvetica', size=10, lead=13, word_space=None, bold_word=None):
    c = d.c
    for i, ln in enumerate(lines):
        y = ytop - i * lead
        t = c.beginText(x, y); t.setFont(font, size)
        if word_space: t.setWordSpace(word_space)
        if bold_word and bold_word in ln:
            a, b = ln.split(bold_word, 1)
            t.textOut(a); t.setFont('Helvetica-Bold', size); t.textOut(bold_word); t.setFont(font, size); t.textOut(b)
        else:
            t.textOut(ln)
        c.drawText(t)
        d.gt['lines'].append(ln)

# A1 grille serrée
d = Doc('a01_grid_tight'); table(d, 40, 780, [50, 120, 70, 40, 90], 13, cellvals(20), size=9, pad=2); d.save()
# A2 grille normale, cellules à plusieurs mots
d = Doc('a02_grid_normal'); table(d, 40, 780, [60, 150, 90, 50, 100], 22, cellvals(12), size=11, pad=6, right_cols=(3, 4)); d.save()
# A3 sans bordures
d = Doc('a03_borderless'); table(d, 40, 780, [60, 150, 90, 50, 100], 16, cellvals(15), size=10, pad=4, grid=False); d.save()
# A4 style "booktabs" (filets horizontaux seulement)
d = Doc('a04_booktabs'); rows = cellvals(12); table(d, 40, 780, [60, 150, 90, 50, 100], 17, rows, size=10, pad=6, grid=False, hrules=[0, 1, len(rows)], right_cols=(3, 4)); d.save()
# A5 lignes zébrées, pas de traits
d = Doc('a05_zebra'); table(d, 40, 780, [60, 150, 90, 50, 100], 16, cellvals(15), size=10, pad=3, grid=False, zebra='#e8eef7', header_fill='#3a5a8a'); d.save()
# A6 en-tête sombre + grille
d = Doc('a06_dark_header'); table(d, 40, 780, [60, 150, 90, 50, 100], 18, cellvals(12), size=10, pad=4, header_fill='#1f2d3d', right_cols=(4,)); d.save()
# A7 filets verticaux seulement, montants alignés à droite
d = Doc('a07_vrules'); table(d, 40, 780, [60, 150, 90, 50, 100], 16, cellvals(15), size=10, pad=3, vrules_only=True, right_cols=(3, 4)); d.save()
# A8 grille très serrée (8 pt, 1 pt de marge)
d = Doc('a08_grid_very_tight'); table(d, 40, 780, [45, 105, 60, 30, 75], 10, cellvals(25), size=8, pad=1.2, lw=0.5); d.save()
# A9 cellules colorées adjacentes (pas de traits, écart minime)
d = Doc('a09_cell_fills'); c = d.c
rows = cellvals(10); x0, ytop, cols, rh = 40, 780, [60, 150, 90, 50, 100], 16
for r, row in enumerate(rows):
    x = x0
    for ci, txt in enumerate(row):
        c.setFillColor(HexColor(['#dfe7f3', '#f3e6df', '#e3f3df', '#f3f0df', '#eadff3'][ci])); c.rect(x, ytop - (r + 1) * rh, cols[ci], rh, fill=1, stroke=0)
        c.setFillColor(black); c.setFont('Helvetica', 10); c.drawString(x + 2, ytop - r * rh - rh / 2 - 3.5, txt)
        d.gt['cells'].append({'text': txt, 'box': [x, H - (ytop - r * rh), cols[ci], rh], 'row': r, 'col': ci}); x += cols[ci]
d.save()
# A13 deux colonnes de texte
d = Doc('a13_two_columns')
L = ['Le rapport annuel présente les', 'résultats consolidés du groupe', 'pour l’exercice écoulé ainsi que', 'les perspectives pour la période', 'suivante et les risques identifiés.']
R = ['Les ventes progressent de 12 %', 'grâce aux nouveaux marchés en', 'Europe du Nord et au succès de', 'la gamme professionnelle lancée', 'au printemps dernier.']
para_lines(d, 40, 780, L, size=10); para_lines(d, 40 + 230 + 20, 780, R, size=10); d.save()
# A12 paragraphe justifié (Tw) + mot en gras
d = Doc('a12_justified_bold')
para_lines(d, 40, 780, ['Ce contrat est conclu entre les parties', 'soussignées pour une durée déterminée', 'de douze mois renouvelable par tacite'], size=11, lead=15, word_space=3.5, bold_word='conclu')
d.save()
# A14 libellé / valeur éloignés sans traits
d = Doc('a14_label_value'); c = d.c
for i, (k, v) in enumerate([('Nom :', 'Dupont'), ('Prénom :', 'Marie'), ('Ville :', 'Lyon'), ('Téléphone :', '06 12 34 56 78')]):
    y = 780 - i * 18; c.setFont('Helvetica-Bold', 10); c.drawString(40, y, k); c.setFont('Helvetica', 10); c.drawString(160, y, v)
    d.gt['cells'] += [{'text': k, 'box': [38, H - y - 11, 100, 15]}, {'text': v, 'box': [158, H - y - 11, 200, 15]}]
d.save()

# ── PDF écrits "à la main" (flux de contenu bruts) ─────────────────────────────
def raw_pdf(name, content, gt):
    pdf = pikepdf.new()
    font = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica, Encoding=pikepdf.Name.WinAnsiEncoding))
    mono = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Courier, Encoding=pikepdf.Name.WinAnsiEncoding))
    page = pikepdf.Dictionary(Type=pikepdf.Name.Page, MediaBox=[0, 0, W, H],
                              Resources=pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font, F2=mono)),
                              Contents=pdf.make_stream(content.encode('latin-1')))
    pdf.pages.append(pikepdf.Page(page))
    pdf.save(os.path.join(OUT, name + '.pdf'))
    json.dump({'pages': [gt]}, open(os.path.join(OUT, name + '.json'), 'w'), ensure_ascii=False, indent=0)

# A10 : une ligne de tableau = un seul TJ avec de grands décalages entre cellules, + grille
rows = [r[:4] for r in cellvals(12)]; cols = [70, 150, 90, 60]; x0, ytop, rh, size = 40, 780, 16, 10
ops, gt = [], {'cells': [], 'rules': [], 'lines': []}
for r, row in enumerate(rows):
    base = ytop - r * rh - rh / 2 - 3.5
    parts, cur = [], x0 + 3
    for ci, txt in enumerate(row):
        cell_x = x0 + sum(cols[:ci])
        if ci: parts.append(f'{-(cell_x + 3 - cur) * 1000 / size:.1f}')
        parts.append('(' + txt.replace('€', '\x80').replace('é', '\xe9').replace('ë', '\xeb') + ')')
        cur = cell_x + 3 + stringWidth(txt, 'Helvetica', size)
        gt['cells'].append({'text': txt, 'box': [cell_x, H - (ytop - r * rh), cols[ci], rh]})
    ops.append(f'BT /F1 {size} Tf {x0 + 3} {base:.2f} Td [{" ".join(parts)}] TJ ET')
xs = [x0 + sum(cols[:i]) for i in range(len(cols) + 1)]
ops.append('0.8 w')
for xx in xs:
    ops.append(f'{xx} {ytop} m {xx} {ytop - rh * len(rows)} l S'); gt['rules'].append([xx, H - ytop, xx, H - ytop + rh * len(rows)])
for r in range(len(rows) + 1):
    yy = ytop - r * rh; ops.append(f'{x0} {yy} m {xs[-1]} {yy} l S'); gt['rules'].append([x0, H - yy, xs[-1], H - yy])
raw_pdf('a10_tj_single_string', '\n'.join(ops), gt)

# A11 : chaque glyphe dessiné séparément (positionnement absolu), dans une grille
ops, gt = [], {'cells': [], 'rules': [], 'lines': []}
rows = [r[:4] for r in cellvals(10)]
for r, row in enumerate(rows):
    base = ytop - r * rh - rh / 2 - 3.5
    for ci, txt in enumerate(row):
        cell_x = x0 + sum(cols[:ci]); xx = cell_x + 3
        for ch in txt:
            b = ch.replace('€', '\x80').replace('é', '\xe9').replace('ë', '\xeb').replace('(', '\\(').replace(')', '\\)')
            ops.append(f'BT /F1 {size} Tf 1 0 0 1 {xx:.2f} {base:.2f} Tm ({b}) Tj ET')
            xx += stringWidth(ch, 'Helvetica', size)
        gt['cells'].append({'text': txt, 'box': [cell_x, H - (ytop - r * rh), cols[ci], rh]})
ops.append('0.8 w')
for xx in xs:
    ops.append(f'{xx} {ytop} m {xx} {ytop - rh * len(rows)} l S'); gt['rules'].append([xx, H - ytop, xx, H - ytop + rh * len(rows)])
for r in range(len(rows) + 1):
    yy = ytop - r * rh; ops.append(f'{x0} {yy} m {xs[-1]} {yy} l S'); gt['rules'].append([x0, H - yy, xs[-1], H - yy])
raw_pdf('a11_glyph_by_glyph', '\n'.join(ops), gt)

# A15 : état en police à chasse fixe, colonnes séparées par des espaces dans une seule chaîne
ops, gt = [], {'cells': [], 'rules': [], 'lines': []}
data = [('Article', 'Qte', 'Prix'), ('Clavier', '2', '49.90'), ('Souris sans fil', '5', '19.99'), ('Ecran 27 pouces', '1', '289.00'), ('Cable HDMI', '10', '7.50')]
for i, (a, q, p) in enumerate(data):
    line = f'{a:<18}{q:>5}{p:>10}'
    y = 780 - i * 14
    ops.append(f'BT /F2 10 Tf 40 {y} Td ({line}) Tj ET')
    cw = 6.0
    gt['cells'] += [{'text': a, 'box': [40, H - y - 10, 18 * cw, 13]}, {'text': q, 'box': [40 + 18 * cw, H - y - 10, 5 * cw, 13]}, {'text': p, 'box': [40 + 23 * cw, H - y - 10, 10 * cw, 13]}]
raw_pdf('a15_monospace_spaces', '\n'.join(ops), gt)

for n in sorted(os.listdir(OUT)):
    if n.endswith('.pdf'): print(n, len(json.load(open(os.path.join(OUT, n.replace('.pdf', '.json'))))['pages'][0]['cells']), 'cells')
