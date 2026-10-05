#!/bin/bash
set -euo pipefail

# Pełne ścieżki do komend
GIT=/usr/bin/git
LOG_FILE=/home/pawel/projects/eform-project/eform/cron.log
REMOTE_URL="${GIT_REMOTE:-}"
BRANCH="${GIT_BRANCH:-main}"
GITHUB_REPO="${GITHUB_REPO:-}"

# Zmiana katalogu na właściwy
cd /home/pawel/projects/eform-project/eform || exit 1

# Logowanie rozpoczęcia
echo "=== $(date '+%Y-%m-%d %H:%M:%S') - Start ===" >> "$LOG_FILE"

git_init_if_needed() {
  if [ ! -d .git ]; then
    echo "=== $(date '+%Y-%m-%d %H:%M:%S') - Inicjalizacja repozytorium Git ===" >> "$LOG_FILE"
    $GIT init . >> "$LOG_FILE" 2>&1
    $GIT symbolic-ref HEAD refs/heads/$BRANCH >> "$LOG_FILE" 2>&1 || true
  fi
}

setup_remote() {
  if ! $GIT remote | grep -q '^origin$'; then
    if [ -z "$REMOTE_URL" ]; then
      echo "=== $(date '+%Y-%m-%d %H:%M:%S') - Brak zdefiniowanego origin i GIT_REMOTE ===" >> "$LOG_FILE"
      echo "Brak zdalnego repozytorium do wypchnięcia. Ustaw GIT_REMOTE lub dodaj origin ręcznie." >> "$LOG_FILE"
      exit 1
    fi
    echo "=== $(date '+%Y-%m-%d %H:%M:%S') - Dodawanie zdalnego origin: $REMOTE_URL ===" >> "$LOG_FILE"
    $GIT remote add origin "$REMOTE_URL" >> "$LOG_FILE" 2>&1
  else
    local current
    current=$($GIT remote get-url origin)
    if [ -n "$REMOTE_URL" ] && [ "$current" != "$REMOTE_URL" ]; then
      echo "=== $(date '+%Y-%m-%d %H:%M:%S') - Aktualizacja origin do: $REMOTE_URL ===" >> "$LOG_FILE"
      $GIT remote set-url origin "$REMOTE_URL" >> "$LOG_FILE" 2>&1
    else
      REMOTE_URL="$current"
    fi
  fi
}

create_github_repo_if_needed() {
  if [ -n "$GITHUB_REPO" ] && command -v gh >/dev/null 2>&1; then
    if ! $GIT ls-remote --exit-code origin >/dev/null 2>&1; then
      echo "=== $(date '+%Y-%m-%d %H:%M:%S') - Tworzenie repozytorium GitHub: $GITHUB_REPO ===" >> "$LOG_FILE"
      gh repo create "$GITHUB_REPO" --source=. --remote=origin --push --confirm >> "$LOG_FILE" 2>&1 || true
    fi
  fi
}

commit_and_push() {
  local current_branch
  current_branch=$($GIT symbolic-ref --short HEAD 2>/dev/null || echo "(detached HEAD)")
  if [ "$current_branch" != "$BRANCH" ]; then
    echo "=== $(date '+%Y-%m-%d %H:%M:%S') - BŁĄD: drzewo jest na gałęzi '$current_branch', a nie '$BRANCH' — pomijam commit i push ===" >> "$LOG_FILE"
    exit 1
  fi

  if [ -n "$($GIT status --porcelain)" ]; then
    echo "=== $(date '+%Y-%m-%d %H:%M:%S') - Dodawanie zmian do commita ===" >> "$LOG_FILE"
    $GIT add . >> "$LOG_FILE" 2>&1
    $GIT commit -m "Automatic commit $(date '+%Y-%m-%d %H:%M')" >> "$LOG_FILE" 2>&1
    echo "=== $(date '+%Y-%m-%d %H:%M:%S') - Wysyłanie do origin/$BRANCH ===" >> "$LOG_FILE"
    $GIT push -u origin "$BRANCH" >> "$LOG_FILE" 2>&1
  else
    echo "=== $(date '+%Y-%m-%d %H:%M:%S') - Brak zmian do zapisania ===" >> "$LOG_FILE"
  fi
}

# Wykonanie operacji
git_init_if_needed
setup_remote
create_github_repo_if_needed
commit_and_push

echo "=== $(date '+%Y-%m-%d %H:%M:%S') - Koniec ===" >> "$LOG_FILE"