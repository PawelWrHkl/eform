# eForm 2.0 — Build Guide dla AI

Ten plik jest instrukcją prowadzącą dla AI (Claude Code lub inny agent), które będzie budować projekt **eForm 2.0** od zera, w nowym repozytorium. Traktuj go jako nadrzędny kontrakt — każda decyzja techniczna musi być z nim zgodna, a każdy krok pracy musi kończyć się w stanie zgodnym z sekcją "Definicja Done".

Nie buduj wszystkiego na raz. Pracuj fazami z sekcji "Fazy budowy", w podanej kolejności, i po każdej fazie zatrzymaj się i poproś użytkownika o potwierdzenie przed przejściem do następnej.

---

## 1. Kontekst i cel

eForm 2.0 to przepisanie od zera istniejącego systemu do konfigurowalnych formularzy zamówień B2B (ceny, rabaty, warianty, VAT wg kraju, eksport do produkcji, faktury, mailbot). Stary system (Express + Nunjucks + MySQL bez ORM, bez TypeScript, ~65k LOC) ma dobrze przetestowaną logikę domenową, ale zły fundament: brak typów, zduplikowany silnik kalkulacji (raz w przeglądarce, raz w JSDOM server-side, raz w Playwright), brak CI, konkurujące zależności.

**Cel eForm 2.0:** ta sama logika domenowa (ceny, formuły, rabaty, warianty), ale na solidnym, typowanym, modularnym fundamencie, z jednym źródłem prawdy dla kalkulacji, pełnym testowaniem i dokumentacją, która pozwala bezpiecznie dodawać nowe moduły w przyszłości.

**Twarde wymaganie:** obliczenia formularza (ceny, formuły, zależności pól) muszą wykonywać się na frontendzie, w przeglądarce użytkownika, na żywo, bez round-tripu do serwera przy każdej zmianie pola. Serwer może i powinien mieć dostęp do tej samej logiki (do walidacji/audytu), ale nie zamiast klienta — obok niego, jako współdzielony pakiet.

---

## 2. Zasady inżynieryjne (obowiązują przez cały projekt)

1. **SOLID** — szczególnie Single Responsibility (moduł/klasa/funkcja robi jedną rzecz) i Dependency Inversion (serwisy zależą od interfejsów, nie od konkretnych implementacji — łatwe mockowanie w testach).
2. **DRY, ale bez nadinterpretacji** — jeśli funkcja/logika istnieje już w `packages/shared` albo gdzie indziej, użyj jej lub wydziel do współdzielonego miejsca. Nie kopiuj-wklejaj. Zanim napiszesz nową funkcję pomocniczą, sprawdź `grep`/wyszukiwaniem, czy coś podobnego już istnieje w repo. Ale: nie twórz abstrakcji "na przyszłość" dla przypadków, których jeszcze nie ma (YAGNI) — trzy podobne linie kodu w dwóch miejscach to nie problem, dopiero trzecie powtórzenie jest sygnałem do wydzielenia.
3. **KISS** — najprostsze rozwiązanie, które spełnia wymagania. Nie dodawaj wzorców projektowych, warstw abstrakcji ani konfigurowalności, których nikt nie potrzebuje.
4. **Jedno źródło prawdy dla logiki cenowej.** Zero duplikacji silnika kalkulacji. Logika liczenia cen/formuł/zależności pól żyje w jednym pakiecie (`packages/pricing-engine`), bez zależności od `window`/DOM/Node-specyficznych API — ma działać identycznie w przeglądarce i w Node.js.
5. **Typy wszędzie.** TypeScript strict mode. Zero `any` bez uzasadnienia w komentarzu. Dane wejściowe z zewnątrz (API, formularze, pliki) walidowane przez Zod na granicy systemu.
6. **Testy jako dokumentacja zachowania.** Każdy moduł domenowy (pricing-engine, orders, invoices, import, mailbot) ma testy jednostkowe pokrywające reguły biznesowe, nie tylko "happy path". Logika cenowa = testy z realnymi przypadkami (rabaty, SUB pricing, VAT per kraj) przeniesionymi ze starego systemu jako regression fixtures.
7. **Małe, kontrolowane kroki.** Jedna faza = jeden PR / jeden commit logiczny. Po każdym kroku: typecheck przechodzi, testy przechodzą, lint przechodzi. Nie przechodź do następnego kroku z czerwonym CI.
8. **Dokumentacja rośnie z kodem, nie po kodzie.** Każdy pakiet/moduł ma własny `README.md` (co robi, jak używać, jakie ma zależności). Każda nietrywialna decyzja architektoniczna (wybór biblioteki, wzorzec, kompromis) trafia do `docs/adr/NNNN-tytul.md` (Architecture Decision Record — krótki: kontekst, decyzja, konsekwencje).
9. **Bezpieczeństwo na granicach.** Walidacja wejścia (Zod) na każdym endpoincie. Parametryzowane zapytania (Prisma robi to domyślnie). Sesje w Redis, nie in-memory. Sekrety w `.env`, nigdy w kodzie.
10. **Nie zgaduj wymagań biznesowych.** Jeśli reguła cenowa/formularzowa jest niejasna, sprawdź w starym repo (`/home/pawel/projects/eform-project/eform`) — konkretnie `PROJECT_OVERVIEW.md`, `public/scripts/form.js`, `public/scripts/formula.js`, `services/formEngine/` — zamiast zakładać zachowanie. To jest specyfikacja referencyjna.

