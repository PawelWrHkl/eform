#!/usr/bin/env bash
#
# db-schema-sync.sh — porownuje strukture bazy TEST (.env) z bazą PROD
# (.env.production) i uzupelnia na PROD brakujace kolumny/tabele.
#
# Dziala WYLACZNIE w trybie "dodawania": ALTER TABLE ... ADD COLUMN oraz
# CREATE TABLE IF NOT EXISTS. Nigdy nie usuwa/modyfikuje istniejacych
# kolumn, tabel ani danych.
#
# Uzycie:
#   scripts/db-schema-sync.sh diff     # tylko pokaz roznice, nic nie zmieniaj
#   scripts/db-schema-sync.sh apply    # wygeneruj migracje i wykonaj ja na PROD (z potwierdzeniem)
#
# Wymaga: mysql, mysqldump, python3.
# Wymaga plikow .env (baza testowa) i .env.production (baza produkcyjna)
# w katalogu glownym repo, z kluczami:
#   DATABASE, DATABASE_HOST, DATABASE_PORT, DATABASE_USER, DATABASE_PASSWORD

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_TEST="$ROOT_DIR/.env"
ENV_PROD="$ROOT_DIR/.env.production"
OUT_DIR="$ROOT_DIR/tmp/db-schema-sync/$(date +%Y%m%d-%H%M%S)"
MODE="${1:-diff}"

if [[ "$MODE" != "diff" && "$MODE" != "apply" ]]; then
    echo "Uzycie: $0 [diff|apply]" >&2
    exit 1
fi

for bin in mysql mysqldump python3; do
    command -v "$bin" >/dev/null 2>&1 || { echo "Brak wymaganego polecenia: $bin" >&2; exit 1; }
done

[[ -f "$ENV_TEST" ]] || { echo "Brak pliku $ENV_TEST" >&2; exit 1; }
[[ -f "$ENV_PROD" ]] || { echo "Brak pliku $ENV_PROD (dane logowania do produkcji)" >&2; exit 1; }

mkdir -p "$OUT_DIR"

CNF_TEST="$OUT_DIR/.my_test.cnf"
CNF_PROD="$OUT_DIR/.my_prod.cnf"

cleanup() {
    rm -f "$CNF_TEST" "$CNF_PROD"
}
trap cleanup EXIT

# --- 1) Zbuduj tymczasowe pliki poswiadczen (chmod 600) na podstawie .env ---
make_cnf() {
    local env_file="$1" cnf_file="$2"
    python3 - "$env_file" "$cnf_file" <<'PYEOF'
import re, sys
env_file, cnf_file = sys.argv[1], sys.argv[2]
text = open(env_file, "r", encoding="utf-8").read()
def get(key):
    m = re.search(rf'^{key}=(.*)$', text, re.MULTILINE)
    if not m:
        return ""
    v = m.group(1).strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
        v = v[1:-1]
    return v

host = get("DATABASE_HOST")
port = get("DATABASE_PORT")
user = get("DATABASE_USER")
password = get("DATABASE_PASSWORD")
db = get("DATABASE")

missing = [k for k, v in {
    "DATABASE_HOST": host, "DATABASE_PORT": port,
    "DATABASE_USER": user, "DATABASE_PASSWORD": password,
    "DATABASE": db,
}.items() if not v]
if missing:
    sys.stderr.write(f"Brak wartosci w {env_file}: {', '.join(missing)}\n")
    sys.exit(1)

with open(cnf_file, "w", encoding="utf-8") as f:
    # "database=" celowo pominiete: information_schema queries filtruja po
    # table_schema jawnie, a mysqldump dostaje nazwe bazy jako argument —
    # ustawienie tu "database=" w [client] mysqldump odczytuje jako
    # (mylacy) --databases i wypisuje ostrzezenie.
    f.write(f"[client]\nhost={host}\nport={port}\nuser={user}\npassword={password}\n")
PYEOF
    chmod 600 "$cnf_file"
}

make_cnf "$ENV_TEST" "$CNF_TEST"
make_cnf "$ENV_PROD" "$CNF_PROD"

DB_NAME="$(python3 - "$ENV_TEST" <<'PYEOF'
import re, sys
text = open(sys.argv[1]).read()
m = re.search(r'^DATABASE=(.*)$', text, re.MULTILINE)
print(m.group(1).strip() if m else "")
PYEOF
)"

echo "== Sprawdzam polaczenia =="
mysql --defaults-extra-file="$CNF_TEST" -e "SELECT 1;" >/dev/null
echo "  TEST: OK"
mysql --defaults-extra-file="$CNF_PROD" -e "SELECT 1;" >/dev/null
echo "  PROD: OK"

