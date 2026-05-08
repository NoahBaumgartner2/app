const https = require('https');
const crypto = require('crypto');

function compileLatex(latexContent) {
  return new Promise((resolve, reject) => {
    const boundary = '----TeXBoundary' + crypto.randomBytes(12).toString('hex');
    const crlf = '\r\n';

    const field = (name, value) =>
      `--${boundary}${crlf}Content-Disposition: form-data; name="${name}"${crlf}${crlf}${value}${crlf}`;

    const bodyStr =
      field('filecontents[]', latexContent) +
      field('filename[]', 'document.tex') +
      field('engine', 'pdflatex') +
      field('return', 'pdf') +
      `--${boundary}--${crlf}`;

    const body = Buffer.from(bodyStr, 'utf8');

    const options = {
      hostname: 'texlive.net',
      path: '/cgi-bin/latexcgi',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const result = Buffer.concat(chunks);
        const ct = res.headers['content-type'] || '';
        if (res.statusCode === 200 && ct.includes('application/pdf')) {
          resolve(result);
        } else {
          reject(new Error(
            `Kompilierung fehlgeschlagen (${res.statusCode}): ${result.toString('utf8').substring(0, 500)}`
          ));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(24000, () => {
      req.destroy();
      reject(new Error('Zeitüberschreitung (24s). Bitte nutze stattdessen "In Overleaf öffnen".'));
    });

    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Ungültiger Request-Body.' })
    };
  }

  const { latex } = body;
  if (!latex) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Kein LaTeX-Code angegeben.' })
    };
  }

  try {
    const pdfBuffer = await compileLatex(latex);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, pdf: pdfBuffer.toString('base64') })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
