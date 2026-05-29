const express    = require('express');
const { execFile, exec, spawn } = require('child_process');
const fs         = require('fs');
const os         = require('os');
const path       = require('path');
const http       = require('http');
const multer     = require('multer');
const crypto     = require('crypto');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const tmp        = require('tmp');
const session    = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const sqlite3    = require('sqlite3').verbose();
const bcrypt     = require('bcrypt');

const app      = express();
app.set('trust proxy', 1);
const PORT     = process.env.PORT || 3000;
const TECTONIC  = path.join(os.homedir(), '.local', 'bin', 'tectonic');
const APP_SLUGS = ['latex-converter', 'latex-study', 'podcast-compressor', 'pet-meds', 'smart-home', 'vault', 'server-monitor', 'stremio', 'voice-assistant', 'smarthome-zentrale', 'exam-trainer'];

let petMedsLastUpdated = Date.now();

const FORBIDDEN_HTML = `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kein Zugriff</title><style>body{font-family:system-ui,sans-serif;background:#111;color:#f0f0ee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.box{text-align:center}.icon{font-size:48px;margin-bottom:1rem}h2{margin:.5rem 0}p{color:#888;font-size:.875rem;margin:.25rem 0 1.5rem}a{display:inline-block;padding:8px 20px;border-radius:8px;background:#f0f0ee;color:#111;text-decoration:none;font-size:.875rem;font-weight:500}</style></head><body><div class="box"><div class="icon">🔒</div><h2>Kein Zugriff</h2><p>Du hast keine Berechtigung für diese App.</p><a href="/">← Zurück zum Dashboard</a></div></body></html>`;