# --- 2) Dump struktury (bez danych) z obu baz ---
echo "== Dump struktury (bez danych) =="
mysqldump --defaults-extra-file="$CNF_TEST" --no-data --no-tablespaces --skip-comments --routines --triggers "$DB_NAME" \
    > "$OUT_DIR/schema_test.sql"
mysqldump --defaults-extra-file="$CNF_PROD" --no-data --no-tablespaces --skip-comments --routines --triggers "$DB_NAME" \
    > "$OUT_DIR/schema_prod.sql"

# --- 3) Metadane kolumn (tabela / kolumna / typ / null / default / extra) ---
mysql --defaults-extra-file="$CNF_TEST" -N -B -e "
SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
FROM information_schema.columns
WHERE table_schema='$DB_NAME'
ORDER BY TABLE_NAME, ORDINAL_POSITION;
" > "$OUT_DIR/columns_test.tsv"

mysql --defaults-extra-file="$CNF_PROD" -N -B -e "
SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
FROM information_schema.columns
WHERE table_schema='$DB_NAME'
ORDER BY TABLE_NAME, ORDINAL_POSITION;
" > "$OUT_DIR/columns_prod.tsv"

# --- 4) Porownanie: tabele i kolumny ---
cut -f1 "$OUT_DIR/columns_test.tsv" | sort -u > "$OUT_DIR/tables_test.txt"
cut -f1 "$OUT_DIR/columns_prod.tsv" | sort -u > "$OUT_DIR/tables_prod.txt"

comm -23 "$OUT_DIR/tables_test.txt" "$OUT_DIR/tables_prod.txt" > "$OUT_DIR/tables_missing_on_prod.txt" || true
comm -13 "$OUT_DIR/tables_test.txt" "$OUT_DIR/tables_prod.txt" > "$OUT_DIR/tables_only_on_prod.txt" || true
comm -12 "$OUT_DIR/tables_test.txt" "$OUT_DIR/tables_prod.txt" > "$OUT_DIR/tables_common.txt" || true

: > "$OUT_DIR/missing_columns.tsv"
while read -r t; do
    [[ -z "$t" ]] && continue
    awk -F'\t' -v t="$t" '$1==t' "$OUT_DIR/columns_test.tsv" | sort > "$OUT_DIR/_test_cols.tmp"
    awk -F'\t' -v t="$t" '$1==t{print $1"\t"$2}' "$OUT_DIR/columns_prod.tsv" | sort > "$OUT_DIR/_prod_cols_key.tmp"
    cut -f1,2 "$OUT_DIR/_test_cols.tmp" | sort > "$OUT_DIR/_test_cols_key.tmp"
    comm -23 "$OUT_DIR/_test_cols_key.tmp" "$OUT_DIR/_prod_cols_key.tmp" > "$OUT_DIR/_missing_keys.tmp"
    if [[ -s "$OUT_DIR/_missing_keys.tmp" ]]; then
        while IFS=$'\t' read -r tn cn; do
            grep -P "^${tn}\t${cn}\t" "$OUT_DIR/_test_cols.tmp" >> "$OUT_DIR/missing_columns.tsv"
        done < "$OUT_DIR/_missing_keys.tmp"
    fi
done < "$OUT_DIR/tables_common.txt"
rm -f "$OUT_DIR"/_*.tmp

# --- 5) Wygeneruj ALTER TABLE ... ADD COLUMN dla brakujacych pol ---
awk -F'\t' '
{
    tbl=$1; col=$2; type=$3; nullable=$4; def=$5; extra=$6;
    line = "ALTER TABLE `" tbl "` ADD COLUMN `" col "` " type;
    if (nullable == "NO") line = line " NOT NULL"; else line = line " NULL";
    if (def != "NULL" && def != "") {
        if (def == "CURRENT_TIMESTAMP") line = line " DEFAULT CURRENT_TIMESTAMP";
        else line = line " DEFAULT \x27" def "\x27";
    } else if (nullable == "NO" && def == "NULL") {
        line = line " /* UWAGA: brak DEFAULT, sprawdz recznie przed apply */";
    }
    if (extra != "") line = line " " extra;
    print line ";";
}
' "$OUT_DIR/missing_columns.tsv" > "$OUT_DIR/alter_missing_columns.sql"

# --- 6) Wyciagnij CREATE TABLE dla brakujacych tabel z dumpa TEST ---
python3 - "$OUT_DIR/schema_test.sql" "$OUT_DIR/tables_missing_on_prod.txt" "$OUT_DIR/create_missing_tables.sql" <<'PYEOF'
import re, sys
src, tablesfile, out = sys.argv[1], sys.argv[2], sys.argv[3]
wanted = [l.strip() for l in open(tablesfile) if l.strip()]
text = open(src, encoding="utf-8").read()
parts = re.split(r'(?=DROP TABLE IF EXISTS)', text)
blocks = {}
for p in parts:
    m = re.match(r'DROP TABLE IF EXISTS `([^`]+)`;', p)
    if m:
        blocks[m.group(1)] = p.strip()

