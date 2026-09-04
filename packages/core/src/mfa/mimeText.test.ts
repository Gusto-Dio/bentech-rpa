import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractTextFromRfc822, stripTags } from './mimeText.ts';

/**
 * This parser stands between a raw IMAP fetch and the six-digit code, so its
 * failure mode is specific and expensive: an undecoded `base64` body contains no
 * digit run at all, so the poll times out on mail that arrived correctly and
 * reports it as a System failure. Every shape below is one carriers really send.
 */

const CODE = '123456';

describe('extractTextFromRfc822', () => {
  it('reads a plain single-part body', () => {
    const source = ['Content-Type: text/plain; charset=UTF-8', '', `Your code is ${CODE}.`].join('\r\n');
    assert.match(extractTextFromRfc822(source), new RegExp(CODE));
  });

  it('decodes base64, where the code is otherwise invisible', () => {
    const body = Buffer.from(`Your code is ${CODE}.`).toString('base64');
    const source = [
      'Content-Type: text/plain',
      'Content-Transfer-Encoding: base64',
      '',
      body,
    ].join('\r\n');

    assert.match(extractTextFromRfc822(source), new RegExp(CODE));
  });

  /**
   * Quoted-printable splits long lines with a trailing `=`, and a six-digit
   * code can land across that break. Decoding the soft break first is what
   * keeps the digits contiguous.
   */
  it('decodes quoted-printable, including a code split across a soft line break', () => {
    const source = [
      'Content-Type: text/plain',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Your code is 123=',
      '456 and it expires soon. Cost: =2450',
    ].join('\r\n');

    const text = extractTextFromRfc822(source);
    assert.match(text, /123456/);
    assert.match(text, /\$50/, '=24 should decode to a dollar sign');
  });

  it('prefers text/plain over text/html in a multipart message', () => {
    const source = [
      'Content-Type: multipart/alternative; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain',
      '',
      `plain says ${CODE}`,
      '--b1',
      'Content-Type: text/html',
      '',
      '<p>html says 999999</p>',
      '--b1--',
    ].join('\r\n');

    const text = extractTextFromRfc822(source);
    assert.match(text, new RegExp(CODE));
    assert.doesNotMatch(text, /999999/);
  });

  it('falls back to tag-stripped html when there is no plain part', () => {
    const source = [
      'Content-Type: multipart/alternative; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/html',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(`<div><b>${CODE}</b></div>`).toString('base64'),
      '--b1--',
    ].join('\r\n');

    const text = extractTextFromRfc822(source);
    assert.match(text, new RegExp(CODE));
    assert.doesNotMatch(text, /<div>/);
  });

  /** `multipart/mixed` wrapping a `multipart/alternative` is the usual real shape. */
  it('recurses one level into a nested multipart', () => {
    const source = [
      'Content-Type: multipart/mixed; boundary="outer"',
      '',
      '--outer',
      'Content-Type: multipart/alternative; boundary="inner"',
      '',
      '--inner',
      'Content-Type: text/plain',
      '',
      `nested code ${CODE}`,
      '--inner--',
      '--outer--',
    ].join('\r\n');

    assert.match(extractTextFromRfc822(source), new RegExp(CODE));
  });

  /**
   * A long `Content-Type` gets folded onto a second line, and that is exactly
   * where `boundary=` tends to end up. Without unfolding, the message parses as
   * single-part and the parts are never read.
   */
  it('unfolds a wrapped Content-Type header to find the boundary', () => {
    const source = [
      'Content-Type: multipart/alternative;',
      '\tboundary="deadbeef"',
      '',
      '--deadbeef',
      'Content-Type: text/plain',
      '',
      `folded ${CODE}`,
      '--deadbeef--',
    ].join('\r\n');

    assert.match(extractTextFromRfc822(source), new RegExp(CODE));
  });

  it('tolerates bare \\n instead of CRLF, which fixtures and some servers produce', () => {
    assert.match(extractTextFromRfc822(`Content-Type: text/plain\n\ncode ${CODE}`), new RegExp(CODE));
  });

  /**
   * Fails closed. An unparseable message yields whatever text it managed, the
   * code pattern then does not match, and the poll keeps waiting - which is the
   * correct behaviour for mail this cannot read.
   */
  it('returns something harmless rather than throwing on junk', () => {
    assert.equal(typeof extractTextFromRfc822(''), 'string');
    assert.equal(typeof extractTextFromRfc822('not a message at all'), 'string');
  });
});

describe('stripTags', () => {
  it('drops markup but keeps the text', () => {
    assert.equal(stripTags('<p>Hello <b>world</b></p>'), 'Hello world');
  });

  it('removes script and style content entirely', () => {
    assert.equal(stripTags('<style>b{color:red}</style><p>only this</p>'), 'only this');
    assert.doesNotMatch(stripTags('<script>var code = 999999;</script><p>ok</p>'), /999999/);
  });

  it('decodes the entities that would otherwise break a code match', () => {
    assert.equal(stripTags('a&nbsp;b&amp;c'), 'a b&c');
  });
});

/**
 * A styled one-time code is often built digit by digit, and stripping each tag
 * to a space pulls it apart: `6 5 4321` does not match `\b(\d{6})\b`. The code
 * arrived correctly and the poll would time out, reporting a System failure for
 * mail that was fine.
 */
describe('stripTags - digits split across markup', () => {
  it('rejoins a code whose digits are individually wrapped', () => {
    assert.match(stripTags('<span>6</span><span>5</span>4321'), /654321/);
  });

  it('rejoins digits wrapped one tag at a time, all six', () => {
    const html = [...'123456'].map((d) => `<b>${d}</b>`).join('');
    assert.match(stripTags(html), /123456/);
  });

  it('rejoins across attributes and whitespace between the tags', () => {
    assert.match(
      stripTags('<td style="x">12</td>\n  <td style="y">3456</td>'),
      /123456/,
    );
  });

  /** The other half of the trade-off: words must NOT be run together. */
  it('still separates words in adjacent blocks', () => {
    assert.equal(stripTags('<p>one</p><p>two</p>'), 'one two');
  });

  it('leaves a plain contiguous code alone', () => {
    assert.match(stripTags('<p>Your code is 654321.</p>'), /654321/);
  });
});
