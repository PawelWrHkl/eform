#!/bin/bash
# Nocny przebieg robota testującego konfigurator — uruchamiany z crona użytkownika.
#
# Dlaczego cron, a nie systemd: unit `deploy/eform-configtest.service` wymaga
# sudo do instalacji i przez trzy tygodnie (21.09 → 12.10) nikt go nie
# zainstalował, więc robot nie chodził ANI RAZU. Cron użytkownika działa na tym
# hoście bez roota (chodzi tu już 7 innych zadań) i przeżywa restart maszyny.
#
# Godzina 02:00 — decyzja właściciela (2026-10-12). O tej samej porze startuje
# `eform-db/db-manager.sh auto`, ale kończy się w tej samej minucie, więc nie
# konkuruje z robotem o pamięć. Pamięci hosta pilnuje
# services/configuratorTester/memoryGuard.js (incydent 21.09: przebieg położył
# cały host).
#
# Instalacja (raz):  npm run configtest:cron-install
# Podgląd:           npm run configtest:logs   |   tail -f configtest/nightly.out

set -u

# ⚠️ RAPORT MAILEM WYŁĄCZNIE DO WŁAŚCICIELA — decyzja 2026-10-12: codzienny
# raport ma przychodzić do Pawła, a NIE do pozostałych (szef, Grzegorz, Rafał).
# `.env` ma w CONFIGTEST_NOTIFY_EMAIL czterech odbiorców, więc nadpisujemy to
# TUTAJ — dotenv nie nadpisuje zmiennej już ustawionej w środowisku, więc ta
# linia wygrywa z .env. Nie w samym .env: jest commitowany automatycznie
# i wspólny dla aplikacji. Poszerzenie listy odbiorców tylko na wyraźną prośbę.
export CONFIGTEST_NOTIFY_EMAIL=pawel.woroniecki@hkl.eu
unset CONFIGTEST_NO_MAIL

REPO=/home/pawel/projects/eform-project/eform
NODE=/home/pawel/.nvm/versions/node/v23.10.0/bin/node
cd "$REPO" || exit 1
mkdir -p configtest

OUT=configtest/nightly.out
# Jeden poprzedni przebieg zachowany do wglądu, bez rośnięcia w nieskończoność.
[ -f "$OUT" ] && mv -f "$OUT" "$OUT.prev"

{
  echo "=== $(date '+%F %T') — start nocnego przebiegu ==="
  # `flock -n`: gdy poprzedni przebieg jeszcze trwa (albo ktoś odpalił ręcznie),
  # NIE startujemy drugiego — dwa naraz to podwójna pamięć i dwa maile.
  # `-E 75`: zajęta blokada ma WŁASNY kod — bez tego flock oddaje 1, czyli to
  # samo, co tester przy zgłoszeniach P1, i log kłamałby o wyniku.
  flock -n -E 75 configtest/nightly.lock \
    "$NODE" --max-old-space-size=1536 --expose-gc scripts/runConfiguratorTest.js --nowe --browser --symulacja
  KOD=$?
  case $KOD in
    0) echo "=== $(date '+%F %T') — koniec: brak zgłoszeń P1 ===" ;;
    1) echo "=== $(date '+%F %T') — koniec: są zgłoszenia P1 (raport wysłany) ===" ;;
    75) echo "=== $(date '+%F %T') — POMINIĘTO: poprzedni przebieg jeszcze trwa ===" ;;
    *) echo "=== $(date '+%F %T') — AWARIA testera, kod $KOD — sprawdź configtest/configtest.log ===" ;;
  esac
} >> "$OUT" 2>&1