missing_from_dump = [t for t in wanted if t not in blocks]
if missing_from_dump:
    sys.stderr.write(f"UWAGA: brak definicji w dumpie dla: {missing_from_dump}\n")

with open(out, "w", encoding="utf-8") as f:
    if wanted:
        f.write("SET FOREIGN_KEY_CHECKS=0;\n\n")
        for t in wanted:
            if t not in blocks:
                continue
            block = blocks[t]
            # Usun DROP TABLE (bezpieczenstwo: nigdy nie kasujemy istniejacych tabel)
            block = re.sub(r'^DROP TABLE IF EXISTS `[^`]+`;\n', '', block)
            # CREATE TABLE -> CREATE TABLE IF NOT EXISTS (dodatkowe zabezpieczenie)
            block = re.sub(r'^CREATE TABLE `', 'CREATE TABLE IF NOT EXISTS `', block, flags=re.MULTILINE)
            # Usun testowy licznik AUTO_INCREMENT=N, PROD ma zaczac liczenie od 1
            block = re.sub(r' AUTO_INCREMENT=\d+', '', block)
            f.write(block + "\n\n")
        f.write("SET FOREIGN_KEY_CHECKS=1;\n")
PYEOF

# --- 7) Zloz koncowy plik migracji ---
{
    echo "-- ============================================================="
    echo "-- Migracja PROD wygenerowana automatycznie: $(date '+%Y-%m-%d %H:%M:%S')"
    echo "-- Tylko dodawanie: ADD COLUMN / CREATE TABLE IF NOT EXISTS."
    echo "-- Brak DROP, brak modyfikacji/usuwania istniejacych danych."
    echo "-- ============================================================="
    echo
    echo "-- 1) Brakujace kolumny w istniejacych tabelach"
    echo
    cat "$OUT_DIR/alter_missing_columns.sql"
    echo
    echo "-- 2) Brakujace tabele"
    echo
    cat "$OUT_DIR/create_missing_tables.sql"
} > "$OUT_DIR/migration.sql"

# --- 8) Raport ---
n_tables_missing=$(wc -l < "$OUT_DIR/tables_missing_on_prod.txt" | tr -d ' ')
n_tables_only_prod=$(wc -l < "$OUT_DIR/tables_only_on_prod.txt" | tr -d ' ')
n_cols_missing=$(wc -l < "$OUT_DIR/missing_columns.tsv" | tr -d ' ')

echo
echo "== Wynik porownania =="
echo "  Tabele tylko na TEST (brak na PROD): $n_tables_missing"
[[ -s "$OUT_DIR/tables_missing_on_prod.txt" ]] && sed 's/^/    - /' "$OUT_DIR/tables_missing_on_prod.txt"
echo "  Tabele tylko na PROD (brak na TEST): $n_tables_only_prod"
[[ -s "$OUT_DIR/tables_only_on_prod.txt" ]] && sed 's/^/    - /' "$OUT_DIR/tables_only_on_prod.txt"
echo "  Brakujace kolumny w tabelach wspolnych: $n_cols_missing"
[[ -s "$OUT_DIR/missing_columns.tsv" ]] && awk -F'\t' '{print "    - "$1"."$2" ("$3")"}' "$OUT_DIR/missing_columns.tsv"
echo
echo "Pliki wyjsciowe w: $OUT_DIR"
echo "Gotowa migracja: $OUT_DIR/migration.sql"

if [[ "$n_tables_missing" -eq 0 && "$n_cols_missing" -eq 0 ]]; then
    echo
    echo "Brak roznic do zastosowania — PROD ma juz wszystko co TEST."
    exit 0
fi

if [[ "$MODE" == "diff" ]]; then
    echo
    echo "Tryb 'diff' — nic nie zostalo wykonane na PROD."
    echo "Aby zastosowac zmiany: $0 apply"
    exit 0
fi

# --- 9) Tryb apply: potwierdzenie i wykonanie na PROD ---
echo
echo "!! Za chwile zostana wykonane powyzsze zmiany NA PRODUKCJI (baza: $DB_NAME @ $(grep '^host=' "$CNF_PROD" | cut -d= -f2)) !!"
read -r -p "Wpisz TAK aby kontynuowac: " confirm
if [[ "$confirm" != "TAK" ]]; then
    echo "Przerwano — nic nie zostalo zmienione na PROD."
    exit 1
fi

mysql --defaults-extra-file="$CNF_PROD" < "$OUT_DIR/migration.sql"
echo "Migracja wykonana na PROD."
