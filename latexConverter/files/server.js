/**
 * server.js — Notizen → LaTeX → PDF
 *
 * Startet einen lokalen Express-Server der:
 *  1. index.html ausliefert
 *  2. POST /compile  →  LaTeX per pdflatex zu PDF kompiliert
 *
 * Voraussetzungen:
 *   node >= 16
 *   npm install express
 *   pdflatex installiert (TeX Live / MiKTeX)
 *
 * Starten:
 *   node server.js
 *   → http://localhost:3000
 */

const express  = require('express');
const { execFile } = require('child_process');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

/* ─── Middleware ─── */
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));   // index.html aus demselben Ordner

/* ─── Hilfsfunktion: pdflatex verfügbar? ─── */
function checkPdflatex() {
  return new Promise(resolve => {
    execFile('pdflatex', ['--version'], (err) => resolve(!err));
  });
}

/* ─── POST /compile ─── */
app.post('/compile', async (req, res) => {
  const { latex } = req.body;

  if (!latex || typeof latex !== 'string') {
    return res.status(400).json({ error: 'Kein LaTeX-Code übermittelt.' });
  }

  /* Prüfe ob pdflatex installiert ist */
  const hasPdflatex = await checkPdflatex();
  if (!hasPdflatex) {
    return res.status(500).json({
      error: 'pdflatex nicht gefunden. Bitte TeX Live oder MiKTeX installieren.\n' +
             'macOS:   brew install --cask mactex-no-gui\n' +
             'Ubuntu:  sudo apt install texlive-full\n' +
             'Windows: https://miktex.org/download'
    });
  }

  /* Temporäres Verzeichnis anlegen */
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latex-'));
  const texFile = path.join(tmpDir, 'main.tex');
  const pdfFile = path.join(tmpDir, 'main.pdf');
  const logFile = path.join(tmpDir, 'main.log');

  try {
    /* .tex schreiben */
    fs.writeFileSync(texFile, latex, 'utf8');

    /* pdflatex zweimal ausführen (Verweise/Inhaltsverzeichnis korrekt) */
    await runPdflatex(texFile, tmpDir);
    await runPdflatex(texFile, tmpDir);   // 2. Durchlauf für Referenzen

    /* PDF zurückgeben */
    if (!fs.existsSync(pdfFile)) {
      const log = fs.existsSync(logFile)
        ? fs.readFileSync(logFile, 'utf8').slice(-2000)
        : 'Kein Log verfügbar.';
      return res.status(500).json({ error: 'PDF wurde nicht erstellt.', log });
    }

    const pdfBuffer = fs.readFileSync(pdfFile);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="vorlesungsnotizen.pdf"');
    res.send(pdfBuffer);

  } catch (err) {
    /* Log-Datei für Debugging zurückgeben */
    let log = '';
    if (fs.existsSync(logFile)) {
      log = fs.readFileSync(logFile, 'utf8').slice(-3000);
    }
    console.error('[pdflatex error]', err.message);
    res.status(500).json({ error: err.message, log });

  } finally {
    /* Aufräumen */
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

/* ─── pdflatex ausführen ─── */
function runPdflatex(texFile, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      'pdflatex',
      [
        '-interaction=nonstopmode',
        '-halt-on-error',
        '-output-directory', cwd,
        texFile
      ],
      { cwd, timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error('pdflatex Fehler: ' + (stderr || err.message)));
        } else {
          resolve(stdout);
        }
      }
    );
  });
}

/* ─── Start ─── */
app.listen(PORT, async () => {
  const hasPdflatex = await checkPdflatex();
  console.log(`
╔════════════════════════════════════════════╗
║   Notizen → LaTeX → PDF                   ║
╠════════════════════════════════════════════╣
║   Server läuft auf http://localhost:${PORT}  ║
║                                            ║
║   pdflatex: ${hasPdflatex ? '✓ gefunden                   ' : '✗ NICHT GEFUNDEN             '} ║
${!hasPdflatex ? '║   → sudo apt install texlive-full          ║\n║   → brew install --cask mactex-no-gui     ║\n' : ''}╚════════════════════════════════════════════╝
  `);
});
