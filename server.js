const express    = require('express');
const { execFile, exec } = require('child_process');
const fs         = require('fs');
const os         = require('os');
const path       = require('path');
const multer     = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const tmp        = require('tmp');
const session    = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const sqlite3    = require('sqlite3').verbose();
const bcrypt     = require('bcrypt');

const app      = express();
const PORT     = process.env.PORT || 3000;
const TECTONIC = path.join(os.homedir(), '.local', 'bin', 'tectonic');

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
    user_id     INTEGER NOT NULL,
    pet_name    TEXT    NOT NULL,
    med_name    TEXT    NOT NULL,
    dose        TEXT    NOT NULL,
    time_of_day TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (date('now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS medication_daily_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER NOT NULL,
    log_date    TEXT    NOT NULL,
    status      TEXT    NOT NULL CHECK(status IN ('done','skipped')),
    UNIQUE(schedule_id, log_date),
    FOREIGN KEY(schedule_id) REFERENCES medication_schedules(id) ON DELETE CASCADE
  )`);
});

// ══════════════════════════════════════════════════════════════════════════════
//  MIDDLEWARE
// ══════════════════════════════════════════════════════════════════════════════
app.use(express.json({ limit: '10mb' }));
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

// ── Auth-Middleware ────────────────────────────────────────────────────────
function checkAuth(req, res, next) {
  if (req.session.userId) return next();
  const isApi = req.originalUrl.includes('/api/') || req.originalUrl.includes('/compile');
  if (isApi) return res.status(401).json({ error: 'Nicht angemeldet.' });
  res.redirect('/login.html');
}

// ══════════════════════════════════════════════════════════════════════════════
//  AUTH-ROUTEN  (vor checkAuth — kein Schutz nötig)
// ══════════════════════════════════════════════════════════════════════════════

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

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
    res.redirect('/');
  });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login.html'));
});

// Gibt den eingeloggten Usernamen zurück (für das Dashboard-Frontend)
app.get('/api/me', checkAuth, (req, res) => {
  res.json({ username: req.session.username });
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
//  APP: PODCAST COMPRESSOR  →  /apps/podcast-compressor
//  (COOP/COEP headers sind für SharedArrayBuffer / FFmpeg WASM nötig)
// ══════════════════════════════════════════════════════════════════════════════
app.use('/apps/podcast-compressor', checkAuth, (req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  next();
}, express.static(path.join(__dirname, 'apps/podcastCompressor')));


// ══════════════════════════════════════════════════════════════════════════════
//  APP: LATEX KONVERTER  →  /apps/latex-converter
//  Bild hochladen → Gemini Vision → LaTeX → PDF (pdflatex)
// ══════════════════════════════════════════════════════════════════════════════
app.use('/apps/latex-converter', checkAuth, express.static(path.join(__dirname, 'apps/latexConverter')));

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

app.post('/apps/latex-converter/compile', checkAuth, async (req, res) => {
  const { latex } = req.body;
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
    res.setHeader('Content-Disposition', 'attachment; filename="vorlesungsnotizen.pdf"');
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
app.use('/apps/latex-study', checkAuth, express.static(path.join(__dirname, 'apps/latexStudy')));

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Nur PDF-Dateien erlaubt'), false);
  },
  limits: { fileSize: 50 * 1024 * 1024 }
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
  const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

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

app.post('/apps/latex-study/api/summarize', checkAuth, upload.single('pdf'), async (req, res) => {
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

app.post('/apps/latex-study/api/latex-only', checkAuth, upload.single('pdf'), async (req, res) => {
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

app.post('/apps/latex-study/api/compile-pdf', checkAuth, async (req, res) => {
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
//  APP: HAUSTIER-MEDIKAMENTEN-TRACKER  →  /apps/pet-meds
// ══════════════════════════════════════════════════════════════════════════════
app.use('/apps/pet-meds', checkAuth, express.static(path.join(__dirname, 'apps/petMeds')));

function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Alle Medikamente des Tages (inkl. heutigem Log-Status)
app.get('/apps/pet-meds/api/today', checkAuth, (req, res) => {
  const today = localDate();
  db.all(
    `SELECT s.id, s.pet_name, s.med_name, s.dose, s.time_of_day,
            l.status
     FROM medication_schedules s
     LEFT JOIN medication_daily_logs l ON l.schedule_id = s.id AND l.log_date = ?
     WHERE s.user_id = ?
     ORDER BY s.time_of_day, s.pet_name`,
    [today, req.session.userId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// Alle Basis-Pläne (für die Verwaltungsansicht)
app.get('/apps/pet-meds/api/schedules', checkAuth, (req, res) => {
  db.all(
    'SELECT id, pet_name, med_name, dose, time_of_day, created_at FROM medication_schedules WHERE user_id = ? ORDER BY time_of_day, pet_name',
    [req.session.userId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// Neuen Medikamentenplan anlegen
app.post('/apps/pet-meds/api/schedules', checkAuth, (req, res) => {
  const { pet_name, med_name, dose, time_of_day } = req.body;
  if (!pet_name || !med_name || !dose || !time_of_day)
    return res.status(400).json({ error: 'Alle Felder sind erforderlich.' });
  db.run(
    'INSERT INTO medication_schedules (user_id, pet_name, med_name, dose, time_of_day) VALUES (?, ?, ?, ?, ?)',
    [req.session.userId, pet_name.trim(), med_name.trim(), dose.trim(), time_of_day],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, pet_name: pet_name.trim(), med_name: med_name.trim(), dose: dose.trim(), time_of_day });
    }
  );
});

// Medikamentenplan dauerhaft löschen
app.delete('/apps/pet-meds/api/schedules/:id', checkAuth, (req, res) => {
  db.run(
    'DELETE FROM medication_schedules WHERE id = ? AND user_id = ?',
    [req.params.id, req.session.userId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: 'Nicht gefunden.' });
      res.json({ ok: true });
    }
  );
});

// Tages-Log setzen (done / skipped) oder entfernen (status: null)
app.patch('/apps/pet-meds/api/today/:id', checkAuth, (req, res) => {
  const { status } = req.body;
  const today = localDate();
  db.get(
    'SELECT id FROM medication_schedules WHERE id = ? AND user_id = ?',
    [req.params.id, req.session.userId],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'Nicht gefunden.' });
      if (!status) {
        db.run(
          'DELETE FROM medication_daily_logs WHERE schedule_id = ? AND log_date = ?',
          [req.params.id, today],
          (e) => { if (e) return res.status(500).json({ error: e.message }); res.json({ ok: true }); }
        );
      } else {
        db.run(
          'INSERT OR REPLACE INTO medication_daily_logs (schedule_id, log_date, status) VALUES (?, ?, ?)',
          [req.params.id, today, status],
          (e) => { if (e) return res.status(500).json({ error: e.message }); res.json({ ok: true }); }
        );
      }
    }
  );
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