---

## 3. Docelowy stack

- **Monorepo:** pnpm workspaces + Turborepo.
- **Backend:** Node.js (LTS) + TypeScript + NestJS (moduły = Module/Controller/Service, DI wbudowane).
- **API:** tRPC między `apps/web` i `apps/api` (typy end-to-end, bez ręcznych kontraktów REST).
- **ORM/DB:** Prisma + MySQL (zachowujemy MySQL dla ciągłości operacyjnej, chyba że w Fazie 3 wyjdzie mocny argument za Postgres — zapisz to jako ADR).
- **Cache/sesje/kolejki:** Redis + BullMQ (sesje, zadania importu zamówień, wysyłki maili, generowania PDF).
- **Frontend:** React + TypeScript + Vite (SPA, bez SSR — appka wewnętrzna za loginem).
- **UI:** Tailwind + shadcn/ui.
- **Data fetching:** TanStack Query (przez tRPC client).
- **Silnik kalkulacji:** `packages/pricing-engine` — czysty TypeScript, zero DOM, testowalny w Node bez przeglądarki.
- **PDF:** Playwright (tylko do renderu finalnego dokumentu, nie do przeliczeń cenowych).
- **Walidacja:** Zod (współdzielone schematy w `packages/shared-types`).
- **Testy:** Vitest (unit), Testcontainers (integracyjne z realną MySQL w CI).
- **CI/CD:** GitHub Actions — lint + typecheck + test + build na każdy push/PR.
- **i18n:** jedna biblioteka (i18next) — bez duplikatu.

Jeśli chcesz odejść od czegoś w tej liście, zapisz to jako ADR z uzasadnieniem zamiast po prostu zmienić w trakcie pisania kodu.

---

## 4. Struktura repo

```
eform2/
  apps/
    api/              # NestJS backend
    web/               # React + Vite frontend
  packages/
    pricing-engine/    # czysta logika kalkulacji, zero DOM
    shared-types/       # Zod schematy + typy współdzielone FE/BE
    db/                  # Prisma schema + client
  docs/
    adr/                # Architecture Decision Records
    modules/             # README per moduł domenowy
  .github/workflows/
  turbo.json
  pnpm-workspace.yaml
```

---

## 5. Fazy budowy

Każda faza kończy się checklistą z sekcji 6, zanim przejdziesz dalej. Nie przeskakuj faz.

**Faza 0 — Szkielet repo.**
Inicjalizacja monorepo (pnpm + Turborepo), pusty NestJS w `apps/api`, pusty Vite+React w `apps/web`, konfiguracja TypeScript strict, ESLint + Prettier, Husky/lint-staged na pre-commit, GitHub Actions z pipeline `install → lint → typecheck → test → build` (nawet jeśli testów jeszcze nie ma, pipeline musi istnieć od pierwszego commita).

