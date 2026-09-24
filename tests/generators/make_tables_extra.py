import json, os, random, pikepdf
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib.colors import HexColor, black, white
from reportlab.pdfbase.pdfmetrics import stringWidth
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'fixtures', 'tables')
W, H = A4
random.seed(3)
def rows(n):
    r = [['Code', 'Produit', 'Catégorie', 'Stock', 'Prix HT', 'TVA', 'Prix TTC']]
    for i in range(n):
        ht = random.randint(5, 900) + random.randint(0, 99) / 100
        r.append([f'P-{1000+i}', random.choice(['Chaise', 'Bureau', 'Lampe LED', 'Écran 24"', 'Clavier']), random.choice(['Mobilier', 'Informatique', 'Déco']),
                  str(random.randint(0, 500)), f'{ht:.2f}', '20 %', f'{ht*1.2:.2f}'])
    return r

# L1: landscape table displayed upright through /Rotate 90 (content drawn rotated in user space)
data = rows(18); cols = [60, 120, 100, 50, 80, 50, 80]; rh = 18; x0, ytop = 40, W - 40   # landscape coords: width H, height W
path = os.path.join(OUT, 'd01_landscape_rotate90.pdf')
c = canvas.Canvas(path, pagesize=(W, H))
# landscape (lx, ly) → user space: page shown rotated 90° clockwise, so user = (ly, H - lx) ... draw with a matrix
c.saveState(); c.transform(0, 1, -1, 0, W, 0)    # landscape (lx, ly) -> user (W - ly, lx)
gt = {'cells': [], 'rules': [], 'lines': []}
for r, row in enumerate(data):
    top = ytop - r * rh
    x = x0
    for ci, t in enumerate(row):
        f = 'Helvetica-Bold' if r == 0 else 'Helvetica'
        c.setFont(f, 10); c.setFillColor(black)
        right = ci >= 3
        tx = x + cols[ci] - 4 - stringWidth(t, f, 10) if right else x + 4
        c.drawString(tx, top - rh / 2 - 3.5, t)
        gt['cells'].append({'text': t, 'box': [x, W - top, cols[ci], rh]})
        x += cols[ci]
c.setLineWidth(0.7)
xs = [x0]; [xs.append(xs[-1] + w) for w in cols]
for xx in xs: c.line(xx, ytop, xx, ytop - rh * len(data))
for r in range(len(data) + 1): c.line(x0, ytop - r * rh, xs[-1], ytop - r * rh)
c.restoreState(); c.showPage(); c.save()
pdf = pikepdf.open(path, allow_overwriting_input=True); pdf.pages[0].Rotate = 90; pdf.save(path)
json.dump({'pages': [gt]}, open(path.replace('.pdf', '.json'), 'w'), ensure_ascii=False)

# L2: invoice: paragraph + table with thin rules + right-aligned totals block
path = os.path.join(OUT, 'd02_invoice_mixed.pdf')
c = canvas.Canvas(path, pagesize=A4); gt = {'cells': [], 'rules': [], 'lines': []}
c.setFont('Helvetica-Bold', 16); c.drawString(40, 790, 'FACTURE N° 2026-0457'); gt['lines'].append('FACTURE N° 2026-0457')
c.setFont('Helvetica', 10)
for i, ln in enumerate(['Société Exemple SARL', '12 avenue de la République', '69003 Lyon']):
    c.drawString(40, 765 - i * 13, ln); gt['lines'].append(ln)
for i, ln in enumerate(['Client : Martin Dupont', 'Date : 24/09/2026', 'Échéance : 24/10/2026']):
    c.drawRightString(555, 765 - i * 13, ln); gt['lines'].append(ln)
data = [['Désignation', 'Qté', 'PU HT', 'Total HT']] + [[f'Prestation de conseil lot {i}', str(i + 1), f'{(i + 1) * 45:.2f} €', f'{(i + 1) ** 2 * 45:.2f} €'] for i in range(8)]
cols = [265, 50, 90, 110]; rh = 20; ytop = 700
for r, row in enumerate(data):
    top = ytop - r * rh
    if r == 0: c.setFillColor(HexColor('#f0f0f0')); c.rect(40, top - rh, sum(cols), rh, fill=1, stroke=0)
    x = 40
    for ci, t in enumerate(row):
        f = 'Helvetica-Bold' if r == 0 else 'Helvetica'; c.setFont(f, 10); c.setFillColor(black)
        if ci == 0: c.drawString(x + 5, top - 13.5, t)
        else: c.drawRightString(x + cols[ci] - 5, top - 13.5, t)
        gt['cells'].append({'text': t, 'box': [x, H - top, cols[ci], rh]}); x += cols[ci]
    c.setStrokeColor(HexColor('#999999')); c.setLineWidth(0.4); c.line(40, top - rh, 40 + sum(cols), top - rh)
for i, (k, v) in enumerate([('Total HT', '9 180,00 €'), ('TVA 20 %', '1 836,00 €'), ('Total TTC', '11 016,00 €')]):
    y = ytop - len(data) * rh - 25 - i * 16
    c.setFont('Helvetica-Bold' if i == 2 else 'Helvetica', 10)
    c.drawRightString(440, y, k); c.drawRightString(550, y, v)
    gt['cells'] += [{'text': k, 'box': [345, H - y - 12, 100, 16]}, {'text': v, 'box': [445, H - y - 12, 110, 16]}]
c.showPage(); c.save()
json.dump({'pages': [gt]}, open(path.replace('.pdf', '.json'), 'w'), ensure_ascii=False)
print('ok')
