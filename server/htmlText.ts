// The visible text of an HTML page, read without running or loading anything, so two versions of an artifact can be
// compared line by line: one line a block, scripts, styles and comments left out. Also imported by the mock.

const DROPPED = /<(script|style|template|noscript|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const BLOCK = /<\/?(address|article|aside|blockquote|body|br|caption|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|html|legend|li|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|title|tr|ul|svg|text|g|foreignObject|option|label|button)\b[^>]*>/gi;

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rarr: '→', larr: '←', middot: '·', times: '×' };

function decode(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] !== '#') return NAMED[code.toLowerCase()] ?? whole;
    const n = code[1] === 'x' || code[1] === 'X' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
    return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
  });
}

export function htmlText(html: string) {
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(DROPPED, '')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(BLOCK, '\n')
    .replace(/<[^>]*>/g, '');
  const lines = [...(title ? [decode(title.replace(/<[^>]*>/g, ''))] : []), ...decode(text).split('\n')]
    .map((l) => l.replace(/[ \t\f\v\u00a0]+/g, ' ').trim())
    .filter((l) => l && l !== '•');
  return lines.join('\n');
}