**Faza 1 — `pricing-engine`.**
Przenieś logikę z `public/scripts/form.js`, `formula.js`, `formTools/` ze starego repo do `packages/pricing-engine`, usuwając wszystkie odwołania do `window`/DOM. Wejście: dane formularza + definicja parametrów (jako typowany obiekt, nie parsowanie TSV w tym pakiecie). Wyjście: policzone ceny/wartości pól. Napisz testy Vitest pokrywające realne przypadki ze starego systemu (rabaty, ceny SUB, VAT per kraj, zależności pól) — to najważniejsza faza jakościowo, bo błąd tutaj = błąd w cenach u klienta.

**Faza 2 — Schema i dane.**
Zaprojektuj schemat Prisma na podstawie tabel starego MySQL (zamówienia, pozycje, klienci, organizacje, użytkownicy, definicje formularzy). Zdecyduj: definicje formularzy (dziś `param.txt`/`paramdict.txt`) trafiają do bazy jako wersjonowane rekordy walidowane Zod, nie pliki na dysku. Migracje przez `prisma migrate`.

**Faza 3 — Auth i core backend.**
Moduł auth (sesje w Redis albo JWT+refresh — zdecyduj i zapisz ADR), moduł users/organizations, middleware uprawnień. Endpointy przez tRPC.

**Faza 4 — Moduł zamówień (orders).**
CRUD zamówień + pozycji, integracja z `pricing-engine` po stronie serwera (do walidacji/audytu przeliczeń przy zapisie, nie do liczenia w czasie rzeczywistym).

**Faza 5 — Frontend: formularz.**
Komponent formularza w React, korzystający z `pricing-engine` bezpośrednio w przeglądarce dla live-recalc. UI z Tailwind/shadcn. Tu weryfikujesz w praktyce, że wydzielony silnik faktycznie działa identycznie jak stary `form.js`.

**Faza 6 — Faktury i PDF.**
Generowanie PDF przez Playwright, moduł faktur.

**Faza 7 — Import zamówień i mailbot jako joby w kolejce.**
BullMQ zamiast osobnego systemd daemona. Worker jako osobny proces w monorepo (`apps/worker` albo moduł w `apps/api`).

**Faza 8 — Panel admina do definicji formularzy.**
UI do edycji definicji parametrów/formuł zamiast ręcznej edycji plików tekstowych.

**Faza 9 — i18n, hardening, security review.**
Konsolidacja i18n, przegląd bezpieczeństwa (walidacja wejścia, uprawnienia, sekrety), przegląd wydajności.

---

## 6. Definicja "Done" dla każdej fazy/modułu

Zanim oznaczysz fazę jako zakończoną, potwierdź:

- [ ] `pnpm typecheck` przechodzi bez błędów w całym monorepo.
- [ ] `pnpm lint` przechodzi bez ostrzeżeń.
- [ ] `pnpm test` przechodzi, nowa logika ma testy pokrywające reguły biznesowe (nie tylko happy path).
- [ ] Żadna funkcja/logika nie jest skopiowana z innego miejsca w repo — sprawdzone wyszukiwaniem przed napisaniem.
- [ ] Każdy nowy pakiet/moduł ma `README.md` (cel, jak używać, zależności).
- [ ] Każda nietrywialna decyzja ma wpis w `docs/adr/`.
- [ ] CI (GitHub Actions) jest zielone na tym commicie.
- [ ] Jeśli faza dotyczyła logiki cenowej: wynik porównany z zachowaniem starego systemu na tych samych danych wejściowych (regression fixtures ze starego repo).

---

## 7. Jak AI powinno pracować w tym repo

- Zanim napiszesz kod dla danej fazy, krótko opisz plan (pliki, moduły, decyzje) i poczekaj na potwierdzenie, jeśli coś jest niejednoznaczne.
- Referencyjne zachowanie biznesowe bierz ze starego repo (`/home/pawel/projects/eform-project/eform`), nie z domysłu.
- Nie mieszaj faz — jeśli w Fazie 4 zauważysz, że coś z Fazy 1 wymaga poprawki, wróć i popraw Fazę 1, nie łataj tego lokalnie w Fazie 4.
- Aktualizuj `docs/modules/*.md` i `docs/adr/*` na bieżąco, nie na końcu.
- Pytaj, gdy reguła biznesowa (rabat, VAT, cena SUB) jest niejasna — cena źle policzona to błąd u klienta, nie kosmetyka.
