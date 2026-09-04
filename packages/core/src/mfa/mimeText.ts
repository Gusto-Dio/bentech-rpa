/**
 * Getting readable text out of a raw RFC822 message.
 *
 * The Gmail REST API hands back a parsed part tree, so `GmailApiMfaProvider`
 * only has to pick a part and base64url-decode it. IMAP hands back the whole
 * message as bytes, so the parsing has to happen here.
 *
 * Why it matters rather than being a nicety: carriers send the code in an HTML
 * part, and both `base64` and `quoted-printable` are common transfer encodings.
 * An undecoded base64 body contains no six-digit run at all, so the poll would
 * time out on mail that had arrived correctly and report it as a System failure.
 */

/** Strips markup so a code in an HTML body is still findable. */
export function stripTags(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The best available text for one raw message.
 *
 * `text/plain` first, then tag-stripped `text/html`, then the whole body as-is.
 * Prefers plain for the same reason the Gmail provider does: it is what the
 * carrier's own template puts the code in, and it needs no stripping.
 *
 * Deliberately tolerant. A message this cannot parse yields whatever text it
 * managed, and the caller's code pattern then simply does not match - which
 * fails closed, exactly as an unparseable message should.
 */
export function extractTextFromRfc822(source: string): string {
  const { headers, body } = splitOnce(source);
  const contentType = headerValue(headers, 'content-type');

  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(contentType)?.[1];
  if (boundary !== undefined) {
    const parts = splitMultipart(body, boundary);

    const plain = parts.find((part) => /text\/plain/i.test(headerValue(part.headers, 'content-type')));
    if (plain !== undefined) return decodePart(plain);

    const html = parts.find((part) => /text\/html/i.test(headerValue(part.headers, 'content-type')));
    if (html !== undefined) return stripTags(decodePart(html));

    /**
     * A nested multipart - `multipart/mixed` wrapping a `multipart/alternative`
     * is the usual shape. Recursing into each part is cheaper than a full MIME
     * tree, and one level is all these carrier mails ever use.
     */
    for (const part of parts) {
      if (/multipart\//i.test(headerValue(part.headers, 'content-type'))) {
        const nested = extractTextFromRfc822(`${part.headers}\r\n\r\n${part.body}`);
        if (nested !== '') return nested;
      }
    }
    return '';
  }

  const decoded = decode(body, headerValue(headers, 'content-transfer-encoding'));
  return /text\/html/i.test(contentType) ? stripTags(decoded) : decoded;
}

interface MimePart {
  headers: string;
  body: string;
}

function splitOnce(source: string): MimePart {
  // \r\n\r\n per the RFC, but servers and test fixtures both produce \n\n.
  const match = /\r?\n\r?\n/.exec(source);
  if (match === null) return { headers: source, body: '' };
  return {
    headers: source.slice(0, match.index),
    body: source.slice(match.index + match[0].length),
  };
}

/**
 * Reads one header, unfolding continuation lines.
 *
 * Unfolding is required rather than cosmetic: a long `Content-Type` is wrapped
 * onto a second line, and that is precisely where the `boundary=` parameter
 * usually ends up.
 */
function headerValue(headers: string, name: string): string {
  const unfolded = headers.replace(/\r?\n[ \t]+/g, ' ');
  const pattern = new RegExp(`^${name}:\\s*(.+)$`, 'im');
  return pattern.exec(unfolded)?.[1]?.trim() ?? '';
}

function splitMultipart(body: string, boundary: string): MimePart[] {
  const delimiter = `--${boundary}`;
  return body
    .split(delimiter)
    .slice(1)
    .filter((chunk) => !chunk.trimStart().startsWith('--'))
    .map((chunk) => splitOnce(chunk.replace(/^\r?\n/, '')));
}

function decodePart(part: MimePart): string {
  return decode(part.body, headerValue(part.headers, 'content-transfer-encoding'));
}

function decode(body: string, encoding: string): string {
  const normalized = encoding.toLowerCase();
  if (normalized.startsWith('base64')) {
    return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  }
  if (normalized.startsWith('quoted-printable')) {
    return body
      // Soft line breaks first: `=` at end of line means "no break here".
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  }
  return body;
}
