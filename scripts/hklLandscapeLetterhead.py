#!/usr/bin/env python3
# Poziomy papier firmowy HKL dla faktur (img/invoice-background/HKL_POZIOM.pdf), 2026-10-23;
# nagłówek o połowę niższy od 2026-10-26 (uwaga KK: góra faktury zajmowała 1/3 strony).
# Wszystkie faktury mają być poziome, a jedyna pionowa formatka to HKL.pdf — dane bierzemy z niej.
#
# ⚠️ Od 2026-11-07 BEZ wycinków (`show_pdf_page` z `clip`): wycinek to cała strona HKL.pdf
# przycięta tylko wizualnie, a część przeglądarek PDF (u właściciela) przycinanie ignoruje —
# nad kreską wychodziły podpisy wyróżnień, a rachunki EUR/PLN rysowały się podwójnie.
# Teraz: logo = obrazek wyrenderowany z oryginału, teksty stopki = wektorowo z tych samych
# napisów i pozycji co w HKL.pdf (wyciągnięte programem — bez przepisywania IBAN-ów).
# Dane firmy (nazwa, adres, REGON, tel., fax, e-mail, NIP) od 2026-11-06 w stopce, nie nad kreską.
#
# Wymaga PyMuPDF (nie jest zależnością aplikacji — plik PDF generuje się raz):
#   python3 -m venv /tmp/venv-pdf && /tmp/venv-pdf/bin/pip install pymupdf
#   /tmp/venv-pdf/bin/python scripts/hklLandscapeLetterhead.py \
#       img/invoice-background/HKL.pdf img/invoice-background/HKL_POZIOM.pdf
# Potem: node scripts/setInvoiceTemplate.js HKL --background HKL_POZIOM.pdf --margins 18,12,25,12 --code HKL
# (współrzędne źródłowe w pt, względem pionowego HKL.pdf 799×1129 pt).
import sys
import fitz

src_path, out_path = sys.argv[1], sys.argv[2]
src = fitz.open(src_path)[0]
out = fitz.open()
W, H = 841.89, 595.28          # A4 poziomo, pt
M = 12 * 72 / 25.4             # 12 mm marginesu bocznego
GREY = (0.3, 0.3, 0.3)
FONT = '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'  # metryka Ariala, ma „ł”
font = fitz.Font(fontfile=FONT)
page = out.new_page(width=W, height=H)

def text(x, y, s, size):
    page.insert_text((x, y), s, fontsize=size, fontname='LiberationSans', fontfile=FONT, color=(0, 0, 0))

# --- Nagłówek: samo logo (obrazek, bo w HKL.pdf logo też jest obrazkiem)
logo = fitz.Rect(50, 40, 233, 108)
s_head = 0.4
top = 10
head_h = logo.height * s_head
pix = src.get_pixmap(clip=logo, matrix=fitz.Matrix(6, 6), alpha=False)
page.insert_image(fitz.Rect(M, top, M + logo.width * s_head, top + head_h), pixmap=pix)
y_line_head = top + head_h + 5
page.draw_line((M, y_line_head), (W - M, y_line_head), color=GREY, width=0.9)

# --- Stopka: linia, potem w jednym rzędzie dane firmy | rachunek EUR | rachunek PLN.
# Rachunki: napisy HKL.pdf (Arial 8 pt) z ich pozycjami, przeskalowane do szerokości strony.
dane = [['HKL DEKORACJA OKIEN Sp. z o.o.', 'ul. Wisławy Szymborskiej 20', '70-784 Szczecin', 'REGON 811899346'],
        ['tel.: (91) 432-11-92', 'fax: (91) 886-50-70', 'e-mail: info@hkl.eu', 'NIP 955-19-42-642']]
FS, LINE, COLGAP, GAP = 8.0, 9.6, 12.0, 14.0
FIRST_BASELINE = 1054.87       # linia bazowa „Payments in EUR” w HKL.pdf
col_w = [max(font.text_length(t, fontsize=FS) for t in col) for col in dane]
dane_w = sum(col_w) + COLGAP
eur = fitz.Rect(50, 1046, 388, 1093)   # od 1046: wyżej są podpisy wyróżnień
pln = fitz.Rect(432, 1046, 758, 1093)
s_foot = min((W - 2 * M - 2 * GAP) / (dane_w + eur.width + pln.width), 1.0)
bank_h = eur.height * s_foot
y_bank = H - 9 - bank_h
y_line_foot = y_bank - 5
page.draw_line((M, y_line_foot), (W - M, y_line_foot), color=GREY, width=0.9)

def y_of(src_baseline):
    return y_bank + (src_baseline - eur.y0) * s_foot

x = M
for col, w in zip(dane, col_w):
    for i, t in enumerate(col):
        text(x, y_of(FIRST_BASELINE + i * LINE), t, FS * s_foot)
    x += (w + COLGAP) * s_foot

def bank_block(clip, x0):
    spans = [s for b in src.get_text('dict', clip=clip)['blocks'] for l in b.get('lines', []) for s in l['spans'] if s['text'].strip()]
    for s in spans:
        ox, oy = s['origin']
        text(x0 + (ox - clip.x0) * s_foot, y_of(oy), s['text'], s['size'] * s_foot)
    return spans

x_eur = M + dane_w * s_foot + GAP
n_eur = len(bank_block(eur, x_eur))
n_pln = len(bank_block(pln, x_eur + eur.width * s_foot + GAP))
assert n_eur == 8 and n_pln == 8, f'inne napisy rachunków w HKL.pdf niż oczekiwane: {n_eur}/{n_pln}'

out.subset_fonts()
# PyMuPDF opisuje glif spacji jako NBSP, a „-” jako miękki dywiz (w czcionce to te same glify):
# skopiowany z faktury IBAN miałby twarde spacje. Poprawiamy pojedyncze wpisy mapy ToUnicode.
import re
for xref in range(1, out.xref_length()):
    if out.xref_is_stream(xref) and b'beginbf' in (out.xref_stream(xref) or b''):
        cmap = out.xref_stream(xref).decode('latin1')
        cmap = re.sub(r'(?m)^(<[0-9a-fA-F]{4}>) <00[aA]0>$', r'\1 <0020>', cmap)
        cmap = re.sub(r'(?m)^(<[0-9a-fA-F]{4}>) <00[aA][dD]>$', r'\1 <002d>', cmap)
        out.update_stream(xref, cmap.encode('latin1'))
out.save(out_path, garbage=4, deflate=True)
check = fitz.open(out_path)[0].get_text()
assert 'PL64 1910 1048 2793 2107 1341 0002' in check and '\xa0' not in check and '\xad' not in check, 'tekst stopki kopiuje się ze złymi znakami'
assert 'GEPARD' not in check.upper() and len(fitz.open(out_path)[0].get_images()) == 1, 'w formatce zostały resztki oryginału'
mm = lambda pt: round(pt * 25.4 / 72, 1)
print(f'linia nagłówka {mm(y_line_head)} mm od góry, linia stopki {mm(H - y_line_foot)} mm od dołu, '
      f'skala stopki {s_foot:.2f} (tekst {FS * s_foot:.1f} pt)')