// ══════════════════════════════════════════════════════════════════════════════
//  DATENBANK
// ══════════════════════════════════════════════════════════════════════════════
const db = new sqlite3.Database(path.join(__dirname, 'users.db'));
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT    UNIQUE NOT NULL,
    password TEXT    NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS secrets (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id  INTEGER NOT NULL,
    key_name TEXT    NOT NULL,
    value    TEXT    NOT NULL DEFAULT '',
    UNIQUE(user_id, key_name),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS medication_schedules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    pet_name    TEXT    NOT NULL,
    med_name    TEXT    NOT NULL,
    dose        TEXT    NOT NULL,
    time_of_day TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (date('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS medication_daily_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER NOT NULL,
    log_date    TEXT    NOT NULL,
    status      TEXT    NOT NULL CHECK(status IN ('done','skipped')),
    UNIQUE(schedule_id, log_date),
    FOREIGN KEY(schedule_id) REFERENCES medication_schedules(id) ON DELETE CASCADE
  )`);

  // Rollen-System: role-Spalte nachrüsten (Fehler ignorieren falls schon vorhanden)
  db.run(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`, () => {
    // Ersten registrierten User automatisch zum Admin machen, falls noch keiner existiert
    db.get(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`, (_, row) => {
      if (row && row.n === 0) {
        db.run(`UPDATE users SET role = 'admin' WHERE id = (SELECT MIN(id) FROM users)`);
      }
    });
  });

  db.run(`CREATE TABLE IF NOT EXISTS app_permissions (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id  INTEGER NOT NULL,
    app_slug TEXT    NOT NULL,
    UNIQUE(user_id, app_slug),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS user_activity (
    user_id   INTEGER PRIMARY KEY,
    last_seen TEXT    NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS smarthome_device_names (
    user_id     INTEGER NOT NULL,
    entity_id   TEXT    NOT NULL,
    custom_name TEXT    NOT NULL,
    PRIMARY KEY (user_id, entity_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS smarthome_group_order (
    user_id    INTEGER NOT NULL,
    group_name TEXT    NOT NULL,
    sort_order INTEGER NOT NULL,
    PRIMARY KEY (user_id, group_name),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS podcast_jobs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    original_name TEXT    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'pending',
    progress_pct  INTEGER NOT NULL DEFAULT 0,
    progress_msg  TEXT    NOT NULL DEFAULT '',
    drive_folder  TEXT    NOT NULL DEFAULT '',
    target_mb     INTEGER NOT NULL DEFAULT 195,
    error_msg     TEXT,
    drive_file_id TEXT,
    drive_filename TEXT,
    original_mb   REAL,
    output_mb     REAL,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  // Reset jobs that were mid-flight when server last stopped
  db.run(`UPDATE podcast_jobs SET status = 'error', error_msg = 'Server neu gestartet'
          WHERE status IN ('pending','compressing','uploading')`);

  db.run(`CREATE TABLE IF NOT EXISTS smarthome_scenes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    name       TEXT    NOT NULL,
    emoji      TEXT    NOT NULL DEFAULT '🎬',
    entity_id  TEXT    NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS vault_entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    label      TEXT    NOT NULL,
    category   TEXT    NOT NULL DEFAULT '',
    value_enc  TEXT    NOT NULL,
    notes      TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS spotify_tokens (
    user_id           INTEGER PRIMARY KEY,
    access_token      TEXT    NOT NULL DEFAULT '',
    refresh_token     TEXT    NOT NULL DEFAULT '',
    expires_at        INTEGER NOT NULL DEFAULT 0,
    client_id_enc     TEXT    NOT NULL DEFAULT '',
    client_secret_enc TEXT    NOT NULL DEFAULT '',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS audio_settings (
    user_id     INTEGER PRIMARY KEY,
    bt_mac      TEXT    NOT NULL DEFAULT '',
    bt_name     TEXT    NOT NULL DEFAULT 'Bluetooth',
    cable_name  TEXT    NOT NULL DEFAULT 'Kabel',
    bt_sink     TEXT    NOT NULL DEFAULT '',
    cable_sink  TEXT    NOT NULL DEFAULT '',
    current_out TEXT    NOT NULL DEFAULT 'cable',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS exam_sessions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL,
    subject          TEXT,
    score            INTEGER,
    total            INTEGER,
    timestamp        TEXT    NOT NULL DEFAULT (datetime('now')),
    duration_seconds INTEGER,
    files_used       TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS exam_questions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id     INTEGER NOT NULL,
    subject        TEXT,
    question       TEXT,
    type           TEXT,
    options_json   TEXT,
    correct_answer TEXT,
    explanation    TEXT,
    source_hint    TEXT,
    FOREIGN KEY (session_id) REFERENCES exam_sessions(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS user_answers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER NOT NULL,
    question_id INTEGER NOT NULL,
    user_answer TEXT,
    is_correct  INTEGER,
    timestamp   TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id)  REFERENCES exam_sessions(id)  ON DELETE CASCADE,
    FOREIGN KEY (question_id) REFERENCES exam_questions(id) ON DELETE CASCADE
  )`);
});

// Migration: medication_schedules → user_id entfernen (globale Tabelle)
db.all('PRAGMA table_info(medication_schedules)', (err, cols) => {
  if (err || !cols) return;
  if (!cols.some(c => c.name === 'user_id')) return;
  console.log('[pet-meds] Migriere medication_schedules: entferne user_id…');
  db.serialize(() => {
    db.run(`CREATE TABLE medication_schedules_v2 (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      pet_name    TEXT NOT NULL,
      med_name    TEXT NOT NULL,
      dose        TEXT NOT NULL,
      time_of_day TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (date('now'))
    )`);
    db.run(`INSERT INTO medication_schedules_v2 (id, pet_name, med_name, dose, time_of_day, created_at)
            SELECT id, pet_name, med_name, dose, time_of_day, created_at FROM medication_schedules`);
    db.run('DROP TABLE medication_schedules');
    db.run('ALTER TABLE medication_schedules_v2 RENAME TO medication_schedules', e => {
      if (e) console.error('[pet-meds] Migration fehlgeschlagen:', e.message);
      else   console.log('[pet-meds] Migration abgeschlossen.');
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  MIDDLEWARE
// ══════════════════════════════════════════════════════════════════════════════
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: __dirname }),
  secret: process.env.SESSION_SECRET || 'dashboard-local-secret-bitte-aendern',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000   // 7 Tage
  }
}));

// ── Vault encryption key (auto-generated on first run) ─────────────────────
const VAULT_KEY_PATH = path.join(__dirname, 'vault.key');
let vaultKey;
try {
  const raw = fs.readFileSync(VAULT_KEY_PATH, 'utf8').trim();
  vaultKey = Buffer.from(raw, 'hex');
  if (vaultKey.length !== 32) throw new Error('bad key length');
} catch {
  vaultKey = crypto.randomBytes(32);
  fs.writeFileSync(VAULT_KEY_PATH, vaultKey.toString('hex'), { mode: 0o600 });
  console.log('[vault] Neuer Verschlüsselungsschlüssel erstellt:', VAULT_KEY_PATH);
}

// Leitet aus dem Master-Schlüssel einen nutzerspezifischen Schlüssel ab.
// Gleicher vault.key → aber jeder User hat kryptografisch einen eigenen Schlüssel.
function userVaultKey(userId) {
  return crypto.hkdfSync('sha256', vaultKey, Buffer.alloc(0), Buffer.from(`vault-user-${userId}`), 32);
}

function vaultEncrypt(text, userId) {
  const key    = userVaultKey(userId);
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc    = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function vaultDecrypt(stored, userId) {
  const key = userVaultKey(userId);
  const [ivHex, tagHex, encHex] = stored.split(':');
  const dec = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  dec.setAuthTag(Buffer.from(tagHex, 'hex'));
  return dec.update(Buffer.from(encHex, 'hex')) + dec.final('utf8');
}

// ── Spotify Helpers ──────────────────────────────────────────────────────────
const SPOTIFY_SCOPES = [
  'user-read-playback-state', 'user-modify-playback-state',
  'user-read-currently-playing', 'playlist-read-private',
  'playlist-read-collaborative', 'streaming',
].join(' ');
const SPOTIFYD_CONF = path.join(os.homedir(), '.config', 'spotifyd', 'spotifyd.conf');

function spDbGet(sql, params) {
  return new Promise((res, rej) => db.get(sql, params, (e, r) => e ? rej(e) : res(r)));
}
function spDbRun(sql, params) {
  return new Promise((res, rej) => db.run(sql, params, e => e ? rej(e) : res()));
}

async function getSpotifyTokens(userId) {
  const row = await spDbGet('SELECT * FROM spotify_tokens WHERE user_id = ?', [userId]);
  if (!row) return null;
  try {
    return {
      accessToken:  row.access_token      ? vaultDecrypt(row.access_token,      userId) : '',
      refreshToken: row.refresh_token     ? vaultDecrypt(row.refresh_token,     userId) : '',
      expiresAt:    row.expires_at,
      clientId:     row.client_id_enc     ? vaultDecrypt(row.client_id_enc,     userId) : '',
      clientSecret: row.client_secret_enc ? vaultDecrypt(row.client_secret_enc, userId) : '',
    };
  } catch { return null; }
}

async function saveSpotifyTokens(userId, { accessToken, refreshToken, expiresAt, clientId, clientSecret } = {}) {
  const existing = await spDbGet('SELECT * FROM spotify_tokens WHERE user_id = ?', [userId]);
  const encAccess  = accessToken  !== undefined ? vaultEncrypt(accessToken,  userId) : (existing?.access_token      || '');
  const encRefresh = refreshToken !== undefined ? vaultEncrypt(refreshToken, userId) : (existing?.refresh_token     || '');
  const encId      = clientId     !== undefined ? vaultEncrypt(clientId,     userId) : (existing?.client_id_enc     || '');
  const encSecret  = clientSecret !== undefined ? vaultEncrypt(clientSecret, userId) : (existing?.client_secret_enc || '');
  const exp        = expiresAt    !== undefined ? expiresAt : (existing?.expires_at || 0);
  await spDbRun(
    `INSERT INTO spotify_tokens (user_id, access_token, refresh_token, expires_at, client_id_enc, client_secret_enc)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       access_token=excluded.access_token, refresh_token=excluded.refresh_token,
       expires_at=excluded.expires_at, client_id_enc=excluded.client_id_enc,
       client_secret_enc=excluded.client_secret_enc`,
    [userId, encAccess, encRefresh, exp, encId, encSecret]);
}

async function refreshSpotifyToken(userId) {
  const tokens = await getSpotifyTokens(userId);
  if (!tokens?.refreshToken || !tokens?.clientId || !tokens?.clientSecret)
    throw new Error('Keine Spotify-Refresh-Tokens vorhanden');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${tokens.clientId}:${tokens.clientSecret}`).toString('base64'),
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken }),
  });
  if (!r.ok) throw new Error('Spotify Token Refresh: ' + r.status);
  const data = await r.json();
  await saveSpotifyTokens(userId, {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token || tokens.refreshToken,
    expiresAt:    Date.now() + data.expires_in * 1000,
  });
  return data.access_token;
}

async function spotifyFetch(userId, endpoint, opts = {}) {
  let tokens = await getSpotifyTokens(userId);
  if (!tokens?.accessToken) throw new Error('Spotify nicht verbunden');
  if (Date.now() > tokens.expiresAt - 30_000)
    tokens.accessToken = await refreshSpotifyToken(userId);
  const doFetch = (tok) => fetch('https://api.spotify.com/v1' + endpoint, {
    ...opts,
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  let r = await doFetch(tokens.accessToken);
  if (r.status === 401) {
    tokens.accessToken = await refreshSpotifyToken(userId);
    r = await doFetch(tokens.accessToken);
  }
  return r;
}

// PWA-Dateien öffentlich (kein Login nötig, damit iOS sie laden kann)
app.get('/manifest.json', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'))
);
app.use('/icons', express.static(path.join(__dirname, 'public', 'icons')));
app.get('/sw.js', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'sw.js'))
);

// ── Auth-Middleware ────────────────────────────────────────────────────────
function checkAuth(req, res, next) {
  if (req.session.userId) {
    // Last-Seen für API-Calls und HTML-Seiten tracken (nicht für Assets)
    const p = req.path;
    if (req.originalUrl.includes('/api/') || p === '/' || p.endsWith('.html')) {
      db.run('INSERT OR REPLACE INTO user_activity (user_id, last_seen) VALUES (?, ?)',
        [req.session.userId, new Date().toISOString()]);
    }
    return next();
  }
  const isApi = req.originalUrl.includes('/api/') || req.originalUrl.includes('/compile');
  if (isApi) return res.status(401).json({ error: 'Nicht angemeldet.' });
  res.redirect('/login.html');
}

function checkAdmin(req, res, next) {
  if (req.session.role === 'admin') return next();
  if (req.originalUrl.includes('/api/'))
    return res.status(403).json({ error: 'Nur für Administratoren.' });
  res.status(403).send(FORBIDDEN_HTML);
}

function checkAppAccess(slug) {
  return (req, res, next) => {
    if (req.session.role === 'admin') return next();
    db.get('SELECT id FROM app_permissions WHERE user_id = ? AND app_slug = ?',
      [req.session.userId, slug],
      (err, row) => {
        if (row) return next();
        if (req.originalUrl.includes('/api/') || req.originalUrl.includes('/compile'))
          return res.status(403).json({ error: 'Kein Zugriff auf diese App.' });
        res.status(403).send(FORBIDDEN_HTML);
      }
    );
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  AUTH-ROUTEN  (vor checkAuth — kein Schutz nötig)
// ══════════════════════════════════════════════════════════════════════════════

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});
app.get('/login', (req, res) => res.redirect('/login.html'));

app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).send('Benutzername und Passwort erforderlich.');
  try {
    const hash = await bcrypt.hash(password, 10);
    db.run(
      'INSERT INTO users (username, password) VALUES (?, ?)',
      [username, hash],
      (err) => {
        if (err) return res.status(409).send('Benutzername bereits vergeben.');
        res.redirect('/login.html?registered=1');
      }
    );
  } catch {
    res.status(500).send('Serverfehler.');
  }
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).send('Benutzername und Passwort erforderlich.');
  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (err || !user) return res.status(401).send('Ungültige Anmeldedaten.');
    const match = await bcrypt.compare(password, user.password);
    if (!match)  return res.status(401).send('Ungültige Anmeldedaten.');
    req.session.userId   = user.id;
    req.session.username = user.username;
    req.session.role     = user.role || 'user';
    req.session.save(() => res.redirect('/'));
  });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login.html'));
});

// Gibt Username, Rolle und erlaubte Apps zurück
app.get('/api/me', checkAuth, (req, res) => {
  if (req.session.role === 'admin') {
    return res.json({ username: req.session.username, role: 'admin', apps: APP_SLUGS });
  }
  db.all('SELECT app_slug FROM app_permissions WHERE user_id = ?',
    [req.session.userId],
    (err, rows) => {
      res.json({
        username: req.session.username,
        role: req.session.role || 'user',
        apps: rows ? rows.map(r => r.app_slug) : []
      });
    }
  );
});

// ── Secrets ────────────────────────────────────────────────────────────────
app.get('/api/secrets', checkAuth, (req, res) => {
  db.all(
    'SELECT key_name, value FROM secrets WHERE user_id = ?',
    [req.session.userId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const result = {};
      rows.forEach(r => { result[r.key_name] = r.value; });
      res.json(result);
    }
  );
});

app.post('/api/secrets', checkAuth, (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key fehlt.' });
  db.run(
    'INSERT OR REPLACE INTO secrets (user_id, key_name, value) VALUES (?, ?, ?)',
    [req.session.userId, key, value ?? ''],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    }
  );
});

// ══════════════════════════════════════════════════════════════════════════════
//  DASHBOARD  (geschützt)
// ══════════════════════════════════════════════════════════════════════════════
app.use(checkAuth, express.static(path.join(__dirname, 'public')));


// ══════════════════════════════════════════════════════════════════════════════
//  APP: ADMIN-PANEL  →  /apps/admin
// ══════════════════════════════════════════════════════════════════════════════
app.use('/apps/admin', checkAuth, checkAdmin, express.static(path.join(__dirname, 'apps/admin')));

app.get('/api/admin/users', checkAuth, checkAdmin, (_req, res) => {
  db.all(`
    SELECT u.id, u.username, u.role, a.last_seen,
           GROUP_CONCAT(p.app_slug) AS app_slugs
    FROM users u
    LEFT JOIN user_activity   a ON a.user_id = u.id
    LEFT JOIN app_permissions p ON p.user_id = u.id
    GROUP BY u.id ORDER BY u.id
  `, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(r => ({
      id:        r.id,
      username:  r.username,
      role:      r.role,
      last_seen: r.last_seen || null,
      apps:      r.app_slugs ? r.app_slugs.split(',') : []
    })));
  });
});

app.patch('/api/admin/users/:id/role', checkAuth, checkAdmin, (req, res) => {
  const { role } = req.body;
  if (!['admin', 'user'].includes(role))
    return res.status(400).json({ error: 'Ungültige Rolle.' });
  if (parseInt(req.params.id) === req.session.userId && role !== 'admin')
    return res.status(400).json({ error: 'Eigene Admin-Rolle kann nicht entzogen werden.' });
  db.run('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.post('/api/admin/users/:id/apps/:slug', checkAuth, checkAdmin, (req, res) => {
  if (!APP_SLUGS.includes(req.params.slug))
    return res.status(400).json({ error: 'Unbekannte App.' });
  db.run('INSERT OR IGNORE INTO app_permissions (user_id, app_slug) VALUES (?, ?)',
    [req.params.id, req.params.slug],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    }
  );
});

app.delete('/api/admin/users/:id/apps/:slug', checkAuth, checkAdmin, (req, res) => {
  db.run('DELETE FROM app_permissions WHERE user_id = ? AND app_slug = ?',
    [req.params.id, req.params.slug],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    }
  );
});

app.delete('/api/admin/users/:id', checkAuth, checkAdmin, (req, res) => {
  if (parseInt(req.params.id) === req.session.userId)
    return res.status(400).json({ error: 'Du kannst dich nicht selbst löschen.' });
  db.run('DELETE FROM users WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'Nicht gefunden.' });
    res.json({ ok: true });
  });
});


// ══════════════════════════════════════════════════════════════════════════════
//  APP: PODCAST COMPRESSOR  →  /apps/podcast-compressor
//  Server-side FFmpeg + Google Drive upload
// ══════════════════════════════════════════════════════════════════════════════
app.use('/apps/podcast-compressor', checkAuth, checkAppAccess('podcast-compressor'),
  express.static(path.join(__dirname, 'apps/podcastCompressor')));


// ══════════════════════════════════════════════════════════════════════════════
//  APP: LATEX KONVERTER  →  /apps/latex-converter
//  Bild hochladen → Gemini Vision → LaTeX → PDF (pdflatex)
// ══════════════════════════════════════════════════════════════════════════════
app.use('/apps/latex-converter', checkAuth, checkAppAccess('latex-converter'), express.static(path.join(__dirname, 'apps/latexConverter')));

async function findLatexCompiler() {
  const hasPdflatex = await new Promise(r => execFile('pdflatex', ['--version'], err => r(!err)));
  if (hasPdflatex) return 'pdflatex';
  const hasTectonic = await new Promise(r => execFile(TECTONIC, ['--version'], err => r(!err)));
  if (hasTectonic) return TECTONIC;
  return null;
}

function runLatexCompiler(compiler, texFile, cwd) {
  const args = compiler === TECTONIC
    ? ['--chatter', 'minimal', texFile]
    : ['-interaction=nonstopmode', '-halt-on-error', '-output-directory', cwd, texFile];
  return new Promise((resolve, reject) => {
    execFile(compiler, args, { cwd, timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(path.basename(compiler) + ' Fehler: ' + (stderr || stdout || err.message)));
      else resolve(stdout);
    });
  });
}

app.post('/apps/latex-converter/compile', checkAuth, checkAppAccess('latex-converter'), async (req, res) => {
  const { latex, fileName } = req.body;
  if (!latex || typeof latex !== 'string')
    return res.status(400).json({ error: 'Kein LaTeX-Code übermittelt.' });

  const compiler = await findLatexCompiler();
  if (!compiler)
    return res.status(500).json({ error: 'Kein LaTeX-Compiler gefunden (pdflatex oder tectonic).' });

  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'latex-'));
  const texFile = path.join(tmpDir, 'main.tex');
  const pdfFile = path.join(tmpDir, 'main.pdf');
  const logFile = path.join(tmpDir, 'main.log');

  try {
    fs.writeFileSync(texFile, latex, 'utf8');
    await runLatexCompiler(compiler, texFile, tmpDir);
    if (compiler !== TECTONIC) await runLatexCompiler(compiler, texFile, tmpDir);

    if (!fs.existsSync(pdfFile)) {
      const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(-2000) : '';
      return res.status(500).json({ error: 'PDF wurde nicht erstellt.', log });
    }

    const pdfBuffer = fs.readFileSync(pdfFile);
    res.setHeader('Content-Type', 'application/pdf');
    const safeName = (fileName || 'vorlesungsnotizen').replace(/[^a-z0-9_\-]/gi, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(-3000) : '';
    res.status(500).json({ error: err.message, log });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});


// ══════════════════════════════════════════════════════════════════════════════
//  APP: LATEX STUDY  →  /apps/latex-study
//  PDF-Folien hochladen → Gemini → LaTeX-Zusammenfassung → PDF
// ══════════════════════════════════════════════════════════════════════════════
app.use('/apps/latex-study', checkAuth, checkAppAccess('latex-study'), express.static(path.join(__dirname, 'apps/latexStudy')));

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Nur PDF-Dateien erlaubt'), false);
  },
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ── Podcast Compressor — Google OAuth2 ────────────────────────────────────
const PODCAST_REDIRECT_URI = 'https://miniserver.taild78ddb.ts.net/apps/podcast-compressor/';

async function getOAuth2Client(userId) {
  const clientId     = await getSecret(userId, 'google_client_id');
  const clientSecret = await getSecret(userId, 'google_client_secret');
  if (!clientId || !clientSecret)
    throw new Error('Google Client-ID oder Client-Secret fehlen. Bitte im Dashboard unter Einstellungen eintragen.');
  return new google.auth.OAuth2(clientId, clientSecret, PODCAST_REDIRECT_URI);
}

async function getDriveAccessToken(userId) {
  const refreshToken = await getSecret(userId, 'google_refresh_token');
  if (!refreshToken) throw new Error('Kein Google Drive Token gespeichert. Bitte Drive verbinden.');
  const client = await getOAuth2Client(userId);
  client.setCredentials({ refresh_token: refreshToken });
  try {
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('Access Token konnte nicht erneuert werden.');
    return token;
  } catch (err) {
    if (String(err.message || err).includes('invalid_grant')) {
      throw new Error('[invalid_grant] Google Drive Verbindung abgelaufen. Bitte neu verbinden.');
    }
    throw err;
  }
}

// ── Podcast Compressor — server-side FFmpeg ─────────────────────────────────
const PODCAST_TMP = path.join(os.tmpdir(), 'podcast_jobs');
fs.mkdirSync(PODCAST_TMP, { recursive: true });

const podcastUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, PODCAST_TMP),
    filename:    (req, file, cb) => cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 * 1024 }, // 20 GB
});

function buildLatexDocument(title, subject, summary, date) {
  const safeTitle   = title.replace(/[_&%$#{}~^\\]/g, m => `\\${m}`);
  const safeSubject = subject.replace(/[_&%$#{}~^\\]/g, m => `\\${m}`);

  return `\\documentclass[12pt,a4paper]{article}

% ── Pakete ──────────────────────────────────────────────────────────────────
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage[ngerman]{babel}
\\usepackage{lmodern}
\\usepackage{microtype}
\\usepackage{geometry}
\\usepackage{xcolor}
\\usepackage{titling}
\\usepackage{titlesec}
\\usepackage{enumitem}
\\usepackage{booktabs}
\\usepackage{array}
\\usepackage{longtable}
\\usepackage{fancyhdr}
\\usepackage{hyperref}
\\usepackage{tcolorbox}
\\usepackage{mdframed}
\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage{graphicx}
\\usepackage{multicol}
\\usepackage{parskip}

% ── Seitenränder ────────────────────────────────────────────────────────────
\\geometry{top=2.5cm, bottom=2.5cm, left=2.5cm, right=2.5cm, headheight=15pt}

% ── Farben ──────────────────────────────────────────────────────────────────
\\definecolor{primary}{RGB}{26, 54, 93}
\\definecolor{accent}{RGB}{41, 128, 185}
\\definecolor{lightgray}{RGB}{245, 247, 250}
\\definecolor{darkgray}{RGB}{80, 80, 80}
\\definecolor{highlight}{RGB}{255, 243, 205}
\\definecolor{keyterm}{RGB}{231, 76, 60}

% ── Überschriften ───────────────────────────────────────────────────────────
\\titleformat{\\section}{\\large\\bfseries\\color{primary}}{\\thesection}{1em}{}[\\titlerule]
\\titleformat{\\subsection}{\\normalsize\\bfseries\\color{accent}}{\\thesubsection}{1em}{}
\\titleformat{\\subsubsection}{\\normalsize\\itshape\\color{darkgray}}{\\thesubsubsection}{1em}{}

% ── Kopf-/Fußzeile ──────────────────────────────────────────────────────────
\\pagestyle{fancy}
\\fancyhf{}
\\fancyhead[L]{\\small\\color{darkgray}\\textit{${safeSubject}}}
\\fancyhead[R]{\\small\\color{darkgray}\\textit{Zusammenfassung}}
\\fancyfoot[C]{\\small\\color{darkgray}\\thepage}
\\renewcommand{\\headrulewidth}{0.4pt}
\\renewcommand{\\footrulewidth}{0pt}

% ── tcolorbox Styles ────────────────────────────────────────────────────────
\\tcbuselibrary{skins, breakable}
\\newtcolorbox{definitionbox}{colback=lightgray, colframe=accent, arc=4pt, left=8pt, right=8pt, top=6pt, bottom=6pt, breakable}
\\newtcolorbox{keybox}{colback=highlight, colframe=keyterm!60, arc=3pt, left=6pt, right=6pt, top=4pt, bottom=4pt, breakable}
\\newtcolorbox{infobox}[1]{title=#1, colback=primary!5, colframe=primary!60, arc=4pt, left=8pt, right=8pt, top=6pt, bottom=6pt, coltitle=white, attach boxed title to top left={yshift=-2mm}, boxed title style={colback=primary}, breakable}

% ── Hyperlinks ──────────────────────────────────────────────────────────────
\\hypersetup{colorlinks=true, linkcolor=accent, urlcolor=accent, citecolor=accent, pdftitle={${safeTitle}}}

% ── Metadaten ───────────────────────────────────────────────────────────────
\\title{{\\color{primary}\\Large\\bfseries Zusammenfassung}\\\\[0.3em]{\\color{accent}\\huge\\bfseries ${safeTitle}}\\\\[0.5em]{\\large\\color{darkgray}\\textit{${safeSubject}}}}
\\author{Erstellt mit KI-Unterstützung}
\\date{${date}}

% ════════════════════════════════════════════════════════════════════════════
\\begin{document}
% ════════════════════════════════════════════════════════════════════════════

\\maketitle
\\thispagestyle{fancy}

\\begin{tcolorbox}[colback=primary!8, colframe=primary, arc=5pt, title={\\bfseries\\color{white} Über diese Zusammenfassung}, coltitle=white, attach boxed title to top left={yshift=-2mm}, boxed title style={colback=primary}]
Diese Zusammenfassung wurde automatisch aus den Vorlesungsfolien generiert.
\\end{tcolorbox}

\\tableofcontents
\\newpage

${summary}

\\end{document}
`;
}

async function summarizeWithGemini(apiKey, pdfBuffer, fileName, subjectHint) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });

  const pdfBase64 = pdfBuffer.toString('base64');
  const prompt = `Du bist ein Experte für BWL-Fächer (Wirtschaftsinformatik, Marketing, Controlling, Rechnungswesen, Management, etc.).

Analysiere die folgenden Vorlesungsfolien und erstelle eine SEHR AUSFÜHRLICHE und STRUKTURIERTE Zusammenfassung auf Deutsch.

Fach-Hinweis: ${subjectHint || 'BWL / Wirtschaft'}
Dateiname: ${fileName}

WICHTIGE ANFORDERUNGEN:
1. Die Zusammenfassung muss in **LaTeX-Syntax** geschrieben sein (kein \\documentclass etc., nur den Body-Inhalt)
2. Nutze \\section{}, \\subsection{}, \\subsubsection{} für die Struktur
3. Verwende folgende LaTeX-Umgebungen:
   - \\begin{definitionbox}...\\end{definitionbox} für Definitionen
   - \\begin{keybox}...\\end{keybox} für wichtige Merksätze/Kernaussagen
   - \\begin{infobox}{Titel}...\\end{infobox} für Erklärungen/Hintergründe
4. Sei SEHR AUSFÜHRLICH - erkläre jeden Begriff und jeden Zusammenhang
5. Decke ALLE Themen der Folien ab
6. Füge am Ende \\section{Zusammenfassung \\& Prüfungsrelevantes} hinzu

Beginne direkt mit dem ersten \\section{} ohne Präambel.`;

  const result = await model.generateContent([
    { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } },
    { text: prompt }
  ]);
  return result.response.text();
}

async function compileLaTeX(latexContent) {
  const compiler = await findLatexCompiler();
  if (!compiler) throw new Error('Kein LaTeX-Compiler gefunden (pdflatex oder tectonic).');

  const tmpDir  = tmp.dirSync({ unsafeCleanup: true });
  const texFile = path.join(tmpDir.name, 'summary.tex');
  const pdfFile = path.join(tmpDir.name, 'summary.pdf');

  fs.writeFileSync(texFile, latexContent, 'utf8');
  try {
    await runLatexCompiler(compiler, texFile, tmpDir.name);
    if (compiler !== TECTONIC) await runLatexCompiler(compiler, texFile, tmpDir.name);
    if (!fs.existsSync(pdfFile)) throw new Error('PDF wurde nicht erstellt.');
    const pdfBuffer = fs.readFileSync(pdfFile);
    tmpDir.removeCallback();
    return pdfBuffer;
  } catch (err) {
    tmpDir.removeCallback();
    throw err;
  }
}

app.post('/apps/latex-study/api/summarize', checkAuth, checkAppAccess('latex-study'), upload.single('pdf'), async (req, res) => {
  try {
    const { apiKey, subject, title } = req.body;
    if (!req.file) return res.status(400).json({ error: 'Keine PDF-Datei hochgeladen.' });
    if (!apiKey)   return res.status(400).json({ error: 'Kein Gemini API-Key angegeben.' });

    const fileName   = req.file.originalname;
    const docTitle   = title   || path.basename(fileName, '.pdf');
    const docSubject = subject || 'BWL';
    const date = new Date().toLocaleDateString('de-DE', { year: 'numeric', month: 'long', day: 'numeric' });

    console.log(`[→] Zusammenfassung: ${fileName}`);
    const summary  = await summarizeWithGemini(apiKey, req.file.buffer, fileName, docSubject);
    const latexDoc = buildLatexDocument(docTitle, docSubject, summary, date);

    let pdfBuffer = null;
    try { pdfBuffer = await compileLaTeX(latexDoc); } catch (_) {}

    const responseData = { success: true, latex: latexDoc, fileName: docTitle, subject: docSubject, charCount: summary.length };
    if (pdfBuffer) responseData.pdf = pdfBuffer.toString('base64');
    else responseData.pdfError = 'pdflatex nicht installiert. LaTeX-Code kann manuell kompiliert werden.';

    res.json(responseData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/apps/latex-study/api/latex-only', checkAuth, checkAppAccess('latex-study'), upload.single('pdf'), async (req, res) => {
  try {
    const { apiKey, subject, title } = req.body;
    if (!req.file) return res.status(400).json({ error: 'Keine PDF-Datei hochgeladen.' });
    if (!apiKey)   return res.status(400).json({ error: 'Kein Gemini API-Key angegeben.' });

    const fileName   = req.file.originalname;
    const docTitle   = title   || path.basename(fileName, '.pdf');
    const docSubject = subject || 'BWL';
    const date = new Date().toLocaleDateString('de-DE', { year: 'numeric', month: 'long', day: 'numeric' });

    const summary  = await summarizeWithGemini(apiKey, req.file.buffer, fileName, docSubject);
    const latexDoc = buildLatexDocument(docTitle, docSubject, summary, date);

    res.json({ success: true, latex: latexDoc, fileName: docTitle, subject: docSubject });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/apps/latex-study/api/compile-pdf', checkAuth, checkAppAccess('latex-study'), async (req, res) => {
  try {
    const { latex, fileName } = req.body;
    if (!latex) return res.status(400).json({ error: 'Kein LaTeX-Code angegeben.' });

    const pdfBuffer = await compileLaTeX(latex);
    const safeName  = (fileName || 'zusammenfassung').replace(/[^a-z0-9_\-]/gi, '_') + '.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ══════════════════════════════════════════════════════════════════════════════
//  PODCAST COMPRESSOR — API
// ══════════════════════════════════════════════════════════════════════════════

function podcastDbSet(jobId, fields) {
  return new Promise(resolve => {
    const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    db.run(`UPDATE podcast_jobs SET ${sets} WHERE id = ?`, [...Object.values(fields), jobId], resolve);
  });
}

function getVideoDurationSec(filePath) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', filePath],
      { timeout: 30_000 }, (err, stdout) => {
        if (err) return reject(new Error('ffprobe fehlgeschlagen: ' + err.message));
        try { resolve(parseFloat(JSON.parse(stdout).format.duration) || 3600); }
        catch { resolve(3600); }
      });
  });
}

function runFFmpeg(jobId, inputPath, outputPath, videoBitrate, audioBitrate, duration) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-i', inputPath,
      '-c:v', 'libx264', '-preset', 'fast',
      '-threads', '0',
      '-b:v', `${videoBitrate}k`,
      '-maxrate', `${Math.round(videoBitrate * 1.5)}k`,
      '-bufsize', `${Math.round(videoBitrate * 2)}k`,
      '-c:a', 'aac', '-b:a', `${audioBitrate}k`,
      '-movflags', '+faststart',
      '-progress', 'pipe:1',
      '-y', outputPath,
    ]);

    const TIMEOUT_MS = 10 * 60 * 1000;
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      podcastDbSet(jobId, { status: 'error', progress_msg: 'FFmpeg Timeout (>10 Min)' });
      reject(new Error('FFmpeg Timeout nach 10 Minuten'));
    }, TIMEOUT_MS);

    let buf = '';
    let lastStderr = '';

    proc.stdout.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (line.startsWith('progress=end')) {
          podcastDbSet(jobId, { progress_pct: 99, progress_msg: 'Finalisiere…' });
          continue;
        }
        const m = line.match(/^out_time_ms=(\d+)/);
        if (m && duration > 0) {
          const pct = Math.min(98, Math.round(parseInt(m[1]) / 1_000_000 / duration * 100));
          podcastDbSet(jobId, { progress_pct: pct, progress_msg: `Komprimiere… ${pct}%` });
        }
      }
    });

    proc.stderr.on('data', chunk => {
      const text = chunk.toString();
      lastStderr = text;
      console.error('[ffmpeg stderr]', text.trimEnd());
    });

    proc.on('error', err => { clearTimeout(timer); reject(new Error('FFmpeg Fehler: ' + err.message)); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error(`FFmpeg Code ${code}: ${lastStderr.slice(-300)}`));
    });
  });
}

async function driveGetOrCreateFolder(token, folderPath) {
  const parts = folderPath.split('/').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return 'root';
  let parentId = 'root';
  for (const part of parts) {
    const q = `name='${part.replace(/'/g,"\\'")}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
    const listRes = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`,
      { headers: { Authorization: 'Bearer ' + token } }
    );
    if (!listRes.ok) throw new Error('Drive Fehler ' + listRes.status);
    const list = await listRes.json();
    if (list.files?.length) { parentId = list.files[0].id; continue; }
    const mkRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: part, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
    });
    if (!mkRes.ok) throw new Error('Ordner konnte nicht erstellt werden');
    parentId = (await mkRes.json()).id;
  }
  return parentId;
}

async function driveUploadFile(token, filePath, fileName, folderPath) {
  const folderId = await driveGetOrCreateFolder(token, folderPath);
  const fileSize = fs.statSync(filePath).size;

  // Initiate resumable upload session
  const initRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'X-Upload-Content-Type': 'video/mp4',
      'X-Upload-Content-Length': String(fileSize),
    },
    body: JSON.stringify({ name: fileName, parents: [folderId] }),
  });
  if (!initRes.ok) throw new Error('Drive Upload Init fehlgeschlagen: ' + initRes.status);
  const uploadUrl = initRes.headers.get('location');

  // Upload file body
  const fileBuffer = await fs.promises.readFile(filePath);
  const uploadRes  = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(fileSize) },
    body: fileBuffer,
  });
  if (!uploadRes.ok) throw new Error('Drive Upload fehlgeschlagen: ' + uploadRes.status);
  return (await uploadRes.json()).id;
}

async function runPodcastJob(jobId, inputPath, originalName, targetMb, driveFolder, userId) {
  const outputPath = inputPath + '_out.mp4';
  try {
    const inputStats = fs.statSync(inputPath);
    const inputMb    = inputStats.size / 1024 / 1024;
    const targetBytes = targetMb * 1024 * 1024;

    await podcastDbSet(jobId, { status: 'compressing', progress_pct: 0, progress_msg: 'Analysiere Video…', original_mb: inputMb });

    let finalPath = inputPath;
    let outName   = originalName;

    if (inputStats.size > targetBytes) {
      const duration     = await getVideoDurationSec(inputPath);
      const audioBitrate = 96;
      const videoKbps    = Math.max(100, Math.floor(((targetBytes * 0.93 - (audioBitrate * 1000 / 8) * duration) * 8) / (duration * 1000)));
      console.log(`[podcast] Job ${jobId}: ${inputMb.toFixed(1)} MB → Ziel ${targetMb} MB, Dauer ${duration.toFixed(0)}s, Video ${videoKbps} kbps, Audio ${audioBitrate} kbps`);
      await podcastDbSet(jobId, { progress_msg: `Komprimiere… 0% (${videoKbps} kbps)` });
      await runFFmpeg(jobId, inputPath, outputPath, videoKbps, audioBitrate, duration);
      finalPath = outputPath;
      outName   = originalName.replace(/\.[^.]+$/, '') + '_compressed.mp4';
    } else {
      await podcastDbSet(jobId, { progress_pct: 99, progress_msg: 'Datei bereits unter Zielgrösse, überspringe Komprimierung' });
    }

    const outputMb = fs.statSync(finalPath).size / 1024 / 1024;
    await podcastDbSet(jobId, { status: 'uploading', progress_pct: 100, progress_msg: `Hochladen… (${outputMb.toFixed(0)} MB)`, output_mb: outputMb });

    const accessToken = await getDriveAccessToken(userId);
    const driveId = await driveUploadFile(accessToken, finalPath, outName, driveFolder || 'Podcast Compressor');
    await podcastDbSet(jobId, { status: 'done', progress_pct: 100, progress_msg: 'Fertig!', drive_file_id: driveId, drive_filename: outName, output_mb: outputMb });

  } catch (err) {
    await podcastDbSet(jobId, { status: 'error', error_msg: err.message });
  } finally {
    try { fs.unlinkSync(inputPath);  } catch (_) {}
    try { fs.unlinkSync(outputPath); } catch (_) {}
  }
}

// POST — Video hochladen und Job starten
app.post('/apps/podcast-compressor/api/upload', checkAuth, checkAppAccess('podcast-compressor'),
  podcastUpload.single('video'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Keine Videodatei.' });

    // Check FFmpeg is installed
    const ffmpegOk = await new Promise(r => execFile('ffmpeg', ['-version'], err => r(!err)));
    if (!ffmpegOk) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(503).json({ error: 'FFmpeg ist nicht installiert. Bitte: sudo apt-get install -y ffmpeg' });
    }

    const { drive_folder = '', target_mb = '195' } = req.body;
    const uid = req.session.userId;

    // Verify a refresh token exists before queuing
    const hasToken = await getSecret(uid, 'google_refresh_token');
    if (!hasToken) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(400).json({ error: 'Google Drive nicht verbunden. Bitte zuerst verbinden.' });
    }

    db.run(
      `INSERT INTO podcast_jobs (user_id, original_name, status, drive_folder, target_mb) VALUES (?, ?, 'pending', ?, ?)`,
      [uid, req.file.originalname, drive_folder, parseInt(target_mb) || 195],
      function(err) {
        if (err) { try { fs.unlinkSync(req.file.path); } catch (_) {} return res.status(500).json({ error: err.message }); }
        const jobId = this.lastID;
        res.json({ jobId });
        setImmediate(() => runPodcastJob(jobId, req.file.path, req.file.originalname, parseInt(target_mb) || 195, drive_folder, uid));
      }
    );
  }
);

// GET — Jobs auflisten
app.get('/apps/podcast-compressor/api/jobs', checkAuth, checkAppAccess('podcast-compressor'), (req, res) => {
  db.all(
    `SELECT id, original_name, status, progress_pct, progress_msg, error_msg, drive_filename, drive_file_id, original_mb, output_mb, created_at
     FROM podcast_jobs WHERE user_id = ? ORDER BY id DESC LIMIT 30`,
    [req.session.userId], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// DELETE — Job entfernen
app.delete('/apps/podcast-compressor/api/jobs/:id', checkAuth, checkAppAccess('podcast-compressor'), (req, res) => {
  const id = parseInt(req.params.id);
  db.run('DELETE FROM podcast_jobs WHERE id = ? AND user_id = ?', [id, req.session.userId],
    err => err ? res.status(500).json({ error: err.message }) : res.json({ ok: true }));
});

// POST — OAuth2 Authorization Code eintauschen
app.post('/apps/podcast-compressor/api/auth/google', checkAuth, checkAppAccess('podcast-compressor'), async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Kein Authorization Code.' });
  try {
    const client = await getOAuth2Client(req.session.userId);
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      return res.status(400).json({ error: 'Kein Refresh Token erhalten. Stelle sicher dass access_type=offline und prompt=consent gesetzt sind.' });
    }
    await new Promise((resolve, reject) => {
      db.run('INSERT OR REPLACE INTO secrets (user_id, key_name, value) VALUES (?, ?, ?)',
        [req.session.userId, 'google_refresh_token', tokens.refresh_token],
        err => err ? reject(err) : resolve());
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET — Drive Verbindungsstatus prüfen
app.get('/apps/podcast-compressor/api/drive-status', checkAuth, checkAppAccess('podcast-compressor'), async (req, res) => {
  const token = await getSecret(req.session.userId, 'google_refresh_token');
  res.json({ connected: !!token });
});

// POST — Drive trennen (Refresh Token löschen)
app.post('/apps/podcast-compressor/api/drive-disconnect', checkAuth, checkAppAccess('podcast-compressor'), (req, res) => {
  db.run('DELETE FROM secrets WHERE user_id = ? AND key_name = ?',
    [req.session.userId, 'google_refresh_token'],
    err => err ? res.status(500).json({ error: err.message }) : res.json({ ok: true }));
});


// ══════════════════════════════════════════════════════════════════════════════
//  APP: TRESOR  →  /apps/vault
// ══════════════════════════════════════════════════════════════════════════════
app.use('/apps/vault', checkAuth, checkAppAccess('vault'),
  express.static(path.join(__dirname, 'apps/vault')));

// GET — Schlüsseldatei herunterladen (nur Admins)
app.get('/apps/vault/api/download-key', checkAuth, checkAdmin, (req, res) => {
  res.download(VAULT_KEY_PATH, 'vault.key');
});

// GET — alle Einträge (entschlüsselt)
app.get('/apps/vault/api/entries', checkAuth, checkAppAccess('vault'), (req, res) => {
  db.all(
    `SELECT id, label, category, value_enc, notes, created_at
     FROM vault_entries WHERE user_id = ? ORDER BY category COLLATE NOCASE, label COLLATE NOCASE`,
    [req.session.userId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const uid = req.session.userId;
      res.json(rows.map(r => {
        let value = '';
        try { value = vaultDecrypt(r.value_enc, uid); } catch {}
        return { id: r.id, label: r.label, category: r.category, value, notes: r.notes, created_at: r.created_at };
      }));
    }
  );
});

// POST — Eintrag erstellen
app.post('/apps/vault/api/entries', checkAuth, checkAppAccess('vault'), (req, res) => {
  const { label, value, category = '', notes = '' } = req.body;
  if (!label?.trim() || !value) return res.status(400).json({ error: 'Bezeichnung und Wert sind erforderlich.' });
  db.run(
    'INSERT INTO vault_entries (user_id, label, category, value_enc, notes) VALUES (?, ?, ?, ?, ?)',
    [req.session.userId, label.trim(), category.trim(), vaultEncrypt(value, req.session.userId), notes.trim()],
    function(err) {
      err ? res.status(500).json({ error: err.message }) : res.json({ id: this.lastID });
    }
  );
});

// PUT — Eintrag aktualisieren
app.put('/apps/vault/api/entries/:id', checkAuth, checkAppAccess('vault'), (req, res) => {
  const { label, value, category = '', notes = '' } = req.body;
  if (!label?.trim() || !value) return res.status(400).json({ error: 'Bezeichnung und Wert sind erforderlich.' });
  db.run(
    `UPDATE vault_entries SET label=?, category=?, value_enc=?, notes=?, updated_at=datetime('now')
     WHERE id=? AND user_id=?`,
    [label.trim(), category.trim(), vaultEncrypt(value, req.session.userId), notes.trim(), parseInt(req.params.id), req.session.userId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      this.changes === 0 ? res.status(404).json({ error: 'Nicht gefunden.' }) : res.json({ ok: true });
    }
  );
});

// DELETE — Eintrag löschen
app.delete('/apps/vault/api/entries/:id', checkAuth, checkAppAccess('vault'), (req, res) => {
  db.run('DELETE FROM vault_entries WHERE id=? AND user_id=?',
    [parseInt(req.params.id), req.session.userId],
    err => err ? res.status(500).json({ error: err.message }) : res.json({ ok: true }));
});


// ══════════════════════════════════════════════════════════════════════════════
//  APP: HAUSTIER-MEDIKAMENTEN-TRACKER  →  /apps/pet-meds
// ══════════════════════════════════════════════════════════════════════════════
app.use('/apps/pet-meds', checkAuth, checkAppAccess('pet-meds'), express.static(path.join(__dirname, 'apps/petMeds')));

function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Timestamp der letzten Änderung – für Client-seitiges Polling
app.get('/apps/pet-meds/api/last-updated', checkAuth, checkAppAccess('pet-meds'), (req, res) => {
  res.json({ ts: petMedsLastUpdated });
});

// Alle Medikamente des Tages – global (kein user_id-Filter)
app.get('/apps/pet-meds/api/today', checkAuth, checkAppAccess('pet-meds'), (req, res) => {
  const today = localDate();
  db.all(
    `SELECT s.id, s.pet_name, s.med_name, s.dose, s.time_of_day,
            l.status
     FROM medication_schedules s
     LEFT JOIN medication_daily_logs l ON l.schedule_id = s.id AND l.log_date = ?
     ORDER BY s.time_of_day, s.pet_name`,
    [today],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// Alle Basis-Pläne – global
app.get('/apps/pet-meds/api/schedules', checkAuth, checkAppAccess('pet-meds'), (req, res) => {
  db.all(
    'SELECT id, pet_name, med_name, dose, time_of_day, created_at FROM medication_schedules ORDER BY time_of_day, pet_name',
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// Neuen Medikamentenplan anlegen – global (kein user_id)
app.post('/apps/pet-meds/api/schedules', checkAuth, checkAppAccess('pet-meds'), (req, res) => {
  const { pet_name, med_name, dose, time_of_day } = req.body;
  if (!pet_name || !med_name || !dose || !time_of_day)
    return res.status(400).json({ error: 'Alle Felder sind erforderlich.' });
  db.run(
    'INSERT INTO medication_schedules (pet_name, med_name, dose, time_of_day) VALUES (?, ?, ?, ?)',
    [pet_name.trim(), med_name.trim(), dose.trim(), time_of_day],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      petMedsLastUpdated = Date.now();
      res.json({ id: this.lastID, pet_name: pet_name.trim(), med_name: med_name.trim(), dose: dose.trim(), time_of_day });
    }
  );
});

// Medikamentenplan dauerhaft löschen – global
app.delete('/apps/pet-meds/api/schedules/:id', checkAuth, checkAppAccess('pet-meds'), (req, res) => {
  db.run(
    'DELETE FROM medication_schedules WHERE id = ?',
    [req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: 'Nicht gefunden.' });
      petMedsLastUpdated = Date.now();
      res.json({ ok: true });
    }
  );
});

// Tages-Log setzen (done / skipped) oder entfernen (status: null) – global
app.patch('/apps/pet-meds/api/today/:id', checkAuth, checkAppAccess('pet-meds'), (req, res) => {
  const { status } = req.body;
  const today = localDate();
  const by    = req.session.username;
  db.get(
    'SELECT id FROM medication_schedules WHERE id = ?',
    [req.params.id],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'Nicht gefunden.' });
      if (!status) {
        db.run(
          'DELETE FROM medication_daily_logs WHERE schedule_id = ? AND log_date = ?',
          [req.params.id, today],
          (e) => {
            if (e) return res.status(500).json({ error: e.message });
            petMedsLastUpdated = Date.now();
            res.json({ ok: true, by });
          }
        );
      } else {
        db.run(
          'INSERT OR REPLACE INTO medication_daily_logs (schedule_id, log_date, status) VALUES (?, ?, ?)',
          [req.params.id, today, status],
          (e) => {
            if (e) return res.status(500).json({ error: e.message });
            petMedsLastUpdated = Date.now();
            res.json({ ok: true, by });
          }
        );
      }
    }
  );
});


// ══════════════════════════════════════════════════════════════════════════════
//  HELPER: Secret aus DB lesen
// ══════════════════════════════════════════════════════════════════════════════
function getSecret(userId, keyName) {
  return new Promise(resolve => {
    db.get('SELECT value FROM secrets WHERE user_id = ? AND key_name = ?',
      [userId, keyName],
      (err, row) => resolve(row ? row.value : null)
    );
  });
}


// ══════════════════════════════════════════════════════════════════════════════
//  APP: SMART HOME  →  /apps/smart-home
//  Proxy zur Home Assistant REST API (http://localhost:8123)
// ══════════════════════════════════════════════════════════════════════════════
app.use('/apps/smart-home', checkAuth, checkAppAccess('smart-home'),
  express.static(path.join(__dirname, 'apps/smarthome'))
);

const HA_HOST = 'localhost';
const HA_PORT = 8123;

function haRequest(token, method, haPath, body = null) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const options = {
      hostname: HA_HOST,
      port:     HA_PORT,
      path:     haPath,
      method,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    };
    if (postData) options.headers['Content-Length'] = Buffer.byteLength(postData);

    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// GET /apps/smart-home/api/entities — gefilterte Geräte + optionale Raum-Namen
app.get('/apps/smart-home/api/entities', checkAuth, checkAppAccess('smart-home'), async (req, res) => {
  const token = await getSecret(req.session.userId, 'ha_token');
  if (!token) return res.status(400).json({ error: 'Kein HA-Token konfiguriert. Bitte im Dashboard unter API-Schlüssel eintragen.' });

  const RELEVANT  = new Set(['switch', 'light', 'lock', 'sensor']);
  const SEN_CLASS = new Set(['temperature', 'humidity', 'battery']);

  try {
    const { status, data } = await haRequest(token, 'GET', '/api/states');
    if (status === 401) return res.status(401).json({ error: 'HA-Token ungültig oder abgelaufen.' });
    if (status !== 200) return res.status(502).json({ error: `Home Assistant antwortete mit HTTP ${status}` });

    const entities = data
      .filter(e => {
        const domain = e.entity_id.split('.')[0];
        if (!RELEVANT.has(domain)) return false;
        if (domain === 'sensor') return SEN_CLASS.has(e.attributes.device_class);
        return true;
      })
      .map(e => ({
        entity_id: e.entity_id,
        domain:    e.entity_id.split('.')[0],
        state:     e.state,
        attributes: {
          friendly_name:            e.attributes.friendly_name            ?? null,
          brightness:               e.attributes.brightness               ?? null,
          device_class:             e.attributes.device_class             ?? null,
          unit_of_measurement:      e.attributes.unit_of_measurement      ?? null,
          switchbot_subdevice_type: e.attributes.switchbot_subdevice_type ?? null,
        }
      }));

    // Raum-Namen per HA-Template-API ermitteln (best effort)
    const areas = {};
    if (entities.length > 0) {
      try {
        const template =
          `{{ [${entities.map(e => `area_name('${e.entity_id}') or ''`).join(',')}] | to_json }}`;
        const tr = await haRequest(token, 'POST', '/api/template', { template });
        if (tr.status === 200) {
          const names = Array.isArray(tr.data) ? tr.data : JSON.parse(tr.data);
          entities.forEach((e, i) => { if (names[i]) areas[e.entity_id] = names[i]; });
        }
      } catch (_) {}
    }

    res.json({ entities, areas });
  } catch (err) {
    res.status(503).json({ error: 'Home Assistant nicht erreichbar: ' + err.message });
  }
});

// POST /apps/smart-home/api/call-service — HA-Dienst aufrufen (whitelist)
app.post('/apps/smart-home/api/call-service', checkAuth, checkAppAccess('smart-home'), async (req, res) => {
  const token = await getSecret(req.session.userId, 'ha_token');
  if (!token) return res.status(400).json({ error: 'Kein HA-Token konfiguriert.' });

  const { domain, service, entity_id, service_data } = req.body;
  if (!domain || !service || !entity_id)
    return res.status(400).json({ error: 'domain, service und entity_id sind erforderlich.' });

  const ALLOWED = {
    switch: ['turn_on', 'turn_off', 'toggle'],
    light:  ['turn_on', 'turn_off', 'toggle'],
  };
  if (!ALLOWED[domain] || !ALLOWED[domain].includes(service))
    return res.status(400).json({ error: `Dienst ${domain}.${service} nicht erlaubt.` });

  const body = { entity_id };
  if (domain === 'light' && service === 'turn_on' && service_data?.brightness !== undefined) {
    const b = parseInt(service_data.brightness);
    if (!isNaN(b) && b >= 1 && b <= 255) body.brightness = b;
  }

  try {
    const { status, data } = await haRequest(token, 'POST', `/api/services/${domain}/${service}`, body);
    if (status === 401) return res.status(401).json({ error: 'HA-Token ungültig.' });
    if (status > 299)   return res.status(502).json({ error: `HA-Fehler: HTTP ${status}`, data });
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ error: 'Home Assistant nicht erreichbar: ' + err.message });
  }
});

// GET /apps/smart-home/api/device-names — benutzerdefinierte Gerätenamen laden
app.get('/apps/smart-home/api/device-names', checkAuth, checkAppAccess('smart-home'), (req, res) => {
  db.all('SELECT entity_id, custom_name FROM smarthome_device_names WHERE user_id = ?',
    [req.session.userId], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const result = {};
      rows.forEach(r => { result[r.entity_id] = r.custom_name; });
      res.json(result);
    });
});

// POST /apps/smart-home/api/device-names — Gerätenamen speichern / löschen
app.post('/apps/smart-home/api/device-names', checkAuth, checkAppAccess('smart-home'), (req, res) => {
  const { entity_id, custom_name } = req.body;
  if (!entity_id) return res.status(400).json({ error: 'entity_id erforderlich.' });
  if (custom_name) {
    db.run('INSERT OR REPLACE INTO smarthome_device_names (user_id, entity_id, custom_name) VALUES (?, ?, ?)',
      [req.session.userId, entity_id, custom_name],
      err => err ? res.status(500).json({ error: err.message }) : res.json({ ok: true }));
  } else {
    db.run('DELETE FROM smarthome_device_names WHERE user_id = ? AND entity_id = ?',
      [req.session.userId, entity_id],
      err => err ? res.status(500).json({ error: err.message }) : res.json({ ok: true }));
  }
});

// GET /apps/smart-home/api/group-order — gespeicherte Gruppenreihenfolge laden
app.get('/apps/smart-home/api/group-order', checkAuth, checkAppAccess('smart-home'), (req, res) => {
  db.all('SELECT group_name FROM smarthome_group_order WHERE user_id = ? ORDER BY sort_order',
    [req.session.userId], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows.map(r => r.group_name));
    });
});

// POST /apps/smart-home/api/group-order — Gruppenreihenfolge speichern
app.post('/apps/smart-home/api/group-order', checkAuth, checkAppAccess('smart-home'), (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order muss ein Array sein.' });
  const uid = req.session.userId;
  db.run('DELETE FROM smarthome_group_order WHERE user_id = ?', [uid], err => {
    if (err) return res.status(500).json({ error: err.message });
    const stmt = db.prepare('INSERT INTO smarthome_group_order (user_id, group_name, sort_order) VALUES (?, ?, ?)');
    order.forEach((name, i) => stmt.run(uid, name, i));
    stmt.finalize(err => err ? res.status(500).json({ error: err.message }) : res.json({ ok: true }));
  });
});

// GET /apps/smart-home/api/scenes — Szenen laden
app.get('/apps/smart-home/api/scenes', checkAuth, checkAppAccess('smart-home'), (req, res) => {
  db.all('SELECT id, name, emoji, entity_id, sort_order FROM smarthome_scenes WHERE user_id = ? ORDER BY sort_order, id',
    [req.session.userId], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
});

// POST /apps/smart-home/api/scenes — Szene hinzufügen
app.post('/apps/smart-home/api/scenes', checkAuth, checkAppAccess('smart-home'), (req, res) => {
  const { name, emoji, entity_id } = req.body;
  if (!name || !entity_id) return res.status(400).json({ error: 'name und entity_id erforderlich.' });
  const safeEmoji = (emoji || '🎬').trim().slice(0, 8);
  db.run('SELECT MAX(sort_order) AS m FROM smarthome_scenes WHERE user_id = ?', [req.session.userId], (_, row) => {
    const next = (row?.m ?? -1) + 1;
    db.run('INSERT INTO smarthome_scenes (user_id, name, emoji, entity_id, sort_order) VALUES (?, ?, ?, ?, ?)',
      [req.session.userId, name.trim().slice(0, 60), safeEmoji, entity_id.trim(), next],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ok: true, id: this.lastID });
      });
  });
});

// DELETE /apps/smart-home/api/scenes/:id — Szene entfernen
app.delete('/apps/smart-home/api/scenes/:id', checkAuth, checkAppAccess('smart-home'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Ungültige ID.' });
  db.run('DELETE FROM smarthome_scenes WHERE id = ? AND user_id = ?', [id, req.session.userId],
    err => err ? res.status(500).json({ error: err.message }) : res.json({ ok: true }));
});

// POST /apps/smart-home/api/scenes/trigger — Automation auslösen
app.post('/apps/smart-home/api/scenes/trigger', checkAuth, checkAppAccess('smart-home'), async (req, res) => {
  const token = await getSecret(req.session.userId, 'ha_token');
  if (!token) return res.status(400).json({ error: 'Kein HA-Token konfiguriert.' });

  const { entity_id } = req.body;
  if (!entity_id || !entity_id.startsWith('automation.'))
    return res.status(400).json({ error: 'entity_id muss eine automation.* sein.' });

  try {
    const { status } = await haRequest(token, 'POST', '/api/services/automation/trigger',
      { entity_id, skip_condition: true });
    if (status === 401) return res.status(401).json({ error: 'HA-Token ungültig.' });
    if (status !== 200 && status !== 204)
      return res.status(502).json({ error: `HA antwortete mit HTTP ${status}` });
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ error: 'HA nicht erreichbar: ' + err.message });
  }
});


// ══════════════════════════════════════════════════════════════════════════════
//  APP: SERVER MONITOR  →  /apps/server-monitor
//  Systemmetriken: CPU, RAM, Disk, Tailscale, Netzwerk, Prozesse
// ══════════════════════════════════════════════════════════════════════════════
app.use('/apps/server-monitor', checkAuth, checkAppAccess('server-monitor'),
  express.static(path.join(__dirname, 'apps/server-monitor')));

function readProcStat() {
  const lines = fs.readFileSync('/proc/stat', 'utf8').split('\n');
  const result = [];
  for (const line of lines) {
    if (!line.startsWith('cpu')) break;
    const parts = line.trim().split(/\s+/);
    const vals  = parts.slice(1).map(Number);
    const idle  = vals[3] + (vals[4] || 0); // idle + iowait
    const total = vals.reduce((a, b) => a + b, 0);
    result.push({ name: parts[0], idle, total });
  }
  return result;
}

app.get('/apps/server-monitor/api/stats', checkAuth, checkAppAccess('server-monitor'), async (req, res) => {
  try {
    // CPU: zwei Messungen mit 250ms Abstand für akkurate Werte
    const stat1 = readProcStat();
    await new Promise(r => setTimeout(r, 250));
    const stat2 = readProcStat();

    const cpuList = stat2.map((s2, i) => {
      const s1     = stat1[i];
      const dtotal = s2.total - s1.total;
      const didle  = s2.idle  - s1.idle;
      return { name: s2.name, usage: dtotal > 0 ? Math.round((1 - didle / dtotal) * 1000) / 10 : 0 };
    });

    // RAM
    const totalMem = os.totalmem();
    const freeMem  = os.freemem();

    // Uptime & Load Average
    const uptime  = Math.floor(os.uptime());
    const loadAvg = os.loadavg();

    // Disk
    const dfOut = await new Promise((resolve, reject) =>
      exec('df -B1 /', (err, stdout) => err ? reject(err) : resolve(stdout))
    );
    const dfParts = dfOut.trim().split('\n')[1].trim().split(/\s+/);
    const disk = { total: +dfParts[1], used: +dfParts[2], free: +dfParts[3] };

    // Tailscale
    let tailscale = { ip: null, status: 'unknown' };
    try {
      const [tsIp, tsJson] = await Promise.all([
        new Promise(r => exec('tailscale ip -4', { timeout: 3000 }, (err, out) => r(err ? null : out.trim()))),
        new Promise(r => exec('tailscale status --json', { timeout: 3000 }, (err, out) => {
          if (err) return r(null);
          try { r(JSON.parse(out)); } catch { r(null); }
        })),
      ]);
      tailscale = {
        ip:     tsIp || null,
        status: tsJson?.BackendState === 'Running' ? 'online' : (tsIp ? 'online' : 'offline'),
      };
    } catch (_) {}

    // Netzwerk-Traffic aus /proc/net/dev
    let network = [];
    try {
      network = fs.readFileSync('/proc/net/dev', 'utf8').trim().split('\n').slice(2)
        .map(line => {
          const [iface, stats] = line.split(':');
          const vals = stats.trim().split(/\s+/).map(Number);
          return { iface: iface.trim(), rxBytes: vals[0], txBytes: vals[8] };
        })
        .filter(i => i.iface !== 'lo');
    } catch (_) {}

    // Top 5 Prozesse nach CPU
    let processes = [];
    try {
      const psOut = await new Promise(r =>
        exec('ps aux --sort=-%cpu --no-headers', { timeout: 5000 }, (err, out) => r(err ? '' : out))
      );
      processes = psOut.trim().split('\n').slice(0, 5)
        .map(line => {
          const p = line.trim().split(/\s+/);
          return { pid: p[1], cpu: parseFloat(p[2]) || 0, mem: parseFloat(p[3]) || 0, command: p.slice(10).join(' ').slice(0, 80) };
        })
        .filter(p => p.command);
    } catch (_) {}

    // Dashboard-Prozess
    let dashRunning = false;
    try {
      await new Promise((resolve, reject) =>
        exec('pgrep -f "node.*server\\.js"', { timeout: 3000 }, err => err ? reject() : resolve())
      );
      dashRunning = true;
    } catch (_) {}

    res.json({
      cpu:       { total: cpuList[0], cores: cpuList.slice(1) },
      ram:       { total: totalMem, used: totalMem - freeMem, free: freeMem },
      disk,
      uptime,
      loadAvg:   { m1: loadAvg[0], m5: loadAvg[1], m15: loadAvg[2] },
      tailscale,
      network,
      processes,
      dashboard: { running: dashRunning },
      ts:        Date.now(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ══════════════════════════════════════════════════════════════════════════════
//  NEUE APP HINZUFÜGEN
//  1. Ordner anlegen:  apps/meineApp/index.html  (+ weitere Dateien)
//  2. Statische Dateien einbinden (mit checkAuth):
//       app.use('/apps/meine-app', checkAuth, express.static(path.join(__dirname, 'apps/meineApp')));
//  3. API-Routen falls nötig:
//       app.post('/apps/meine-app/api/meinRoute', checkAuth, async (req, res) => { ... });
//  4. Karte im Dashboard ergänzen: public/index.html → apps-Array
// ══════════════════════════════════════════════════════════════════════════════


// ── Stremio ─────────────────────────────────────────────────────────────────
app.use('/apps/stremio', checkAuth, checkAppAccess('stremio'),
  express.static(path.join(__dirname, 'apps/stremio')));

app.get('/api/stremio/status', checkAuth, (req, res) => {
  exec("docker inspect --format '{{.State.Status}}' stremio-server", (err, stdout) => {
    const running = !err && stdout.trim() === 'running';
    res.json({ running });
  });
});

app.post('/api/stremio/restart', checkAuth, (req, res) => {
  exec('docker restart stremio-server', { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr || err.message });
    res.json({ ok: true });
  });
});

// ── Voice Assistant ──────────────────────────────────────────────────────────
app.use('/apps/voice-assistant', checkAuth, checkAppAccess('voice-assistant'),
  express.static(path.join(__dirname, 'apps/voiceAssistant')));

app.post('/apps/voice-assistant/api/chat', checkAuth, checkAppAccess('voice-assistant'), async (req, res) => {
  const { message, history, haUrl, haToken, apiKey, assistantName, userName } = req.body;

  if (!apiKey)  return res.status(400).json({ error: 'Kein Gemini API-Key angegeben.' });
  if (!message) return res.status(400).json({ error: 'Keine Nachricht.' });

  const genAI = new GoogleGenerativeAI(apiKey);

  const haTools = [{
    functionDeclarations: [
      {
        name: 'get_ha_states',
        description: 'Alle Home Assistant Entities und deren Zustände abrufen. Verwende dies um verfügbare Geräte zu ermitteln.',
        parameters: { type: 'object', properties: {} }
      },
      {
        name: 'call_ha_service',
        description: 'Home Assistant Service aufrufen um Geräte zu steuern (ein-/ausschalten, dimmen, Temperatur setzen, etc.)',
        parameters: {
          type: 'object',
          properties: {
            domain:          { type: 'string', description: 'Domain z.B. light, switch, climate, media_player, cover' },
            service:         { type: 'string', description: 'Service z.B. turn_on, turn_off, toggle, set_temperature' },
            entity_id:       { type: 'string', description: 'Entity ID z.B. light.wohnzimmer, switch.steckdose_tv' },
            additional_data: { type: 'object', description: 'Optionale Zusatzdaten z.B. {"brightness": 128, "temperature": 21}' }
          },
          required: ['domain', 'service', 'entity_id']
        }
      },
      {
        name: 'get_ha_history',
        description: 'Verlauf einer Home Assistant Entity für die letzten N Stunden abrufen',
        parameters: {
          type: 'object',
          properties: {
            entity_id: { type: 'string', description: 'Entity ID' },
            hours:     { type: 'number', description: 'Stunden zurück (Standard 24)' }
          },
          required: ['entity_id']
        }
      }
    ]
  }];

  const systemInstruction = `You are ${assistantName || 'JARVIS'}, a smart home assistant. Respond in English, concisely (1–3 sentences). Address the user as ${userName || 'sir'}.

You can control:
- Home Assistant (lights, switches, scenes, climate) via function calls
- Spotify on the Miniserver via action tags in your response

For Spotify commands append exactly one action tag at the end of your reply:
<action>{"type":"spotify","action":"play","query":"artist or song"}</action>
<action>{"type":"spotify","action":"pause"}</action>
<action>{"type":"spotify","action":"next"}</action>
<action>{"type":"spotify","action":"prev"}</action>
<action>{"type":"spotify","action":"volume","value":80}</action>
<action>{"type":"spotify","action":"volume_delta","value":20}</action>
<action>{"type":"spotify","action":"transfer","device":"Miniserver"}</action>

Spotify rules:
- "Play [artist/song]" → play with query
- "Louder" → volume_delta value:20, "Quieter/lower" → volume_delta value:-20
- "Next/previous track" → next / prev
- "Pause" / "Stop" → pause
- "Play on Miniserver" → transfer device:"Miniserver" then play without query
The action tag is executed by the system — never read it aloud.`;

  const model = genAI.getGenerativeModel({
    model: 'gemini-3.5-flash',
    systemInstruction,
    tools: (haUrl && haToken) ? haTools : undefined
  });

  let chatHistory = (history || []).slice(-10).map(h => ({
    role: h.role === 'assistant' ? 'model' : h.role,
    parts: [{ text: h.content }]
  }));
  while (chatHistory.length && chatHistory[0].role !== 'user') chatHistory.shift();

  const chat = model.startChat({ history: chatHistory });

  async function callHA(method, urlPath, body) {
    if (!haUrl || !haToken) throw new Error('Home Assistant nicht konfiguriert');
    const url  = haUrl.replace(/\/$/, '') + urlPath;
    const opts = { method, headers: { Authorization: 'Bearer ' + haToken, 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error('HA ' + r.status);
    return r.json();
  }

  async function sendMsg(msg, attempt = 1) {
    try {
      return await chat.sendMessage(msg);
    } catch (err) {
      if ((err.status === 429 || String(err.message).includes('429')) && attempt < 3) {
        await new Promise(r => setTimeout(r, 2000));
        return sendMsg(msg, attempt + 1);
      }
      throw err;
    }
  }

  try {
    let result = await sendMsg(message);

    let guard = 0;
    while (result.response.functionCalls()?.length && guard++ < 5) {
      const parts = [];
      for (const call of result.response.functionCalls()) {
        let response;
        try {
          if (call.name === 'get_ha_states') {
            const states = await callHA('GET', '/api/states');
            response = {
              states: states.slice(0, 150).map(s => ({
                entity_id: s.entity_id,
                state:     s.state,
                name:      s.attributes?.friendly_name
              }))
            };
          } else if (call.name === 'call_ha_service') {
            const { domain, service, entity_id, additional_data } = call.args;
            await callHA('POST', `/api/services/${domain}/${service}`, { entity_id, ...(additional_data || {}) });
            response = { success: true };
          } else if (call.name === 'get_ha_history') {
            const { entity_id, hours = 24 } = call.args;
            const start = new Date(Date.now() - hours * 3_600_000).toISOString();
            const data  = await callHA('GET', `/api/history/period/${start}?filter_entity_id=${entity_id}`);
            response    = { history: (data[0] || []).slice(-30) };
          } else {
            response = { error: 'Unbekannte Funktion' };
          }
        } catch (err) {
          response = { error: err.message };
        }
        parts.push({ functionResponse: { name: call.name, response } });
      }
      result = await sendMsg(parts);
    }

    res.json({ reply: result.response.text() });
  } catch (err) {
    console.error('[voice-assistant]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Smarthome Zentrale ───────────────────────────────────────────────────────
app.use('/apps/smarthome-zentrale', checkAuth, checkAppAccess('smarthome-zentrale'),
  express.static(path.join(__dirname, 'apps/smarthomeZentrale')));

app.get('/apps/smarthome-zentrale/api/ha-states', checkAuth, checkAppAccess('smarthome-zentrale'), async (req, res) => {
  const { haUrl, haToken } = req.query;
  if (!haUrl || !haToken) return res.status(400).json({ error: 'haUrl und haToken erforderlich' });
  try {
    const r = await fetch(haUrl.replace(/\/$/, '') + '/api/states', {
      headers: { Authorization: 'Bearer ' + haToken }
    });
    if (!r.ok) throw new Error('HA ' + r.status);
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/apps/smarthome-zentrale/api/ha-service', checkAuth, checkAppAccess('smarthome-zentrale'), async (req, res) => {
  const { haUrl, haToken, domain, service, data } = req.body;
  if (!haUrl || !haToken || !domain || !service) return res.status(400).json({ error: 'Fehlende Parameter' });
  try {
    const r = await fetch(`${haUrl.replace(/\/$/, '')}/api/services/${domain}/${service}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + haToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {})
    });
    if (!r.ok) throw new Error('HA ' + r.status);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Spotify Control (unified — used by voice assistant) ──────────────────────
app.post('/apps/smarthome-zentrale/api/spotify/control', checkAuth, checkAppAccess('smarthome-zentrale'), async (req, res) => {
  const { action, query, value, device, delta } = req.body;
  const uid = req.session.userId;
  try {
    switch (action) {
      case 'play': {
        if (query) {
          const sr  = await spotifyFetch(uid, `/search?q=${encodeURIComponent(query)}&type=artist,track&limit=5`);
          const sd  = await sr.json();
          const artist = sd.artists?.items?.[0];
          const track  = sd.tracks?.items?.[0];
          // Prefer artist context (plays discography) over single track
          const body = artist
            ? { context_uri: artist.uri }
            : track ? { uris: [track.uri] } : null;
          if (!body) return res.status(404).json({ error: 'Nichts gefunden für: ' + query });
          await spotifyFetch(uid, '/me/player/play', { method: 'PUT', body: JSON.stringify(body) });
          res.json({ ok: true, played: artist?.name || track?.name });
        } else {
          await spotifyFetch(uid, '/me/player/play', { method: 'PUT' });
          res.json({ ok: true });
        }
        break;
      }
      case 'pause':
        await spotifyFetch(uid, '/me/player/pause', { method: 'PUT' });
        res.json({ ok: true });
        break;
      case 'next':
        await spotifyFetch(uid, '/me/player/next', { method: 'POST' });
        res.json({ ok: true });
        break;
      case 'prev':
        await spotifyFetch(uid, '/me/player/previous', { method: 'POST' });
        res.json({ ok: true });
        break;
      case 'volume': {
        const vol = Math.max(0, Math.min(100, parseInt(value) || 50));
        await spotifyFetch(uid, `/me/player/volume?volume_percent=${vol}`, { method: 'PUT' });
        res.json({ ok: true, volume: vol });
        break;
      }
      case 'volume_delta': {
        const step = parseInt(value ?? delta) || 0;
        const pr   = await spotifyFetch(uid, '/me/player');
        const cur  = pr.status === 204 ? null : await pr.json();
        const now  = cur?.device?.volume_percent ?? 50;
        const nv   = Math.max(0, Math.min(100, now + step));
        await spotifyFetch(uid, `/me/player/volume?volume_percent=${nv}`, { method: 'PUT' });
        res.json({ ok: true, volume: nv });
        break;
      }
      case 'transfer': {
        const dr   = await spotifyFetch(uid, '/me/player/devices');
        const dd   = await dr.json();
        const key  = (device || '').toLowerCase();
        const dev  = (dd.devices || []).find(d => d.name.toLowerCase().includes(key));
        if (!dev) return res.status(404).json({ error: 'Gerät nicht gefunden: ' + device, devices: (dd.devices||[]).map(d=>d.name) });
        await spotifyFetch(uid, '/me/player', { method: 'PUT', body: JSON.stringify({ device_ids: [dev.id], play: true }) });
        res.json({ ok: true, device: dev.name });
        break;
      }
      default:
        res.status(400).json({ error: 'Unbekannte Aktion: ' + action });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Spotify Routes (Smarthome Zentrale) ─────────────────────────────────────
const SP_BASE = '/apps/smarthome-zentrale/api/spotify';
const spAuth  = [checkAuth, checkAppAccess('smarthome-zentrale')];

// Credentials: GET returns clientId + hasSecret + redirectUri + connected status
app.get(SP_BASE + '/credentials', ...spAuth, async (req, res) => {
  try {
    const tokens = await getSpotifyTokens(req.session.userId);
    const redirectUri = `${req.protocol}://${req.get('host')}/apps/smarthome-zentrale/api/spotify/callback`;
    res.json({
      clientId:    tokens?.clientId     || '',
      hasSecret:   !!(tokens?.clientSecret),
      redirectUri,
      connected:   !!(tokens?.accessToken && tokens?.refreshToken),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Credentials: POST saves clientId + optional clientSecret
app.post(SP_BASE + '/credentials', ...spAuth, async (req, res) => {
  const { clientId, clientSecret } = req.body;
  if (!clientId) return res.status(400).json({ error: 'Client ID erforderlich' });
  try {
    const update = { clientId };
    if (clientSecret) update.clientSecret = clientSecret;
    await saveSpotifyTokens(req.session.userId, update);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// OAuth login — redirect to Spotify
app.get(SP_BASE + '/login', ...spAuth, async (req, res) => {
  try {
    const tokens = await getSpotifyTokens(req.session.userId);
    if (!tokens?.clientId) return res.status(400).send('Spotify Client ID nicht konfiguriert');
    const redirectUri = `${req.protocol}://${req.get('host')}/apps/smarthome-zentrale/api/spotify/callback`;
    const params = new URLSearchParams({
      client_id: tokens.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SPOTIFY_SCOPES,
      state: req.session.id,
    });
    res.redirect('https://accounts.spotify.com/authorize?' + params.toString());
  } catch (err) { res.status(500).send(err.message); }
});

// OAuth callback — exchange code for tokens
app.get(SP_BASE + '/callback', checkAuth, async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/apps/smarthome-zentrale?spotify_error=' + encodeURIComponent(error));
  if (!code) return res.status(400).send('Kein Code erhalten');
  try {
    const tokens = await getSpotifyTokens(req.session.userId);
    if (!tokens?.clientId || !tokens?.clientSecret)
      return res.status(400).send('Spotify-Credentials nicht konfiguriert');
    const redirectUri = `${req.protocol}://${req.get('host')}/apps/smarthome-zentrale/api/spotify/callback`;
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${tokens.clientId}:${tokens.clientSecret}`).toString('base64'),
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    });
    if (!r.ok) {
      const txt = await r.text();
      return res.redirect('/apps/smarthome-zentrale?spotify_error=' + encodeURIComponent(txt.slice(0, 200)));
    }
    const data = await r.json();
    await saveSpotifyTokens(req.session.userId, {
      accessToken:  data.access_token,
      refreshToken: data.refresh_token,
      expiresAt:    Date.now() + data.expires_in * 1000,
    });
    res.redirect('/apps/smarthome-zentrale?spotify_connected=1');
  } catch (err) {
    res.redirect('/apps/smarthome-zentrale?spotify_error=' + encodeURIComponent(err.message));
  }
});

// Connection status
app.get(SP_BASE + '/status', ...spAuth, async (req, res) => {
  try {
    const tokens = await getSpotifyTokens(req.session.userId);
    res.json({ connected: !!(tokens?.accessToken && tokens?.refreshToken) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Disconnect (clear tokens, keep credentials)
app.delete(SP_BASE + '/disconnect', ...spAuth, async (req, res) => {
  try {
    await spDbRun(
      `UPDATE spotify_tokens SET access_token='', refresh_token='', expires_at=0 WHERE user_id=?`,
      [req.session.userId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Current player state
app.get(SP_BASE + '/player', ...spAuth, async (req, res) => {
  try {
    const r = await spotifyFetch(req.session.userId, '/me/player');
    if (r.status === 204) return res.json(null);
    if (!r.ok) return res.status(r.status).json({ error: 'Spotify ' + r.status });
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Playback controls
app.post(SP_BASE + '/player/play', ...spAuth, async (req, res) => {
  try {
    const body = req.body.context_uri ? JSON.stringify({ context_uri: req.body.context_uri })
      : req.body.uri ? JSON.stringify({ uris: [req.body.uri] }) : undefined;
    const r = await spotifyFetch(req.session.userId, '/me/player/play', { method: 'PUT', body });
    res.json({ ok: r.ok || r.status === 204 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post(SP_BASE + '/player/pause', ...spAuth, async (req, res) => {
  try {
    await spotifyFetch(req.session.userId, '/me/player/pause', { method: 'PUT' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post(SP_BASE + '/player/next', ...spAuth, async (req, res) => {
  try {
    await spotifyFetch(req.session.userId, '/me/player/next', { method: 'POST' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post(SP_BASE + '/player/prev', ...spAuth, async (req, res) => {
  try {
    await spotifyFetch(req.session.userId, '/me/player/previous', { method: 'POST' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post(SP_BASE + '/player/seek', ...spAuth, async (req, res) => {
  try {
    const pos = parseInt(req.body.position_ms) || 0;
    await spotifyFetch(req.session.userId, `/me/player/seek?position_ms=${pos}`, { method: 'PUT' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post(SP_BASE + '/player/volume', ...spAuth, async (req, res) => {
  try {
    const vol = Math.max(0, Math.min(100, parseInt(req.body.volume_percent) || 0));
    await spotifyFetch(req.session.userId, `/me/player/volume?volume_percent=${vol}`, { method: 'PUT' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Devices
app.get(SP_BASE + '/devices', ...spAuth, async (req, res) => {
  try {
    const r = await spotifyFetch(req.session.userId, '/me/player/devices');
    if (!r.ok) return res.status(r.status).json({ error: 'Spotify ' + r.status });
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post(SP_BASE + '/player/transfer', ...spAuth, async (req, res) => {
  try {
    const { device_id } = req.body;
    await spotifyFetch(req.session.userId, '/me/player', {
      method: 'PUT',
      body: JSON.stringify({ device_ids: [device_id], play: true }),
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Playlists
app.get(SP_BASE + '/playlists', ...spAuth, async (req, res) => {
  try {
    const r = await spotifyFetch(req.session.userId, '/me/playlists?limit=50');
    if (!r.ok) return res.status(r.status).json({ error: 'Spotify ' + r.status });
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Spotifyd control
app.get('/apps/smarthome-zentrale/api/spotifyd/status', ...spAuth, (req, res) => {
  exec('systemctl --user is-active spotifyd', (err, stdout) => {
    const status = stdout.trim();
    res.json({ active: status === 'active', status });
  });
});
app.post('/apps/smarthome-zentrale/api/spotifyd/restart', ...spAuth, (req, res) => {
  exec('systemctl --user restart spotifyd', err => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});
app.post('/apps/smarthome-zentrale/api/spotifyd/config', ...spAuth, (req, res) => {
  const { username, password, deviceName } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username und Passwort erforderlich' });
  const name = (deviceName || 'Miniserver').replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 40) || 'Miniserver';
  const conf = `[global]\nusername = "${username}"\npassword = "${password}"\nbackend = pulseaudio\ndevice_name = "${name}"\nbitrate = 320\nno_audio_cache = false\nvolume_normalisation = true\nnormalisation_pregain = -10\n`;
  fs.writeFile(SPOTIFYD_CONF, conf, err => {
    if (err) return res.status(500).json({ error: err.message });
    exec('systemctl --user restart spotifyd', () => res.json({ ok: true }));
  });
});

// ── Audio Output Switcher ────────────────────────────────────────────────────
const AUDIO_BASE = '/apps/smarthome-zentrale/api/audio';

function execP(cmd, opts = {}) {
  return new Promise((res, rej) =>
    exec(cmd, { timeout: 12000, ...opts }, (err, stdout, stderr) =>
      err ? rej(Object.assign(err, { stdout, stderr })) : res(stdout)));
}

function getAudioSettings(userId) {
  return spDbGet('SELECT * FROM audio_settings WHERE user_id = ?', [userId])
    .then(r => r || { user_id: userId, bt_mac:'', bt_name:'Bluetooth', cable_name:'Kabel', bt_sink:'', cable_sink:'', current_out:'cable' });
}

async function detectSinks(btMac) {
  let btSink = '', cableSink = '';
  try {
    const out = await execP('pactl list sinks short');
    for (const line of out.trim().split('\n')) {
      const parts = line.split('\t');
      const name  = (parts[1] || '').trim();
      if (!btSink    && name.toLowerCase().includes('bluez')) btSink    = name;
      if (!cableSink && !name.toLowerCase().includes('bluez') && name.startsWith('alsa')) cableSink = name;
    }
  } catch {}
  // Derive BT sink from MAC if pactl found nothing
  if (!btSink && btMac) {
    const macU = btMac.replace(/:/g, '_');
    btSink = `bluez_output.${macU}.1`;
  }
  return { btSink, cableSink };
}

// GET settings
app.get(AUDIO_BASE + '/settings', ...spAuth, async (req, res) => {
  try { res.json(await getAudioSettings(req.session.userId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// POST save settings
app.post(AUDIO_BASE + '/settings', ...spAuth, async (req, res) => {
  const { bt_mac, bt_name, cable_name, bt_sink, cable_sink } = req.body;
  try {
    await spDbRun(
      `INSERT INTO audio_settings (user_id, bt_mac, bt_name, cable_name, bt_sink, cable_sink)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET
         bt_mac=excluded.bt_mac, bt_name=excluded.bt_name,
         cable_name=excluded.cable_name, bt_sink=excluded.bt_sink,
         cable_sink=excluded.cable_sink`,
      [req.session.userId,
       (bt_mac || '').trim().toUpperCase(),
       (bt_name || 'Bluetooth').trim(),
       (cable_name || 'Kabel').trim(),
       (bt_sink || '').trim(),
       (cable_sink || '').trim()]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET current status
app.get(AUDIO_BASE + '/status', ...spAuth, async (req, res) => {
  try {
    const s = await getAudioSettings(req.session.userId);
    let btConnected = false;
    let currentOut  = s.current_out;

    if (s.bt_mac) {
      try {
        const info = await execP(`bluetoothctl info ${s.bt_mac}`);
        btConnected = info.includes('Connected: yes');
      } catch {}
    }

    try {
      const info = await execP('pactl info');
      const m = info.match(/Default Sink:\s*(.+)/);
      if (m) currentOut = m[1].trim().toLowerCase().includes('bluez') ? 'bluetooth' : 'cable';
    } catch {}

    res.json({ currentOut, btConnected, btName: s.bt_name, cableName: s.cable_name, btMac: s.bt_mac });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST switch output
app.post(AUDIO_BASE + '/switch', ...spAuth, async (req, res) => {
  const { output } = req.body;
  if (output !== 'cable' && output !== 'bluetooth')
    return res.status(400).json({ error: 'output muss "cable" oder "bluetooth" sein' });

  try {
    const s = await getAudioSettings(req.session.userId);
    const { btSink, cableSink } = await detectSinks(s.bt_mac);
    const effectiveBtSink    = s.bt_sink    || btSink;
    const effectiveCableSink = s.cable_sink || cableSink;

    if (output === 'bluetooth') {
      if (!s.bt_mac) return res.status(400).json({ error: 'Keine Bluetooth MAC-Adresse konfiguriert' });

      // Connect BT (10 s Timeout)
      await new Promise((resolve, reject) => {
        const proc  = exec(`bluetoothctl connect ${s.bt_mac}`, { timeout: 12000 });
        const timer = setTimeout(() => { proc.kill(); reject(new Error('Bluetooth Verbindung Timeout (10 s)')); }, 10000);
        let out = '';
        proc.stdout?.on('data', d => {
          out += d;
          if (out.includes('Connection successful') || out.includes('already connected')) {
            clearTimeout(timer); resolve();
          }
        });
        proc.on('close', () => { clearTimeout(timer); resolve(); });
        proc.on('error', err => { clearTimeout(timer); reject(err); });
      });

      // Wait briefly for sink to appear, then set default
      await new Promise(r => setTimeout(r, 1500));
      if (effectiveBtSink) await execP(`pactl set-default-sink "${effectiveBtSink}"`).catch(() => {});

    } else {
      // Disconnect BT and switch to cable
      if (s.bt_mac) await execP(`bluetoothctl disconnect ${s.bt_mac}`).catch(() => {});
      if (effectiveCableSink) await execP(`pactl set-default-sink "${effectiveCableSink}"`).catch(() => {});
    }

    // Restart spotifyd so it picks up the new sink
    await execP('systemctl --user restart spotifyd').catch(() => {});

    // Persist chosen output
    await spDbRun('UPDATE audio_settings SET current_out=? WHERE user_id=?', [output, req.session.userId])
      .catch(() => spDbRun('INSERT INTO audio_settings (user_id, current_out) VALUES(?,?)', [req.session.userId, output]));

    res.json({ ok: true, currentOut: output });
  } catch (err) {
    // On BT failure, fall back to cable automatically
    if (output === 'bluetooth') {
      exec('bluetoothctl disconnect', () => {});
      exec('systemctl --user restart spotifyd', () => {});
    }
    res.status(500).json({ error: err.message });
  }
});

// GET paired BT devices
app.get(AUDIO_BASE + '/bluetooth-devices', ...spAuth, async (req, res) => {
  try {
    const out = await execP('bluetoothctl devices');
    const devices = out.trim().split('\n')
      .map(l => { const m = l.match(/Device\s+([0-9A-F:]{17})\s+(.+)/i); return m ? { mac: m[1].toUpperCase(), name: m[2].trim() } : null; })
      .filter(Boolean);
    res.json({ devices });
  } catch (err) { res.json({ devices: [] }); }
});

// GET available PulseAudio sinks
app.get(AUDIO_BASE + '/sinks', ...spAuth, async (req, res) => {
  try {
    const out = await execP('pactl list sinks short');
    const sinks = out.trim().split('\n')
      .map(l => { const p = l.split('\t'); return p[1] ? { name: p[1].trim(), state: (p[4]||'').trim() } : null; })
      .filter(Boolean);
    res.json({ sinks });
  } catch (err) { res.status(500).json({ error: 'pactl nicht verfügbar: ' + err.message, sinks: [] }); }
});

// ── Edge TTS ───────────────────────────────────────────────────────────────
app.post('/apps/voice-assistant/api/tts', checkAuth, (req, res) => {
  const { text, voice = 'en-GB-RyanNeural' } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
  const tmpFile = path.join(os.tmpdir(), `tts_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);
  execFile('/home/miniserver/.local/bin/edge-tts',
    ['--voice', voice, '--text', text, '--write-media', tmpFile],
    { timeout: 30000 },
    (err) => {
      if (err) {
        try { fs.unlinkSync(tmpFile); } catch {}
        console.error('[edge-tts]', err.message);
        return res.status(500).json({ error: err.message });
      }
      res.setHeader('Content-Type', 'audio/mpeg');
      const stream = fs.createReadStream(tmpFile);
      stream.pipe(res);
      stream.on('end',   () => { try { fs.unlinkSync(tmpFile); } catch {} });
      stream.on('error', () => { try { fs.unlinkSync(tmpFile); } catch {} });
    });
});

// ══════════════════════════════════════════════════════════════════════════════
//  APP: EXAM TRAINER  →  /apps/exam-trainer
//  Claude-powered exam from uploaded PDFs/images — API calls from browser
// ══════════════════════════════════════════════════════════════════════════════
app.use('/apps/exam-trainer', checkAuth, checkAppAccess('exam-trainer'),
  express.static(path.join(__dirname, 'apps/examTrainer')));

app.post('/apps/exam-trainer/api/save-session', checkAuth, checkAppAccess('exam-trainer'), async (req, res) => {
  const { subject, score, total, duration_seconds, files_used, questions = [], answers = [] } = req.body;
  const userId = req.session.userId;
  try {
    const sessionId = await new Promise((resolve, reject) =>
      db.run(
        `INSERT INTO exam_sessions (user_id, subject, score, total, timestamp, duration_seconds, files_used)
         VALUES (?, ?, ?, ?, datetime('now'), ?, ?)`,
        [userId, subject, score, total, duration_seconds, files_used],
        function(err) { err ? reject(err) : resolve(this.lastID); }
      )
    );

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const questionId = await new Promise((resolve, reject) =>
        db.run(
          `INSERT INTO exam_questions (session_id, subject, question, type, options_json, correct_answer, explanation, source_hint)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [sessionId, subject, q.question, q.type, JSON.stringify(q.options || []), q.correct_answer, q.explanation, q.source_hint],
          function(err) { err ? reject(err) : resolve(this.lastID); }
        )
      );
      const a = answers[i];
      if (a) {
        await new Promise((resolve, reject) =>
          db.run(
            `INSERT INTO user_answers (session_id, question_id, user_answer, is_correct, timestamp)
             VALUES (?, ?, ?, ?, datetime('now'))`,
            [sessionId, questionId, a.user_answer, a.is_correct ? 1 : 0],
            err => err ? reject(err) : resolve()
          )
        );
      }
    }
    res.json({ ok: true, sessionId });
  } catch (err) {
    console.error('[exam-trainer]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/apps/exam-trainer/api/history', checkAuth, checkAppAccess('exam-trainer'), (req, res) => {
  db.all(
    `SELECT * FROM exam_sessions WHERE user_id = ? ORDER BY timestamp DESC LIMIT 20`,
    [req.session.userId],
    (err, rows) => err ? res.status(500).json({ error: err.message }) : res.json(rows)
  );
});

app.get('/apps/exam-trainer/api/session/:id', checkAuth, checkAppAccess('exam-trainer'), (req, res) => {
  const sessionId = parseInt(req.params.id);
  const userId = req.session.userId;
  db.get('SELECT * FROM exam_sessions WHERE id = ? AND user_id = ?', [sessionId, userId], (err, session) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!session) return res.status(404).json({ error: 'Nicht gefunden' });
    db.all(
      `SELECT q.*, a.user_answer, a.is_correct
       FROM exam_questions q
       LEFT JOIN user_answers a ON a.question_id = q.id AND a.session_id = ?
       WHERE q.session_id = ?
       ORDER BY q.id`,
      [sessionId, sessionId],
      (err2, rows) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({ session, questions: rows });
      }
    );
  });
});

app.get('/apps/exam-trainer/api/weak-topics', checkAuth, checkAppAccess('exam-trainer'), (req, res) => {
  db.all(
    `SELECT q.question, q.type, q.correct_answer, q.explanation, q.source_hint,
            COUNT(a.id)                                                          AS attempts,
            SUM(CASE WHEN a.is_correct = 0 THEN 1 ELSE 0 END)                   AS wrong_count,
            ROUND(100.0 * SUM(CASE WHEN a.is_correct = 0 THEN 1 ELSE 0 END) / COUNT(a.id)) AS error_rate
     FROM exam_questions q
     JOIN user_answers   a ON a.question_id = q.id
     JOIN exam_sessions  s ON s.id = q.session_id
     WHERE s.user_id = ?
     GROUP BY q.question
     HAVING error_rate > 50
     ORDER BY error_rate DESC
     LIMIT 20`,
    [req.session.userId],
    (err, rows) => err ? res.status(500).json({ error: err.message }) : res.json(rows)
  );
});

app.get('/apps/exam-trainer/api/past-questions', checkAuth, checkAppAccess('exam-trainer'), (req, res) => {
  const { subject } = req.query;
  if (!subject) return res.status(400).json({ error: 'subject erforderlich' });
  db.all(
    `SELECT DISTINCT q.question
     FROM exam_questions q
     JOIN exam_sessions s ON s.id = q.session_id
     WHERE s.user_id = ? AND LOWER(s.subject) = LOWER(?)
     ORDER BY q.id DESC
     LIMIT 150`,
    [req.session.userId, subject],
    (err, rows) => err ? res.status(500).json({ error: err.message }) : res.json(rows.map(r => r.question))
  );
});

// Gemini Files API proxy — avoids CORS when uploading from the browser
app.post('/apps/exam-trainer/api/gemini-upload', checkAuth, checkAppAccess('exam-trainer'), async (req, res) => {
  const { base64, mimeType, displayName, apiKey } = req.body;
  if (!base64 || !mimeType || !apiKey) return res.status(400).json({ error: 'base64, mimeType und apiKey erforderlich' });
  try {
    const fileBuffer = Buffer.from(base64, 'base64');
    console.log(`[exam-trainer] Gemini Upload: "${displayName}" ${(fileBuffer.length / 1024).toFixed(0)} KB`);

    const startResp = await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': fileBuffer.length,
          'X-Goog-Upload-Header-Content-Type': mimeType,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file: { display_name: displayName || 'upload' } }),
      }
    );
    if (!startResp.ok) {
      const txt = await startResp.text().catch(() => '');
      console.error('[exam-trainer] Files API init error:', startResp.status, txt.slice(0, 300));
      return res.status(502).json({ error: `Files API Init fehlgeschlagen: HTTP ${startResp.status}`, detail: txt.slice(0, 300) });
    }
    const uploadUrl = startResp.headers.get('x-goog-upload-url');
    if (!uploadUrl) return res.status(502).json({ error: 'Kein Upload-URL von Gemini erhalten' });

    const uploadResp = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Command': 'upload, finalize',
        'X-Goog-Upload-Offset': '0',
        'Content-Type': mimeType,
      },
      body: fileBuffer,
    });
    if (!uploadResp.ok) {
      const txt = await uploadResp.text().catch(() => '');
      console.error('[exam-trainer] Files API upload error:', uploadResp.status, txt.slice(0, 300));
      return res.status(502).json({ error: `File Upload fehlgeschlagen: HTTP ${uploadResp.status}`, detail: txt.slice(0, 300) });
    }
    const fileData = await uploadResp.json();
    const fileUri  = fileData.file?.uri;
    if (!fileUri) return res.status(502).json({ error: 'Keine file URI in Gemini-Antwort', detail: JSON.stringify(fileData).slice(0, 200) });
    console.log(`[exam-trainer] Gemini Upload OK → ${fileUri}`);
    res.json({ fileUri });
  } catch (err) {
    console.error('[exam-trainer] gemini-upload Fehler:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Gemini generateContent proxy — avoids CORS for the generation call
app.post('/apps/exam-trainer/api/gemini-generate', checkAuth, checkAppAccess('exam-trainer'), async (req, res) => {
  const { parts, apiKey } = req.body;
  if (!parts || !apiKey) return res.status(400).json({ error: 'parts und apiKey erforderlich' });
  try {
    console.log(`[exam-trainer] Gemini Generate: ${parts.length} parts`);
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(300_000),
      }
    );
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.error('[exam-trainer] Gemini Generate error:', resp.status, txt.slice(0, 300));
      return res.status(502).json({ error: `Gemini HTTP ${resp.status}`, detail: txt.slice(0, 300) });
    }
    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    console.log(`[exam-trainer] Gemini Generate OK, ${text.length} Zeichen`);
    res.json({ text });
  } catch (err) {
    console.error('[exam-trainer] gemini-generate Fehler:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  const compiler = await findLatexCompiler();
  const compilerLabel = compiler
    ? `✓ ${path.basename(compiler)}`
    : '✗ kein Compiler gefunden';
  console.log(`
╔═══════════════════════════════════════════════╗
║   Dashboard                                   ║
║   http://localhost:${PORT}                       ║
║                                               ║
║   LaTeX:  ${compilerLabel.padEnd(35)}║
╚═══════════════════════════════════════════════╝
  `);
});
