const path = require('path');
const { buildLatexDocument, summarizeWithGemini, parseMultipart } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { fields, fileBuffer, fileName } = await parseMultipart(event);
    const { apiKey, subject, title } = fields;

    if (!fileBuffer) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Keine PDF-Datei hochgeladen.' })
      };
    }
    if (!apiKey) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Kein Gemini API-Key angegeben.' })
      };
    }

    const docTitle = title || path.basename(fileName || 'document', '.pdf');
    const docSubject = subject || 'BWL';
    const date = new Date().toLocaleDateString('de-DE', {
      year: 'numeric', month: 'long', day: 'numeric'
    });

    const summary = await summarizeWithGemini(apiKey, fileBuffer, fileName || 'document.pdf', docSubject);
    const latexDoc = buildLatexDocument(docTitle, docSubject, summary, date);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        latex: latexDoc,
        fileName: docTitle,
        subject: docSubject
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
