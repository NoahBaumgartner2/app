const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const fsExtra = require('fs-extra');
const path = require('path');
const { execSync, exec } = require('child_process');
const tmp = require('tmp');

const app = express();
const PORT = process.env.PORT || 3002;

// Multer: PDF uploads im Arbeitsspeicher
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Nur PDF-Dateien erlaubt'), false);
  },
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

app.use(express.json());
app.use(express.static('.'));

// ── LaTeX-Template ──────────────────────────────────────────────────────────
function buildLatexDocument(title, subject, summary, date) {
  const safeTitle = title.replace(/[_&%$#{}~^\\]/g, m => `\\${m}`);
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
\\geometry{
  top=2.5cm, bottom=2.5cm,
  left=2.5cm, right=2.5cm,
  headheight=15pt
}

% ── Farben ──────────────────────────────────────────────────────────────────
\\definecolor{primary}{RGB}{26, 54, 93}
\\definecolor{accent}{RGB}{41, 128, 185}
\\definecolor{lightgray}{RGB}{245, 247, 250}
\\definecolor{darkgray}{RGB}{80, 80, 80}
\\definecolor{highlight}{RGB}{255, 243, 205}
\\definecolor{keyterm}{RGB}{231, 76, 60}

% ── Überschriften ───────────────────────────────────────────────────────────
\\titleformat{\\section}
  {\\large\\bfseries\\color{primary}}
  {\\thesection}{1em}{}[\\titlerule]
\\titleformat{\\subsection}
  {\\normalsize\\bfseries\\color{accent}}
  {\\thesubsection}{1em}{}
\\titleformat{\\subsubsection}
  {\\normalsize\\itshape\\color{darkgray}}
  {\\thesubsubsection}{1em}{}

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
\\newtcolorbox{definitionbox}{
  colback=lightgray, colframe=accent,
  arc=4pt, left=8pt, right=8pt, top=6pt, bottom=6pt,
  breakable, title style={font=\\bfseries\\small}
}
\\newtcolorbox{keybox}{
  colback=highlight, colframe=keyterm!60,
  arc=3pt, left=6pt, right=6pt, top=4pt, bottom=4pt,
  breakable
}
\\newtcolorbox{infobox}[1]{
  title=#1, colback=primary!5, colframe=primary!60,
  arc=4pt, left=8pt, right=8pt, top=6pt, bottom=6pt,
  coltitle=white, attach boxed title to top left={yshift=-2mm},
  boxed title style={colback=primary},
  breakable
}

% ── Hyperlinks ──────────────────────────────────────────────────────────────
\\hypersetup{
  colorlinks=true, linkcolor=accent,
  urlcolor=accent, citecolor=accent,
  pdfauthor={KI-Zusammenfassung},
  pdftitle={${safeTitle}}
}

% ── Metadaten ───────────────────────────────────────────────────────────────
\\title{%
  {\\color{primary}\\Large\\bfseries Zusammenfassung}\\\\[0.3em]
  {\\color{accent}\\huge\\bfseries ${safeTitle}}\\\\[0.5em]
  {\\large\\color{darkgray}\\textit{${safeSubject}}}
}
\\author{Erstellt mit KI-Unterstützung}
\\date{${date}}

% ════════════════════════════════════════════════════════════════════════════
\\begin{document}
% ════════════════════════════════════════════════════════════════════════════

\\maketitle
\\thispagestyle{fancy}

\\begin{tcolorbox}[colback=primary!8, colframe=primary, arc=5pt,
    title={\\bfseries\\color{white} Über diese Zusammenfassung},
    coltitle=white, attach boxed title to top left={yshift=-2mm},
    boxed title style={colback=primary}]
Diese Zusammenfassung wurde automatisch aus den Vorlesungsfolien generiert.
Sie dient als Lernhilfe zur Prüfungsvorbereitung und enthält die wichtigsten
Konzepte, Definitionen und Zusammenhänge des Lernstoffs.
\\end{tcolorbox}

\\tableofcontents
\\newpage

${summary}

\\end{document}
`;
}

// ── Gemini-Anfrage ───────────────────────────────────────────────────────────
async function summarizeWithGemini(apiKey, pdfBuffer, fileName, subjectHint) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

  const pdfBase64 = pdfBuffer.toString('base64');

  const prompt = `Du bist ein Experte für BWL-Fächer (Wirtschaftsinformatik, Marketing, Controlling, Rechnungswesen, Management, etc.).

Analysiere die folgenden Vorlesungsfolien und erstelle eine SEHR AUSFÜHRLICHE und STRUKTURIERTE Zusammenfassung auf Deutsch.

Fach-Hinweis: ${subjectHint || 'BWL / Wirtschaft'}
Dateiname: ${fileName}

WICHTIGE ANFORDERUNGEN:
1. Die Zusammenfassung muss in **LaTeX-Syntax** geschrieben sein (keine \\documentclass etc., nur den Body-Inhalt)
2. Nutze \\section{}, \\subsection{}, \\subsubsection{} für die Struktur
3. Verwende folgende LaTeX-Umgebungen:
   - \\begin{definitionbox}...\\end{definitionbox} für Definitionen
   - \\begin{keybox}...\\end{keybox} für wichtige Merksätze/Kernaussagen
   - \\begin{infobox}{Titel}...\\end{infobox} für Erklärungen/Hintergründe
   - \\begin{itemize}...\\end{itemize} und \\begin{enumerate} für Listen
   - \\textbf{Begriff} für Fachbegriffe
   - \\textit{...} für Hervorhebungen
4. Sei SEHR AUSFÜHRLICH - erkläre jeden Begriff, jedes Konzept und jeden Zusammenhang
5. Füge praktische Beispiele hinzu wo sinnvoll
6. Decke ALLE Themen der Folien ab - nichts weglassen
7. Strukturiere nach den Hauptthemen der Vorlesung
8. Füge am Ende eine \\section{Zusammenfassung \\& Prüfungsrelevantes} hinzu mit den wichtigsten Punkten

Beginne direkt mit dem ersten \\section{} ohne Präambel oder Kommentare.`;

  const result = await model.generateContent([
    {
      inlineData: {
        mimeType: 'application/pdf',
        data: pdfBase64
      }
    },
    { text: prompt }
  ]);

  const text = result.response.text();
  return text;
}

// ── LaTeX → PDF kompilieren ──────────────────────────────────────────────────
function compileLaTeX(latexContent) {
  return new Promise((resolve, reject) => {
    const tmpDir = tmp.dirSync({ unsafeCleanup: true });
    const texFile = path.join(tmpDir.name, 'summary.tex');
    const pdfFile = path.join(tmpDir.name, 'summary.pdf');

    fs.writeFileSync(texFile, latexContent, 'utf8');

    // pdflatex zweimal ausführen (für TOC und Referenzen)
    const cmd = `cd "${tmpDir.name}" && pdflatex -interaction=nonstopmode -output-directory="${tmpDir.name}" "${texFile}" 2>&1 && pdflatex -interaction=nonstopmode -output-directory="${tmpDir.name}" "${texFile}" 2>&1`;

    exec(cmd, { timeout: 60000 }, (error, stdout, stderr) => {
      if (fs.existsSync(pdfFile)) {
        const pdfBuffer = fs.readFileSync(pdfFile);
        tmpDir.removeCallback();
        resolve(pdfBuffer);
      } else {
        tmpDir.removeCallback();
        reject(new Error(`LaTeX-Kompilierung fehlgeschlagen.\n\nLog:\n${stdout}\n${stderr}`));
      }
    });
  });
}

// ── API-Routen ───────────────────────────────────────────────────────────────

// Hauptroute: PDF hochladen, zusammenfassen, LaTeX + PDF zurückgeben
app.post('/api/summarize', upload.single('pdf'), async (req, res) => {
  try {
    const { apiKey, subject, title } = req.body;

    if (!req.file) return res.status(400).json({ error: 'Keine PDF-Datei hochgeladen.' });
    if (!apiKey) return res.status(400).json({ error: 'Kein Gemini API-Key angegeben.' });

    const fileName = req.file.originalname;
    const docTitle = title || path.basename(fileName, '.pdf');
    const docSubject = subject || 'BWL';
    const date = new Date().toLocaleDateString('de-DE', {
      year: 'numeric', month: 'long', day: 'numeric'
    });

    console.log(`[→] Zusammenfassung gestartet: ${fileName}`);

    // 1. Gemini-Zusammenfassung
    const summary = await summarizeWithGemini(apiKey, req.file.buffer, fileName, docSubject);
    console.log(`[✓] KI-Zusammenfassung erhalten (${summary.length} Zeichen)`);

    // 2. LaTeX-Dokument bauen
    const latexDoc = buildLatexDocument(docTitle, docSubject, summary, date);

    // 3. PDF kompilieren (wenn pdflatex verfügbar)
    let pdfBuffer = null;
    let pdfError = null;
    try {
      pdfBuffer = await compileLaTeX(latexDoc);
      console.log(`[✓] PDF kompiliert (${pdfBuffer.length} Bytes)`);
    } catch (e) {
      pdfError = e.message;
      console.warn(`[!] PDF-Kompilierung fehlgeschlagen: ${e.message.substring(0, 100)}...`);
    }

    // Antwort
    const responseData = {
      success: true,
      latex: latexDoc,
      fileName: docTitle,
      subject: docSubject,
      charCount: summary.length
    };

    if (pdfBuffer) {
      responseData.pdf = pdfBuffer.toString('base64');
    } else {
      responseData.pdfError = pdfError ? 'pdflatex nicht installiert. LaTeX-Code kann manuell kompiliert werden.' : null;
    }

    res.json(responseData);

  } catch (err) {
    console.error('[✗] Fehler:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Nur LaTeX zurückgeben (ohne PDF-Kompilierung)
app.post('/api/latex-only', upload.single('pdf'), async (req, res) => {
  try {
    const { apiKey, subject, title } = req.body;
    if (!req.file) return res.status(400).json({ error: 'Keine PDF-Datei hochgeladen.' });
    if (!apiKey) return res.status(400).json({ error: 'Kein Gemini API-Key angegeben.' });

    const fileName = req.file.originalname;
    const docTitle = title || path.basename(fileName, '.pdf');
    const docSubject = subject || 'BWL';
    const date = new Date().toLocaleDateString('de-DE', { year: 'numeric', month: 'long', day: 'numeric' });

    const summary = await summarizeWithGemini(apiKey, req.file.buffer, fileName, docSubject);
    const latexDoc = buildLatexDocument(docTitle, docSubject, summary, date);

    res.json({
      success: true,
      latex: latexDoc,
      fileName: docTitle,
      subject: docSubject
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Server starten
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║   Vorlesungs-Zusammenfassung Server              ║
║   http://localhost:${PORT}                          ║
╚══════════════════════════════════════════════════╝
  `);

  // Prüfe ob pdflatex verfügbar ist
  try {
    execSync('pdflatex --version', { stdio: 'ignore' });
    console.log('[✓] pdflatex gefunden – PDF-Erstellung aktiviert');
  } catch {
    console.log('[!] pdflatex nicht gefunden – nur LaTeX-Export verfügbar');
    console.log('    Installation: sudo apt-get install texlive-full');
  }
});
