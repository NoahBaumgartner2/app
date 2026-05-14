#!/usr/bin/env bash
# setup-kodi-umbrella.sh — Installiert Umbrella + Real-Debrid auf Kodi
# Verwendung: ./setup-kodi-umbrella.sh DEIN_REALDEBRID_API_KEY

set -euo pipefail

# ── Farben ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[0;33m'
BLU='\033[0;34m'
MAG='\033[0;35m'
CYN='\033[0;36m'
BLD='\033[1m'
RST='\033[0m'

info()    { echo -e "${BLU}${BLD}[•]${RST} $*"; }
ok()      { echo -e "${GRN}${BLD}[✓]${RST} $*"; }
warn()    { echo -e "${YLW}${BLD}[!]${RST} $*"; }
err()     { echo -e "${RED}${BLD}[✗]${RST} $*" >&2; }
step()    { echo -e "\n${MAG}${BLD}══ $* ${RST}"; }
waiting() { echo -e "${CYN}${BLD}[⏳]${RST} $*"; }

die() { err "$*"; exit 1; }

# ── Argumente ────────────────────────────────────────────────────────────────
if [[ $# -lt 1 ]]; then
  err "Kein Real-Debrid API-Key angegeben."
  echo -e "  Verwendung: ${BLD}$0 DEIN_REALDEBRID_API_KEY${RST}"
  exit 1
fi

RD_API_KEY="$1"
KODI_HOME="/home/miniserver/.kodi"
KODI_ADDONS="${KODI_HOME}/addons"
KODI_USERDATA="${KODI_HOME}/userdata/addon_data/plugin.video.umbrella"
KODI_RPC="http://localhost:8080/jsonrpc"
KODI_AUTH="kodi:kodi"
REPO_ZIP_URL="https://github.com/umbrellaplug/umbrellaplug.github.io/raw/main/zips/repository.umbrella/repository.umbrella-1.0.6.zip"
REPO_ZIP_TMP="/tmp/repository.umbrella.zip"

# ── Banner ───────────────────────────────────────────────────────────────────
echo -e "${MAG}${BLD}"
echo "  ╔═══════════════════════════════════════════════╗"
echo "  ║   Kodi Umbrella + Real-Debrid Setup           ║"
echo "  ╚═══════════════════════════════════════════════╝"
echo -e "${RST}"

# ── Hilfsfunktionen ──────────────────────────────────────────────────────────

kodi_rpc() {
  # kodi_rpc <method> <params_json>
  local method="$1"
  local params="${2:-{}}"
  local body
  body=$(printf '{"jsonrpc":"2.0","method":"%s","params":%s,"id":1}' "$method" "$params")
  curl -s --max-time 10 \
    -u "$KODI_AUTH" \
    -H "Content-Type: application/json" \
    -X POST "$KODI_RPC" \
    -d "$body"
}

kodi_rpc_check() {
  # Gibt 0 zurück wenn result vorhanden, 1 bei error
  local response="$1"
  if echo "$response" | grep -q '"error"'; then
    local msg
    msg=$(echo "$response" | grep -o '"message":"[^"]*"' | head -1 | cut -d'"' -f4)
    warn "RPC-Antwort enthält Fehler: ${msg:-unbekannt}"
    return 1
  fi
  return 0
}

wait_for_kodi() {
  local max=30
  local i=0
  info "Warte auf Kodi JSON-RPC…"
  while [[ $i -lt $max ]]; do
    local resp
    resp=$(curl -s --max-time 3 -u "$KODI_AUTH" -H "Content-Type: application/json" \
      -X POST "$KODI_RPC" \
      -d '{"jsonrpc":"2.0","method":"JSONRPC.Ping","id":1}' 2>/dev/null || true)
    if echo "$resp" | grep -q '"pong"'; then
      ok "Kodi ist erreichbar."
      return 0
    fi
    printf '.'
    sleep 2
    (( i++ ))
  done
  echo ""
  die "Kodi antwortet nach ${max}s nicht auf JSON-RPC."
}

# ════════════════════════════════════════════════════════════════════════════
# Schritt 1: Kodi-Status prüfen
# ════════════════════════════════════════════════════════════════════════════
step "1/10 · Kodi-Status prüfen"

if systemctl is-active --quiet kodi; then
  ok "Kodi läuft (systemd service 'kodi' ist active)."
  KODI_WAS_RUNNING=true
else
  warn "Kodi läuft gerade nicht. Starte Kodi…"
  systemctl start kodi || die "Konnte Kodi nicht starten."
  KODI_WAS_RUNNING=false
  sleep 5
fi

# ════════════════════════════════════════════════════════════════════════════
# Schritt 2: Repository ZIP herunterladen
# ════════════════════════════════════════════════════════════════════════════
step "2/10 · Umbrella Repository ZIP herunterladen"

info "URL: ${REPO_ZIP_URL}"
rm -f "$REPO_ZIP_TMP"
if curl -L --progress-bar --max-time 60 -o "$REPO_ZIP_TMP" "$REPO_ZIP_URL"; then
  local_size=$(stat -c%s "$REPO_ZIP_TMP" 2>/dev/null || echo 0)
  ok "Heruntergeladen: ${REPO_ZIP_TMP} ($(numfmt --to=iec "$local_size"))"
else
  die "Download fehlgeschlagen."
fi

# ════════════════════════════════════════════════════════════════════════════
# Schritt 3: ZIP nach ~/.kodi/addons/ entpacken
# ════════════════════════════════════════════════════════════════════════════
step "3/10 · Repository entpacken"

mkdir -p "$KODI_ADDONS"

# Altes Repository entfernen falls vorhanden
if [[ -d "${KODI_ADDONS}/repository.umbrella" ]]; then
  warn "Vorhandenes repository.umbrella wird überschrieben."
  rm -rf "${KODI_ADDONS}/repository.umbrella"
fi

if unzip -q "$REPO_ZIP_TMP" -d "$KODI_ADDONS"; then
  ok "Entpackt nach: ${KODI_ADDONS}/repository.umbrella/"
else
  die "Entpacken fehlgeschlagen."
fi

# Prüfen ob das Verzeichnis existiert
if [[ ! -d "${KODI_ADDONS}/repository.umbrella" ]]; then
  # Manche ZIPs legen alles in einen Unterordner — verschieben
  extracted=$(find "$KODI_ADDONS" -maxdepth 1 -name "repository.umbrella*" -type d | head -1)
  if [[ -n "$extracted" ]]; then
    mv "$extracted" "${KODI_ADDONS}/repository.umbrella"
    ok "Verzeichnis verschoben: repository.umbrella/"
  else
    die "Konnte repository.umbrella/ nicht finden nach dem Entpacken."
  fi
fi

rm -f "$REPO_ZIP_TMP"

# ════════════════════════════════════════════════════════════════════════════
# Schritt 4: Kodi neu starten + 20s warten
# ════════════════════════════════════════════════════════════════════════════
step "4/10 · Kodi neu starten"

info "Starte Kodi neu (systemctl restart kodi)…"
systemctl restart kodi || die "Konnte Kodi nicht neu starten."
ok "Kodi-Neustart initiiert."

waiting "Warte 20 Sekunden auf Kodi-Start…"
for i in $(seq 20 -1 1); do
  printf "\r${CYN}${BLD}[⏳]${RST} Noch %2ds…" "$i"
  sleep 1
done
echo ""

wait_for_kodi

# ════════════════════════════════════════════════════════════════════════════
# Schritt 5: Repository aktivieren via JSON-RPC
# ════════════════════════════════════════════════════════════════════════════
step "5/10 · Umbrella Repository aktivieren"

info "Sende Addons.SetAddonEnabled für repository.umbrella…"
resp=$(kodi_rpc "Addons.SetAddonEnabled" \
  '{"addonid":"repository.umbrella","enabled":true}')
echo "  Antwort: ${resp}"

if kodi_rpc_check "$resp"; then
  ok "Repository aktiviert."
else
  warn "Aktivierung möglicherweise fehlgeschlagen — fahre fort."
fi

# ════════════════════════════════════════════════════════════════════════════
# Schritt 6: 10 Sekunden warten
# ════════════════════════════════════════════════════════════════════════════
step "6/10 · Repository-Sync abwarten"

waiting "Warte 10 Sekunden für Repository-Initialisierung…"
for i in $(seq 10 -1 1); do
  printf "\r${CYN}${BLD}[⏳]${RST} Noch %2ds…" "$i"
  sleep 1
done
echo ""
ok "Wartezeit abgelaufen."

# ════════════════════════════════════════════════════════════════════════════
# Schritt 7: plugin.video.umbrella installieren
# ════════════════════════════════════════════════════════════════════════════
step "7/10 · plugin.video.umbrella installieren"

info "Sende Addons.ExecuteAddon für plugin.video.umbrella…"
resp=$(kodi_rpc "Addons.ExecuteAddon" \
  '{"addonid":"plugin.video.umbrella","wait":false}')
echo "  Antwort: ${resp}"

if kodi_rpc_check "$resp"; then
  ok "Installation angestoßen."
else
  warn "ExecuteAddon hat Fehler zurückgegeben — möglicherweise noch nicht installiert."
  info "Versuche alternative Methode: Addon über Repository-URL öffnen…"
  resp2=$(kodi_rpc "Addons.ExecuteAddon" \
    '{"addonid":"repository.umbrella","params":{"action":"install","addonid":"plugin.video.umbrella"}}')
  echo "  Antwort: ${resp2}"
fi

# ════════════════════════════════════════════════════════════════════════════
# Schritt 8: 30 Sekunden für Installation warten
# ════════════════════════════════════════════════════════════════════════════
step "8/10 · Installation abwarten"

waiting "Warte 30 Sekunden für Plugin-Installation…"
for i in $(seq 30 -1 1); do
  printf "\r${CYN}${BLD}[⏳]${RST} Noch %2ds…" "$i"
  sleep 1
done
echo ""
ok "Wartezeit abgelaufen."

# Prüfen ob umbrella jetzt installiert ist
info "Prüfe ob plugin.video.umbrella jetzt bekannt ist…"
resp=$(kodi_rpc "Addons.GetAddonDetails" \
  '{"addonid":"plugin.video.umbrella","properties":["enabled","version"]}')
if echo "$resp" | grep -q '"addonid"'; then
  version=$(echo "$resp" | grep -o '"version":"[^"]*"' | head -1 | cut -d'"' -f4)
  ok "plugin.video.umbrella gefunden (Version: ${version:-unbekannt})"
else
  warn "plugin.video.umbrella noch nicht in Kodi registriert."
  warn "Möglicherweise muss die Installation manuell in der Kodi-GUI abgeschlossen werden."
fi

# ════════════════════════════════════════════════════════════════════════════
# Schritt 9: Real-Debrid API-Key in settings.xml schreiben
# ════════════════════════════════════════════════════════════════════════════
step "9/10 · Real-Debrid API-Key konfigurieren"

mkdir -p "$KODI_USERDATA"
SETTINGS_FILE="${KODI_USERDATA}/settings.xml"

if [[ -f "$SETTINGS_FILE" ]]; then
  info "Vorhandene settings.xml gefunden — aktualisiere realdebrid.apikey."

  if grep -q 'id="realdebrid.apikey"' "$SETTINGS_FILE"; then
    # Key existiert → ersetzen (in-place mit sed)
    sed -i "s|<setting id=\"realdebrid.apikey\">[^<]*</setting>|<setting id=\"realdebrid.apikey\">${RD_API_KEY}</setting>|g" \
      "$SETTINGS_FILE"
    ok "API-Key aktualisiert."
  else
    # Key fehlt → vor </settings> einfügen
    sed -i "s|</settings>|    <setting id=\"realdebrid.apikey\">${RD_API_KEY}</setting>\n</settings>|" \
      "$SETTINGS_FILE"
    ok "API-Key hinzugefügt."
  fi
else
  info "Keine settings.xml vorhanden — erstelle neue Datei."
  cat > "$SETTINGS_FILE" <<XML
<settings version="2">
    <setting id="realdebrid.apikey">${RD_API_KEY}</setting>
</settings>
XML
  ok "settings.xml erstellt."
fi

# Ergebnis anzeigen (Key maskieren)
masked="${RD_API_KEY:0:6}…$(echo "$RD_API_KEY" | rev | cut -c1-4 | rev)"
info "API-Key gesetzt: ${masked}"
info "Pfad: ${SETTINGS_FILE}"

# ════════════════════════════════════════════════════════════════════════════
# Schritt 10: Finaler Kodi-Neustart
# ════════════════════════════════════════════════════════════════════════════
step "10/10 · Finaler Kodi-Neustart"

info "Starte Kodi neu um Einstellungen zu übernehmen…"
systemctl restart kodi || die "Finaler Neustart fehlgeschlagen."
ok "Kodi wird neu gestartet."

waiting "Warte 15 Sekunden…"
for i in $(seq 15 -1 1); do
  printf "\r${CYN}${BLD}[⏳]${RST} Noch %2ds…" "$i"
  sleep 1
done
echo ""

wait_for_kodi

# ── Zusammenfassung ──────────────────────────────────────────────────────────
echo ""
echo -e "${GRN}${BLD}"
echo "  ╔═══════════════════════════════════════════════╗"
echo "  ║   Setup abgeschlossen!                        ║"
echo "  ╚═══════════════════════════════════════════════╝"
echo -e "${RST}"
echo -e "  ${BLD}Was wurde gemacht:${RST}"
echo -e "  ${GRN}✓${RST} Umbrella Repository entpackt nach ${KODI_ADDONS}/repository.umbrella/"
echo -e "  ${GRN}✓${RST} Repository via JSON-RPC aktiviert"
echo -e "  ${GRN}✓${RST} plugin.video.umbrella Installation angestoßen"
echo -e "  ${GRN}✓${RST} Real-Debrid API-Key in settings.xml geschrieben"
echo -e "  ${GRN}✓${RST} Kodi neu gestartet"
echo ""
echo -e "  ${YLW}${BLD}Nächste Schritte (falls Plugin nicht automatisch installiert):${RST}"
echo -e "  1. Kodi öffnen → Add-ons → Add-on Browser"
echo -e "  2. Aus Repository installieren → Umbrella Repository"
echo -e "  3. Video-Add-ons → Umbrella → Installieren"
echo ""
