#!/usr/bin/env python3
# Poziomy papier firmowy HKL dla faktur (img/invoice-background/HKL_POZIOM.pdf), 2026-10-23;
# nagłówek o połowę niższy od 2026-10-26 (uwaga KK: góra faktury zajmowała 1/3 strony).
# Wszystkie faktury mają być poziome, a jedyna pionowa formatka to HKL.pdf — ta jest
# składana z jej wycinków, więc dane firmy i rachunki zostają 1:1 (bez wyróżnień od 2026-10-27).
#
# Wymaga PyMuPDF (nie jest zależnością aplikacji — plik PDF generuje się raz):
#   python3 -m venv /tmp/venv-pdf && /tmp/venv-pdf/bin/pip install pymupdf
#   /tmp/venv-pdf/bin/python scripts/hklLandscapeLetterhead.py \
#       img/invoice-background/HKL.pdf img/invoice-background/HKL_POZIOM.pdf
# Potem: node scripts/setInvoiceTemplate.js HKL --background HKL_POZIOM.pdf --margins 18,12,25,12 --code HKL
# (współrzędne wycinków w pt, względem pionowego HKL.pdf 799×1129 pt).
import sys
import fitz

src_path, out_path = sys.argv[1], sys.argv[2]
src = fitz.open(src_path)
out = fitz.open()
W, H = 841.89, 595.28          # A4 poziomo, pt
M = 12 * 72 / 25.4             # 12 mm marginesu bocznego
GREY = (0.3, 0.3, 0.3)
page = out.new_page(width=W, height=H)

def place(clip, x, y, scale):
    r = fitz.Rect(x, y, x + clip.width * scale, y + clip.height * scale)
    page.show_pdf_page(r, src, 0, clip=clip)
    return r

# --- Nagłówek
logo = fitz.Rect(50, 40, 233, 108)
dane = fitz.Rect(388, 40, 757, 108)
s_head = 0.4
top = 10
head_h = logo.height * s_head
place(logo, M, top, s_head)
place(dane, W - M - dane.width * s_head, top, s_head)
# Bez wyróżnień (Gepard Biznesu itd.): po zmniejszeniu ich podpisy miały 2,6 pt — nieczytelne (KK 2026-10-27)
y_line_head = top + head_h + 5
page.draw_line((M, y_line_head), (W - M, y_line_head), color=GREY, width=0.9)

# --- Stopka: linia i oba rachunki (EUR | PLN) w jednym rzędzie, na całą szerokość
banki = fitz.Rect(50, 1045, 790, 1093)
s_bank = min((W - 2 * M) / banki.width, 1.0)
bank_h = banki.height * s_bank
y_bank = H - 9 - bank_h
y_line_foot = y_bank - 5
page.draw_line((M, y_line_foot), (W - M, y_line_foot), color=GREY, width=0.9)
place(banki, M, y_bank, s_bank)

out.save(out_path, garbage=4, deflate=True)
mm = lambda pt: round(pt * 25.4 / 72, 1)
print(f'linia nagłówka {mm(y_line_head)} mm od góry, linia stopki {mm(H - y_line_foot)} mm od dołu, '
      f'skala rachunków {s_bank:.2f}')
