// Fast drop-in for csv-reader 1.0.0: reads the same broken CSV and returns the
// same {columns, rows, errors}. Written from the published behaviour spec:
// a U+FEFF at the very start is dropped; records end at LF or CRLF; a CR
// outside quotes that is not followed by LF is dropped with a stray_cr error;
// a field that opens with a quote runs to the next quote that is not doubled
// ("" inside it is one quote, and each CRLF or lone CR inside it becomes LF);
// whatever follows the closing quote up to the next comma or line break is
// appended as it stands, with a quote_junk error when anything was appended;
// a quote that never closes is a literal character and the text after it is
// re-read as unquoted, with an unterminated_quote error; a quote inside an
// unquoted field is a literal character; fields stay strings, never trimmed
// or converted; columns is the first record when header is true, else null;
// rows are the records after it, each padded with "" (short_row, with fields:
// its field count) or cut (long_row, with extra: the cut fields) to the first
// record's width; each error is {code, line, row} in the order met, line the
// 1-based line its record starts on and row the record's index in rows (null
// for the header); a line left with no characters is no record.
//
// Speed comes from never walking the text a character at a time on the
// common path: whole plain lines are split at once, and every other field is
// cut out with indexOf plus slice, so a field costs a few native scans
// instead of one string append per character. Only genuinely broken pieces
// (a stray CR, a doubled quote, a line break inside quotes, junk after a
// closing quote) fall back to small, bounded fix-up code below.

const COMMA = 0;
const BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let recordLine = 1;
  let recordRow = null;

  // Turns CRs inside a quoted segment into LF (CRLF and a lone CR each
  // become one LF) and counts the line breaks the segment held into `line`.
  function convert(seg) {
    if (seg.indexOf('\r') === -1) {
      if (seg.indexOf('\n') !== -1) {
        let k = 0;
        let i = -1;
        while ((i = seg.indexOf('\n', i + 1)) !== -1) k++;
        line += k;
      }
      return seg;
    }
    const m = seg.match(/\r\n|\r|\n/g);
    if (m) line += m.length;
    return seg.replace(/\r\n?/g, '\n');
  }

  // Reads an unquoted field starting at `cursor`, on top of `value`.
  // Returns {value, ended, added}: added counts the characters this call
  // kept, not the ones `value` already held. A stray CR is dropped with one
  // error per CR; a CR followed by LF ends the field as a line break.
  function unquoted(value, cursor) {
    let added = 0;
    const p = cursor;
    const c = text.indexOf(',', p);
    const nl = text.indexOf('\n', p);
    let t = n;
    let kind = END;
    if (c !== -1 && c < t) {
      t = c;
      kind = COMMA;
    }
    if (nl !== -1 && nl < t) {
      t = nl;
      kind = BREAK;
    }
    let seg = text.slice(p, t);
    if (kind === BREAK && seg.charCodeAt(seg.length - 1) === 13) seg = seg.slice(0, -1);
    if (seg.indexOf('\r') === -1) {
      if (seg.length > 0) {
        value += seg;
        added += seg.length;
      }
    } else {
      // Stray CRs inside this field: drop each one, one error apiece.
      const pieces = seg.split('\r');
      const kept = pieces.join('');
      for (let i = 1; i < pieces.length; i++) {
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      }
      if (kept.length > 0) {
        value += kept;
        added += kept.length;
      }
    }
    if (kind === COMMA) {
      pos = t + 1;
      return { value, ended: COMMA, added };
    }
    if (kind === BREAK) {
      pos = t + 1;
      line += 1;
      return { value, ended: BREAK, added };
    }
    pos = n;
    return { value, ended: END, added };
  }

  // Reads a quoted field whose opening quote is at `pos`. A doubled quote
  // contributes one quote and the scan goes on; a quote that never closes
  // is treated as a literal character and the text after it is re-read as
  // an unquoted field, with the line rewound to where the quote opened.
  function quoted() {
    const open = pos;
    const openLine = line;
    let p = open + 1;
    let parts = null;
    let value;
    for (;;) {
      const q = text.indexOf('"', p);
      if (q === -1) {
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return unquoted('"', open + 1);
      }
      if (text.charCodeAt(q + 1) === 34) {
        const seg = convert(text.slice(p, q));
        if (parts === null) parts = [seg, '"'];
        else {
          parts.push(seg);
          parts.push('"');
        }
        p = q + 2;
        continue;
      }
      const seg = convert(text.slice(p, q));
      value = parts === null ? seg : parts.join('') + seg;
      pos = q + 1;
      break;
    }
    if (pos >= n) return { value, ended: END, added: 0 };
    const ch = text.charCodeAt(pos);
    if (ch === 44) {
      pos += 1;
      return { value, ended: COMMA, added: 0 };
    }
    if (ch === 10) {
      pos += 1;
      line += 1;
      return { value, ended: BREAK, added: 0 };
    }
    if (ch === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: BREAK, added: 0 };
    }
    // Whatever follows the closing quote is appended as it stands.
    const junk = unquoted(value, pos);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  // Files one finished record: the header when it is the first record and
  // header is true, otherwise a row padded or cut to the first record's
  // width, with the matching short_row or long_row error.
  function pushRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (pos < n) {
    // Fast path: a whole physical line with no quote in it and no CR except
    // a CRLF's own at its end is one plain record — split it at once.
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? n : nl;
    let content = text.slice(pos, lineEnd);
    const cr = content.indexOf('\r');
    if (
      content.indexOf('"') === -1 &&
      (cr === -1 || (nl !== -1 && cr === content.length - 1))
    ) {
      if (cr !== -1) content = content.slice(0, -1);
      if (content.length === 0) {
        if (nl === -1) break;
        pos = nl + 1;
        line += 1;
        continue;
      }
      recordLine = line;
      recordRow = header && columns === null ? null : rows.length;
      const fields = content.split(',');
      pos = nl === -1 ? n : nl + 1;
      if (nl !== -1) line += 1;
      pushRecord(fields);
      continue;
    }
    // Slow path: the line holds a quote or a stray CR, so read it a field
    // at a time. Blank lines first, exactly as the reference skips them.
    while (pos < n) {
      if (text.charCodeAt(pos) === 10) {
        pos += 1;
        line += 1;
      } else if (text.charCodeAt(pos) === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else break;
    }
    if (pos >= n) break;
    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let lastQuoted = false;
    let ended;
    do {
      let f;
      if (text.charCodeAt(pos) === 34) {
        lastQuoted = true;
        f = quoted();
      } else {
        lastQuoted = false;
        f = unquoted('', pos);
      }
      fields.push(f.value);
      ended = f.ended;
    } while (ended === COMMA);
    // A line left with no characters is no record (its errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;
    pushRecord(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
