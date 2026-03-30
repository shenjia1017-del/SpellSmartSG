/**
 * Extract plain text from page 1 of a PDF (base64, no data: prefix).
 * Used when Vision cannot read the PDF directly (Expo / API limits).
 */
export async function extractTextFromPdfPage1Base64(base64) {
  const clean = String(base64 ?? '').replace(/\s/g, '');
  if (!clean) return '';

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '';

  const binary = atob(clean);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  const pdf = await pdfjs.getDocument({ data: bytes, useSystemFonts: true }).promise;
  const page = await pdf.getPage(1);
  const textContent = await page.getTextContent();
  return textContent.items
    .map((item) => (item && typeof item.str === 'string' ? item.str : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
