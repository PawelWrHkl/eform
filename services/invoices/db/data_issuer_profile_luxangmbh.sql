-- Profil wystawcy Luxan GmbH na poziomie 2 (organizacja → klient) — kontrakt e-faktur
-- v1.4, pkt 6.7 (Wiktoria, 14.11.2026). Bez tego wiersza moduł bierze profil zastępczy
-- z organizacji: waluta lokalna PLN, język pl, USt-IdNr. w polu NIP, bez Steuernummer
-- i bez rachunku. Usługa e-faktur porównuje numer VAT sprzedawcy z tym profilem.
--
-- ⚠️ ZMIENIA WYDRUK faktur Luxan GmbH → klient: Steuernummer i USt-IdNr. osobno,
-- rachunek Commerzbank w sekcji płatności, kwota VAT bez przeliczenia na PLN. Formatka
-- zostaje (`template_code = 'LUXANGMBH'`), numeracja też (`{YYYY}/{NR:5}`, ta sama seria
-- wystawcy). Przed produkcją: wpis w `services/invoices/changes.js` i zgoda Pawła/KK.
--
-- Idempotentne: wstawia tylko, gdy organizacja 5 to LUXANGMBH i profilu jeszcze nie ma —
-- na innej bazie (inne id/ident) nic nie robi. Adres i nazwa z `organization`.

INSERT INTO invoice_issuer_profile
  (issuer_type, issuer_id, level, name, tax_id, vat_eu_id, registry_numbers, street, zip, city, country,
   email, phone, bank_name, bank_iban, bank_swift, currency, local_currency, payment_days, default_lang,
   template_code, number_pattern)
SELECT 'organization', o.id, 2, o.name, '37/428/30270', 'DE814603367',
       JSON_OBJECT('STEUERNUMMER', '37/428/30270', 'USTIDNR', 'DE814603367', 'HRB', '100531 B'),
       o.street, o.zip, o.city, 'DE',
       'rechnung@luxan.de', o.company_phone, 'Commerzbank', 'DE46100400000715538500', 'COBADEFFXXX', 'EUR', 'EUR', 14, 'de',
       'LUXANGMBH', '{YYYY}/{NR:5}'
  FROM organization o
 WHERE o.id = 5 AND o.ident = 'LUXANGMBH'
   AND NOT EXISTS (SELECT 1 FROM invoice_issuer_profile p WHERE p.issuer_type = 'organization' AND p.issuer_id = 5 AND p.level = 2);
