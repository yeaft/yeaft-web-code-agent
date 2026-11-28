/**
 * Bounded linear-time Markdown link/image/URL redactor for owner-private Cosmic Web content.
 * Shared across RSS excerpt sanitization, Clean Article source-DOM AI projection, and Server AI payloads.
 */

export function dropTrailingToken(str) {
  let end = str.length;
  while (end > 0 && !/\s/.test(str[end - 1])) end--;
  return end === str.length ? str : str.slice(0, end);
}

export function createRedactionBudget({ maxUrlChecks = 256, maxScanSteps = 128_000, maxLinkSteps = 400_000 } = {}) {
  return { urlChecks: 0, scanSteps: 0, linkSteps: 0, maxUrlChecks, maxScanSteps, maxLinkSteps, exhausted: false };
}

function stripBracketedLinksWithMap(text, imagesOnly, maxSteps = 200_000, prevMap = null, sharedBudget = null) {
  if (imagesOnly ? !text.includes('![') : !text.includes('](')) {
    return { text, map: prevMap, exhausted: false };
  }
  let out = '';
  const map = prevMap ? [] : (sharedBudget ? [] : null);
  let i = 0;
  let steps = 0;
  const len = text.length;
  let nextClose = text.indexOf(']');
  const origIdx = idx => (prevMap ? prevMap[idx] : idx);
  const bumpStep = () => {
    if (sharedBudget) return ++sharedBudget.linkSteps > sharedBudget.maxLinkSteps;
    return ++steps > maxSteps;
  };
  const failExhausted = () => {
    const trimmed = dropTrailingToken(out);
    if (map) map.length = trimmed.length;
    return { text: trimmed, map, exhausted: true };
  };
  while (i < len) {
    if (bumpStep()) return failExhausted();
    const matchOpen = imagesOnly ? (text[i] === '!' && text[i + 1] === '[') : (text[i] === '[');
    if (matchOpen && nextClose !== -1) {
      const labelStart = imagesOnly ? i + 2 : i + 1;
      while (nextClose !== -1 && nextClose < labelStart) nextClose = text.indexOf(']', nextClose + 1);
      if (nextClose !== -1 && nextClose - labelStart <= 512 && text[nextClose + 1] === '(') {
        let j = nextClose + 2;
        const limit = Math.min(len, nextClose + 2 + 2048);
        while (j < limit && (text[j] === ' ' || text[j] === '\t')) {
          if (bumpStep()) return failExhausted();
          j++;
        }
        let matchedClose = false;
        if (j < limit && text[j] === '<') {
          // Angle-delimited destination (<...>) emitted by extractCleanArticle: scan as a single unit ignoring ')' inside <...>.
          j++;
          while (j < limit && text[j] !== '>' && text[j] !== '\n') {
            if (bumpStep()) return failExhausted();
            if (text[j] === '\\' && j + 1 < limit) { j += 2; continue; }
            j++;
          }
          if (j < limit && text[j] === '>') {
            j++;
            while (j < limit && text[j] !== ')' && text[j] !== '\n') {
              if (bumpStep()) return failExhausted();
              if (text[j] === '\\' && j + 1 < limit) { j += 2; continue; }
              if (text[j] === '"' || text[j] === "'") {
                const q = text[j++];
                while (j < limit && text[j] !== q && text[j] !== '\n') {
                  if (bumpStep()) return failExhausted();
                  if (text[j] === '\\' && j + 1 < limit) { j += 2; continue; }
                  j++;
                }
                if (j < limit && text[j] === q) j++;
                continue;
              }
              j++;
            }
            if (j < limit && text[j] === ')') {
              j++;
              matchedClose = true;
            }
          }
        } else {
          let depth = 1;
          while (j < limit && depth > 0) {
            if (bumpStep()) return failExhausted();
            if (text[j] === '\\' && j + 1 < limit) { j += 2; continue; }
            if (text[j] === '(') depth++;
            else if (text[j] === ')') depth--;
            j++;
          }
          matchedClose = depth === 0;
        }
        if (matchedClose) {
          if (map) {
            for (let p = labelStart; p < nextClose; p++) map.push(origIdx(p));
          }
          out += text.slice(labelStart, nextClose);
          i = j;
          continue;
        }
      }
    }
    if (map) map.push(origIdx(i));
    out += text[i];
    i++;
  }
  return { text: out, map, exhausted: false };
}

// Separate Unicode punctuation (\p{P}, sentence/wrapper boundaries) from Unicode symbols (\p{S}, valid WHATWG host chars like ☃ or 🚀).
const UNICODE_PUNCT_RE = /\p{P}/u;
const UNICODE_SYMBOL_RE = /\p{S}/u;
const isWhatwgDot = code => code === 0x002e || code === 0x3002 || code === 0xff0e || code === 0xff61;
// Percent-encoded WHATWG host dot separators normalized by Node URL parsing: %2e (.), %e3%80%82 (。), %ef%bc%8e (．), %ef%bd%a1 (｡).
const PERCENT_WHATWG_DOT_RE = /%(?:2e|e3%80%82|ef%bc%8e|ef%bd%a1)/i;
const ELLIPSIS_RE = /(?:\\?\.\\?\.|…|⋯)/u;
const AMBIGUOUS_OPENER_MAP = { '[': ']', '(': ')', '{': '}', '【': '】', '（': '）' };
const ATTACHED_OPEN_TAIL_RE = /(?:\\?([\[(\{【（]))((?:\\?\.|…|⋯)*)$/u;
const IS_TRAIL_CLOSER_RE = /^[\s"'>)\]}”’」』】》〉]$/u;

/**
 * Budgeted linear check for ambiguous truncation/abbreviation markers on an unresolved `//` token:
 * recognizes compact (`//M[...]`, `//M(…)`), spaced balanced (`//M[. . .]`, `//M[   ...]`, `//M . . .`),
 * arbitrarily padded whitespace within the shared `budget` (failing closed on budget exhaustion),
 * and effective EOF.
 */
function findAmbiguousTruncationEnd(str, offset, tokenEnd, budget) {
  const len = str.length;
  const tokenBody = str.slice(offset + 2, tokenEnd);
  const bumpStep = () => {
    if (budget && ++budget.scanSteps > budget.maxScanSteps) {
      budget.exhausted = true;
      return true;
    }
    return false;
  };

  // 1. Attached opener split by whitespace inside a balanced abbreviation marker (e.g. //M[. . .], //M[   ...], //M(… )).
  const openTail = ATTACHED_OPEN_TAIL_RE.exec(tokenBody);
  if (openTail) {
    const closeCh = AMBIGUOUS_OPENER_MAP[openTail[1]];
    let dots = 0;
    for (const ch of openTail[2]) {
      if (ch === '.') dots++;
      else if (ch === '…' || ch === '⋯') dots += 2;
    }
    let p = tokenEnd;
    while (p < len) {
      if (bumpStep()) return -1;
      const ch = str[p];
      if (ch === '\\' && p + 1 < len) {
        const next = str[p + 1];
        if (next === '.') { dots++; p += 2; continue; }
        if (next === closeCh) {
          if (dots >= 2) return p + 2;
          break;
        }
        break;
      }
      if (/\s/u.test(ch)) { p++; continue; }
      if (ch === '.') { dots++; p++; continue; }
      if (ch === '…' || ch === '⋯') { dots += 2; p++; continue; }
      if (ch === closeCh) {
        if (dots >= 2) return p + 1;
        break;
      }
      break;
    }
    if (p >= len) return len;
  }

  // 2. Attached compact ellipsis/abbreviation inside the scanned token (e.g. //M..., //M…, //M[...], //M[…], //M(…)).
  if (ELLIPSIS_RE.test(tokenBody)) return tokenEnd;

  // 3. Whitespace-separated lookahead within shared budget (no fixed short character window).
  let p = tokenEnd;
  while (p < len && /\s/u.test(str[p])) {
    if (bumpStep()) return -1;
    p++;
  }
  if (p >= len) return tokenEnd;

  // 3a. Effective EOF (only whitespace and closing quotes/brackets remain).
  let q = p;
  while (q < len && IS_TRAIL_CLOSER_RE.test(str[q])) {
    if (bumpStep()) return -1;
    q++;
  }
  if (q >= len) return tokenEnd;

  // 3b. Bare ellipsis or spaced dots after whitespace (... / … / . . . / attached '.' + ' .').
  if (str[p] === '…' || str[p] === '⋯') return tokenEnd;
  if (str[p] === '.' || (str[p] === '\\' && str[p + 1] === '.')) {
    let dots = tokenBody.endsWith('.') ? 1 : 0;
    let r = p;
    while (r < len) {
      if (bumpStep()) return -1;
      const ch = str[r];
      if (ch === '\\' && str[r + 1] === '.') { dots++; r += 2; continue; }
      if (ch === '.') { dots++; r++; continue; }
      if (ch === '…' || ch === '⋯') { dots += 2; r++; continue; }
      if (/\s/u.test(ch)) { r++; continue; }
      break;
    }
    if (dots >= 2) return tokenEnd;
  }

  // 3c. Whitespace-separated balanced abbreviation wrapper ([...], [. . .], [   ...], ( … ), { … }, 【…】, （…）).
  let openCh = str[p];
  let r = p + 1;
  if (openCh === '\\' && p + 1 < len && Object.hasOwn(AMBIGUOUS_OPENER_MAP, str[p + 1])) {
    openCh = str[p + 1];
    r = p + 2;
  }
  if (Object.hasOwn(AMBIGUOUS_OPENER_MAP, openCh)) {
    const closeCh = AMBIGUOUS_OPENER_MAP[openCh];
    let dots = 0;
    while (r < len) {
      if (bumpStep()) return -1;
      const ch = str[r];
      if (ch === '\\' && r + 1 < len) {
        const next = str[r + 1];
        if (next === '.') { dots++; r += 2; continue; }
        if (next === closeCh) {
          if (dots >= 2) return tokenEnd;
          break;
        }
        break;
      }
      if (/\s/u.test(ch)) { r++; continue; }
      if (ch === '.') { dots++; r++; continue; }
      if (ch === '…' || ch === '⋯') { dots += 2; r++; continue; }
      if (ch === closeCh) {
        if (dots >= 2) return tokenEnd;
        break;
      }
      break;
    }
    if (r >= len && dots > 0) return tokenEnd;
  }

  return -1;
}

function percentWhatwgDotLenAt(str, idx) {
  if (str.charCodeAt(idx) !== 0x25) return 0;
  if (idx + 3 <= str.length && str.charCodeAt(idx + 1) === 0x32 && (str.charCodeAt(idx + 2) | 32) === 0x65) return 3;
  if (idx + 9 <= str.length && str.charCodeAt(idx + 3) === 0x25 && str.charCodeAt(idx + 6) === 0x25) {
    const seq = str.slice(idx, idx + 9).toLowerCase();
    if (seq === '%e3%80%82' || seq === '%ef%bc%8e' || seq === '%ef%bd%a1') return 9;
  }
  return 0;
}

function whatwgDotLenAt(str, idx) {
  if (idx >= str.length) return 0;
  return isWhatwgDot(str.charCodeAt(idx)) ? 1 : percentWhatwgDotLenAt(str, idx);
}

function codePointAtInfo(str, idx) {
  const cp = str.codePointAt(idx);
  const width = cp > 0xffff ? 2 : 1;
  return { cp, width, ch: width === 2 ? str.slice(idx, idx + 2) : str[idx] };
}

function prevCodePointInfo(str, endIdx) {
  if (endIdx >= 2) {
    const lo = str.charCodeAt(endIdx - 1);
    const hi = str.charCodeAt(endIdx - 2);
    if (lo >= 0xdc00 && lo <= 0xdfff && hi >= 0xd800 && hi <= 0xdbff) {
      return { cp: str.codePointAt(endIdx - 2), width: 2, ch: str.slice(endIdx - 2, endIdx) };
    }
  }
  return { cp: str.charCodeAt(endIdx - 1), width: 1, ch: str[endIdx - 1] };
}

const isNonAsciiPunct = (cp, ch) => cp > 127 && UNICODE_PUNCT_RE.test(ch);
const isNonAsciiSymbol = (cp, ch) => cp > 127 && UNICODE_SYMBOL_RE.test(ch);
const isBareUrlStop = ch => !ch || /[\s<>"]/.test(ch);

function trimTrailingUrlPunct(str, start, end, openParens, closeParens, openBrackets, closeBrackets) {
  let j = end;
  while (j > start) {
    const { cp, width, ch: last } = prevCodePointInfo(str, j);
    // Consume contiguous trailing backslash runs in a single linear pass (prevents O(N^2) rescanning).
    if (width === 1 && last === '\\') {
      while (j > start && str[j - 1] === '\\') j--;
      continue;
    }
    const isCloseParen = width === 1 && last === ')';
    const isCloseBracket = width === 1 && last === ']';
    // Trim only prose/Markdown punctuation and unmatched wrappers — never strip Unicode symbols (\p{S}) that can end valid hostnames (e.g. www.☃).
    const isTrimmable = (isCloseParen && closeParens > openParens)
      || (isCloseBracket && closeBrackets > openBrackets)
      || (!isCloseParen && !isCloseBracket && (
        last === '\'' || last === '`' || last === '*' || last === '_' || last === '~'
        || last === '}' || last === '|' || last === '>'
        || last === '.' || last === ',' || last === ';' || last === ':' || last === '!' || last === '?' || isNonAsciiPunct(cp, last)
      ));
    if (!isTrimmable) break;
    let bs = 0;
    for (let b = j - width - 1; b >= start && str[b] === '\\'; b--) bs++;
    const step = (bs & 1) === 1 ? width + 1 : width;
    if (isCloseParen) closeParens--;
    else if (isCloseBracket) closeBrackets--;
    j -= step;
  }
  return j;
}

function isValidSchemeRelativeCandidate(rawCandidate, budget) {
  const normalized = rawCandidate.replace(/\\([\\`*_{}\[\]<>#!|~.\-+=])/g, '$1');
  if (normalized.length <= 2) return false;
  const rest = normalized.slice(2);
  if (!/[/?#:@.[\u3002\uff0e\uff61]/.test(rest) && !PERCENT_WHATWG_DOT_RE.test(rest)) return false;
  if (budget) {
    if (budget.urlChecks >= budget.maxUrlChecks) { budget.exhausted = true; return false; }
    budget.urlChecks++;
  }
  return URL.canParse(`https:${normalized}`);
}

function isValidBareWwwCandidate(rawCandidate, budget) {
  const normalized = rawCandidate.replace(/\\([\\`*_{}\[\]<>#!|~.\-+=])/g, '$1');
  if (normalized.length <= 4) return false;
  if (budget) {
    if (budget.urlChecks >= budget.maxUrlChecks) { budget.exhausted = true; return false; }
    budget.urlChecks++;
  }
  const parsed = URL.parse(`https://${normalized}`);
  return Boolean(parsed && ((parsed.hostname.startsWith('www.') && parsed.hostname.length > 4) || parsed.username || parsed.password));
}

function matchUrlStartAt(str, offset, identBeforeUnderscores = false, budget = null, failClosedTruncatedSchemeRelative = false) {
  const len = str.length;
  const prev = offset > 0 ? str.charCodeAt(offset - 1) : 0;
  const prevIsAlnum = (prev >= 48 && prev <= 57) || (prev >= 65 && prev <= 90) || (prev >= 97 && prev <= 122);
  const prevIsIdent = prevIsAlnum || (prev === 95 && identBeforeUnderscores);

  const c0 = str.charCodeAt(offset);
  if (!prevIsIdent && ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) {
    // 1. Any RFC 3986 scheme:// (http://, https://, ftp://, s3://, etc.) at exact original-string offset.
    let k = offset + 1;
    const maxSchemeEnd = Math.min(len - 3, offset + 24);
    while (k < maxSchemeEnd) {
      const ch = str.charCodeAt(k);
      if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57) || ch === 43 || ch === 45 || ch === 46) {
        k++;
        continue;
      }
      break;
    }
    if (k + 2 < len && str.charCodeAt(k) === 58 && str.charCodeAt(k + 1) === 47 && str.charCodeAt(k + 2) === 47) {
      return { prefixLen: (k + 3) - offset, minEnd: k + 3 };
    }
    // 2. Bare www.<host> URL using WHATWG dot separators (literal or percent-encoded ., 。, ．, ｡) and WHATWG URL host normalization.
    const wwwDotLen = offset + 3 < len ? whatwgDotLenAt(str, offset + 3) : 0;
    if (wwwDotLen > 0 && offset + 3 + wwwDotLen < len
      && (c0 | 32) === 119
      && (str.charCodeAt(offset + 1) | 32) === 119
      && (str.charCodeAt(offset + 2) | 32) === 119) {
      const wwwPrefixLen = 3 + wwwDotLen;
      let k = offset + wwwPrefixLen;
      const maxScan = Math.min(len, offset + 2048);
      let openParens = 0, closeParens = 0, openBrackets = 0, closeBrackets = 0;
      let inPath = false;
      let inBrackets = false;
      let atHostStart = -1;
      let seenPortColon = false;
      let portEndCut = false;
      let prevWasCut = false;
      let cutsOverflowed = false;
      const structuralCuts = [];
      const authorityCuts = [];
      const pushAuthCut = (bucket, cap, cut, balanced = false) => {
        if (bucket.length > 0 && bucket[bucket.length - 1].cut === cut) return;
        if (bucket.length < cap) {
          bucket.push(balanced
            ? { cut, openParens: 0, closeParens: 0, openBrackets: 0, closeBrackets: 0 }
            : { cut, openParens, closeParens, openBrackets, closeBrackets });
        } else {
          cutsOverflowed = true;
        }
      };
      while (k < maxScan && !isBareUrlStop(str[k])) {
        if (budget && ++budget.scanSteps > budget.maxScanSteps) { budget.exhausted = true; return null; }
        if (str[k] === '\\' && k + 1 < maxScan && !isBareUrlStop(str[k + 1])) {
          const esc = str[k + 1];
          const isIpv6Open = !inPath && esc === '[' && k === atHostStart;
          const isIpv6Close = !inPath && esc === ']' && inBrackets;
          const isEscWrapDelim = !isIpv6Open && !isIpv6Close && (
            (esc === ']' && closeBrackets >= openBrackets)
            || esc === '[' || esc === '(' || esc === '{' || esc === '}' || esc === '|'
            || esc === '!' || esc === '*' || esc === '_' || esc === '~' || esc === '`' || esc === '^'
          );
          if (!inPath && seenPortColon && !inBrackets && !portEndCut && esc !== '#') {
            portEndCut = true;
            pushAuthCut(structuralCuts, 16, k);
          }
          if (!inPath && isEscWrapDelim && !prevWasCut) pushAuthCut(authorityCuts, 64, k);
          if (esc === '[') { openBrackets++; if (isIpv6Open) inBrackets = true; }
          else if (esc === ']') { closeBrackets++; if (isIpv6Close) { inBrackets = false; pushAuthCut(structuralCuts, 16, k + 2, true); } }
          else if (esc === '(') openParens++;
          else if (esc === ')') closeParens++;
          else if (esc === '#') { inPath = true; inBrackets = false; }
          prevWasCut = isEscWrapDelim;
          k += 2;
          continue;
        }
        const { cp, width, ch } = codePointAtInfo(str, k);
        const isIpv6Open = !inPath && width === 1 && ch === '[' && k === atHostStart;
        const isIpv6Close = !inPath && width === 1 && ch === ']' && inBrackets;
        if (!inPath) {
          if (width === 1 && (ch === '/' || ch === '?' || ch === '#')) {
            inPath = true;
            inBrackets = false;
            prevWasCut = false;
          } else if (width === 1 && ch === '@') {
            atHostStart = k + 1;
            inBrackets = false;
            seenPortColon = false;
            portEndCut = false;
            prevWasCut = false;
          } else if (width === 1 && ch === ':') {
            if (!inBrackets) {
              if (!seenPortColon) seenPortColon = true;
              else if (!portEndCut) {
                portEndCut = true;
                pushAuthCut(structuralCuts, 16, k);
              }
            }
            prevWasCut = false;
          } else {
            if (seenPortColon && !inBrackets && !portEndCut && !(width === 1 && cp >= 48 && cp <= 57)) {
              portEndCut = true;
              pushAuthCut(structuralCuts, 16, k);
            }
            const pctDotLen = (!inBrackets && width === 1 && ch === '%') ? percentWhatwgDotLenAt(str, k) : 0;
            if (pctDotLen > 0) {
              prevWasCut = false;
              k += pctDotLen;
              continue;
            }
            const isAuthDelim = !isIpv6Open && !isIpv6Close && (isNonAsciiPunct(cp, ch) || (width === 1 && (
              ch === ',' || ch === ';' || ch === '!' || ch === '(' || ch === ')' || ch === '[' || ch === '{' || ch === '}'
              || ch === '|' || ch === '^' || ch === '%'
              || (ch === ']' && closeBrackets >= openBrackets)
              || ch === '\'' || ch === '`' || ch === '*' || ch === '_' || ch === '~'
            )));
            if (isAuthDelim) {
              if (!prevWasCut) pushAuthCut(authorityCuts, 64, k);
              prevWasCut = true;
            } else {
              prevWasCut = false;
            }
          }
        }
        if (width === 1) {
          if (ch === '(') openParens++;
          else if (ch === ')') closeParens++;
          else if (ch === '[') { openBrackets++; if (isIpv6Open) inBrackets = true; }
          else if (ch === ']') { closeBrackets++; if (isIpv6Close) { inBrackets = false; pushAuthCut(structuralCuts, 16, k + 1, true); } }
        }
        k += width;
      }
      const trimmedEnd = trimTrailingUrlPunct(str, offset + wwwPrefixLen, k, openParens, closeParens, openBrackets, closeBrackets);
      if (isValidBareWwwCandidate(str.slice(offset, trimmedEnd), budget)) return { prefixLen: wwwPrefixLen, minEnd: trimmedEnd };
      if (budget?.exhausted) return null;
      for (let s = structuralCuts.length - 1; s >= 0; s--) {
        const c = structuralCuts[s];
        if (c.cut <= offset + wwwPrefixLen) continue;
        const prefixEnd = trimTrailingUrlPunct(str, offset + wwwPrefixLen, c.cut, c.openParens, c.closeParens, c.openBrackets, c.closeBrackets);
        if (isValidBareWwwCandidate(str.slice(offset, prefixEnd), budget)) return { prefixLen: wwwPrefixLen, minEnd: prefixEnd };
        if (budget?.exhausted) return null;
      }
      for (const c of authorityCuts) {
        const prefixEnd = trimTrailingUrlPunct(str, offset + wwwPrefixLen, c.cut, c.openParens, c.closeParens, c.openBrackets, c.closeBrackets);
        if (isValidBareWwwCandidate(str.slice(offset, prefixEnd), budget)) return { prefixLen: wwwPrefixLen, minEnd: prefixEnd };
        if (budget?.exhausted) return null;
      }
      // Fail closed if an unresolved bare-www authority exceeds lookahead or cut-tracking capacity before terminating.
      if ((k >= maxScan && k < len && !isBareUrlStop(str[k])) || cutsOverflowed) return { prefixLen: wwwPrefixLen, minEnd: k };
    }
  }

  // 3. Scheme-relative //authority/... URL: allows leading '_' emphasis wrappers (_//user:pass@host:8080_),
  // recognizes literal & percent-encoded WHATWG dot separators and authority/port/IPv6/footnote boundaries,
  // reserves structural IPv6/port cuts independently of heuristic punctuation cuts, scans by full Unicode code point
  // within a shared global CPU/validation budget, snapshots per-cut bracket/paren counts,
  // and fails closed on truncated EOF fragments, lookahead caps, or cut-bucket overflow.
  if (!prevIsAlnum && offset + 3 < len && c0 === 47 && str.charCodeAt(offset + 1) === 47 && prev !== 58 && prev !== 47) {
    const next = str[offset + 2];
    if (next && next !== '/' && !isBareUrlStop(next)) {
      let k = offset + 2;
      const maxScan = Math.min(len, offset + 2048);
      let openParens = 0, closeParens = 0, openBrackets = 0, closeBrackets = 0;
      let seenUrlSignal = false;
      let seenAt = false;
      let atHostStart = offset + 2;
      let seenPath = false;
      let inBrackets = false;
      let seenPortColon = false;
      let hasNonPortAfterColon = false;
      let postAtPortColon = false;
      let postAtPortCut = false;
      let cutsOverflowed = false;
      // 0 = none, 1 = punctuation/wrapper delim, 2 = Unicode symbol (\p{S}) that may be either host char (☃) or adjacent prose marker (📌).
      let prevDelimKind = 0;
      const structuralCuts = [];
      const preAtCuts = [];
      const postAtCuts = [];
      const pushCut = (bucket, cap, cut, balanced = false) => {
        if (bucket.length > 0 && bucket[bucket.length - 1].cut === cut) return;
        if (bucket.length < cap) {
          bucket.push(balanced
            ? { cut, openParens: 0, closeParens: 0, openBrackets: 0, closeBrackets: 0 }
            : { cut, openParens, closeParens, openBrackets, closeBrackets });
        } else {
          cutsOverflowed = true;
        }
      };
      while (k < maxScan && !isBareUrlStop(str[k])) {
        if (budget && ++budget.scanSteps > budget.maxScanSteps) { budget.exhausted = true; return null; }
        if (str[k] === '\\' && k + 1 < maxScan && !isBareUrlStop(str[k + 1])) {
          const esc = str[k + 1];
          const isIpv6Open = !seenPath && esc === '[' && k === atHostStart;
          const isIpv6Close = !seenPath && esc === ']' && inBrackets;
          if (!seenPath && !inBrackets) {
            if (seenAt && postAtPortColon && !postAtPortCut && esc !== '#') {
              postAtPortCut = true;
              pushCut(structuralCuts, 16, k);
            } else if (!seenAt && seenPortColon && !hasNonPortAfterColon && esc !== '#') {
              pushCut(structuralCuts, 16, k);
              hasNonPortAfterColon = true;
            }
          }
          const isEscWrapDelim = !isIpv6Open && !isIpv6Close && (
            (esc === ']' && closeBrackets >= openBrackets)
            || (!seenPath && (esc === '[' || esc === '(' || esc === '{' || esc === '^'))
            || esc === '}' || esc === '|' || esc === '!' || esc === '*' || esc === '_' || esc === '~' || esc === '`'
          );
          if (isEscWrapDelim) {
            const couldBeComplete = seenUrlSignal && (seenAt || seenPath || !hasNonPortAfterColon);
            if (prevDelimKind !== 1 && couldBeComplete) pushCut(seenAt ? postAtCuts : preAtCuts, 64, k);
            if (esc === '[') openBrackets++;
            else if (esc === ']') { closeBrackets++; inBrackets = false; }
            else if (esc === '(') openParens++;
            else if (esc === ')') closeParens++;
            if (!seenAt && !seenPath && seenPortColon) hasNonPortAfterColon = true;
            prevDelimKind = 1;
          } else {
            if (isIpv6Open) { openBrackets++; inBrackets = true; seenUrlSignal = true; }
            else if (isIpv6Close) { closeBrackets++; inBrackets = false; pushCut(structuralCuts, 16, k + 2, true); }
            else if (esc === '[') openBrackets++;
            else if (esc === ']') closeBrackets++;
            else if (esc === '(') openParens++;
            else if (esc === ')') closeParens++;
            else if (esc === '#') { seenPath = true; seenUrlSignal = true; inBrackets = false; }
            else if (esc === '.') seenUrlSignal = true;
            prevDelimKind = 0;
          }
          k += 2;
          continue;
        }
        const { cp, width, ch } = codePointAtInfo(str, k);
        const isIpv6Open = !seenPath && width === 1 && ch === '[' && k === atHostStart;
        const isIpv6Close = !seenPath && width === 1 && ch === ']' && inBrackets;
        if (!seenPath && !inBrackets) {
          if (seenAt && postAtPortColon && !postAtPortCut
            && !(width === 1 && ((cp >= 48 && cp <= 57) || ch === '/' || ch === '?' || ch === '#'))) {
            postAtPortCut = true;
            pushCut(structuralCuts, 16, k);
          } else if (!seenAt && seenPortColon && !hasNonPortAfterColon
            && !(width === 1 && ((cp >= 48 && cp <= 57) || ch === '/' || ch === '?' || ch === '#' || ch === '@'))) {
            pushCut(structuralCuts, 16, k);
            hasNonPortAfterColon = true;
          }
        }
        const pctDotLen = (!seenPath && !inBrackets && width === 1 && ch === '%') ? percentWhatwgDotLenAt(str, k) : 0;
        if (pctDotLen > 0) {
          seenUrlSignal = true;
          if (!seenAt && seenPortColon) hasNonPortAfterColon = true;
          prevDelimKind = 0;
          k += pctDotLen;
          continue;
        }
        const isPunctDelim = !isIpv6Open && !isIpv6Close && (isNonAsciiPunct(cp, ch) || (width === 1 && (
          ch === ',' || ch === ';' || ch === '!' || ch === ')' || ch === '}' || ch === '|'
          || (ch === ']' && closeBrackets >= openBrackets)
          || (!seenPath && (ch === '[' || ch === '(' || ch === '{' || ch === '^' || ch === '%'))
          || ch === '\'' || ch === '`' || ch === '*' || ch === '_' || ch === '~'
        )));
        const isSymbolDelim = !isIpv6Open && !isIpv6Close && !isPunctDelim && isNonAsciiSymbol(cp, ch);
        if (isPunctDelim) {
          const couldBeComplete = seenUrlSignal && (seenAt || seenPath || !hasNonPortAfterColon);
          if (prevDelimKind !== 1 && couldBeComplete) pushCut(seenAt ? postAtCuts : preAtCuts, 64, k);
          if (isWhatwgDot(cp)) seenUrlSignal = true;
          if (width === 1) {
            if (ch === '(') openParens++;
            else if (ch === ')') closeParens++;
            else if (ch === '[') openBrackets++;
            else if (ch === ']') { closeBrackets++; inBrackets = false; }
          }
          if (!seenAt && !seenPath && seenPortColon) hasNonPortAfterColon = true;
          prevDelimKind = 1;
        } else if (isSymbolDelim) {
          const couldBeComplete = seenUrlSignal && (seenAt || seenPath || !hasNonPortAfterColon);
          if (prevDelimKind === 0 && couldBeComplete) pushCut(seenAt ? postAtCuts : preAtCuts, 64, k);
          if (!seenAt && !seenPath && seenPortColon) hasNonPortAfterColon = true;
          prevDelimKind = 2;
        } else {
          prevDelimKind = 0;
          if (width === 1) {
            if (ch === '@') { seenAt = true; seenUrlSignal = true; atHostStart = k + 1; inBrackets = false; postAtPortColon = false; postAtPortCut = false; }
            else if (ch === '/' || ch === '?' || ch === '#') { seenPath = true; seenUrlSignal = true; inBrackets = false; }
            else if (isIpv6Open) { openBrackets++; inBrackets = true; seenUrlSignal = true; }
            else if (isIpv6Close) { closeBrackets++; inBrackets = false; pushCut(structuralCuts, 16, k + 1, true); }
            else if (ch === '[') openBrackets++;
            else if (ch === ']') closeBrackets++;
            else if (ch === '(') openParens++;
            else if (ch === ')') closeParens++;
            else if (ch === '.') seenUrlSignal = true;
            else if (ch === ':') {
              seenUrlSignal = true;
              if (!inBrackets && !seenPath) {
                if (seenAt) {
                  if (!postAtPortColon) postAtPortColon = true;
                } else {
                  if (seenPortColon) hasNonPortAfterColon = true;
                  else seenPortColon = true;
                }
              }
            }
          }
        }
        k += width;
      }
      const trimmedEnd = trimTrailingUrlPunct(str, offset + 2, k, openParens, closeParens, openBrackets, closeBrackets);
      if (isValidSchemeRelativeCandidate(str.slice(offset, trimmedEnd), budget)) return { prefixLen: 2, minEnd: trimmedEnd };
      if (budget?.exhausted) return null;
      for (let s = structuralCuts.length - 1; s >= 0; s--) {
        const c = structuralCuts[s];
        const prefixEnd = trimTrailingUrlPunct(str, offset + 2, c.cut, c.openParens, c.closeParens, c.openBrackets, c.closeBrackets);
        if (isValidSchemeRelativeCandidate(str.slice(offset, prefixEnd), budget)) return { prefixLen: 2, minEnd: prefixEnd };
        if (budget?.exhausted) return null;
      }
      for (const c of postAtCuts) {
        const prefixEnd = trimTrailingUrlPunct(str, offset + 2, c.cut, c.openParens, c.closeParens, c.openBrackets, c.closeBrackets);
        if (isValidSchemeRelativeCandidate(str.slice(offset, prefixEnd), budget)) return { prefixLen: 2, minEnd: prefixEnd };
        if (budget?.exhausted) return null;
      }
      for (const c of preAtCuts) {
        const prefixEnd = trimTrailingUrlPunct(str, offset + 2, c.cut, c.openParens, c.closeParens, c.openBrackets, c.closeBrackets);
        if (isValidSchemeRelativeCandidate(str.slice(offset, prefixEnd), budget)) return { prefixLen: 2, minEnd: prefixEnd };
        if (budget?.exhausted) return null;
      }
      // Fail closed on any truncated credential-bearing (including digit-only numeric passwords) or unclosed-IPv6
      // authority fragment at EOF, OR any unresolved authority exceeding lookahead or cut-tracking capacity.
      if (k === len && (seenAt || inBrackets || seenPortColon || postAtPortColon)) return { prefixLen: 2, minEnd: k };
      if (failClosedTruncatedSchemeRelative) {
        const truncEnd = findAmbiguousTruncationEnd(str, offset, k, budget);
        if (budget?.exhausted) return null;
        if (truncEnd !== -1) return { prefixLen: 2, minEnd: truncEnd };
      }
      if ((k >= maxScan && k < len && !isBareUrlStop(str[k])) || cutsOverflowed) return { prefixLen: 2, minEnd: k };
    }
  }
  return null;
}

function scanAndFilter(noLinks, { budget, maxOutputChars = Infinity, failClosedTruncatedSchemeRelative = false, emit }) {
  let outLen = 0;
  let i = 0;
  const len = noLinks.length;
  let nextGt = noLinks.indexOf('>');
  let identBeforeUnderscores = false;
  while (i < len) {
    if (outLen >= maxOutputChars) break;
    if (++budget.scanSteps > budget.maxScanSteps) { budget.exhausted = true; break; }
    if (noLinks[i] === '<' && matchUrlStartAt(noLinks, i + 1, false, budget, failClosedTruncatedSchemeRelative)) {
      while (nextGt !== -1 && nextGt <= i) nextGt = noLinks.indexOf('>', nextGt + 1);
      if (nextGt !== -1) { i = nextGt + 1; identBeforeUnderscores = false; continue; }
    }
    if (budget.exhausted) break; // Fail closed: discard unprocessed remainder.
    const match = matchUrlStartAt(noLinks, i, identBeforeUnderscores, budget, failClosedTruncatedSchemeRelative);
    if (budget.exhausted) break; // Fail closed: discard unprocessed remainder.
    if (match) {
      let j = i + match.prefixLen;
      let openParens = 0, closeParens = 0, openBrackets = 0, closeBrackets = 0;
      // Consume the entire non-whitespace/non-angle/non-quote token by full code point, never trimming inside the validated span.
      while (j < len && !isBareUrlStop(noLinks[j])) {
        if (++budget.scanSteps > budget.maxScanSteps) { budget.exhausted = true; break; }
        if (noLinks[j] === '\\' && j + 1 < len && !isBareUrlStop(noLinks[j + 1])) {
          const esc = noLinks[j + 1];
          if (esc === '[') openBrackets++;
          else if (esc === ']') closeBrackets++;
          else if (esc === '(') openParens++;
          else if (esc === ')') closeParens++;
          j += 2;
          continue;
        }
        const { width, ch } = codePointAtInfo(noLinks, j);
        if (width === 1) {
          if (ch === '(') openParens++;
          else if (ch === ')') closeParens++;
          else if (ch === '[') openBrackets++;
          else if (ch === ']') closeBrackets++;
        }
        j += width;
      }
      if (budget.exhausted) break; // Fail closed: discard partially scanned URL and remainder.
      j = Math.max(match.minEnd, trimTrailingUrlPunct(noLinks, i, j, openParens, closeParens, openBrackets, closeBrackets));
      i = j;
      identBeforeUnderscores = false;
      continue;
    }
    const { width } = codePointAtInfo(noLinks, i);
    if (outLen + width > maxOutputChars) break;
    if (width === 2) {
      identBeforeUnderscores = false;
      emit(i, 2);
    } else {
      const code = noLinks.charCodeAt(i);
      if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
        identBeforeUnderscores = true;
      } else if (code !== 95 && code !== 92) {
        identBeforeUnderscores = false;
      }
      emit(i, 1);
    }
    outLen += width;
    i += width;
  }
}

export function stripPrivateUrls(text, {
  maxOutputChars = Infinity,
  maxUrlChecks = 256,
  maxScanSteps = 128_000,
  failClosedTruncatedSchemeRelative = false,
} = {}) {
  if (typeof text !== 'string' || !text) return text;
  const pass1 = stripBracketedLinksWithMap(text, true, 200_000);
  const pass2 = pass1.exhausted ? pass1 : stripBracketedLinksWithMap(pass1.text, false, 200_000);
  const noLinks = pass2.text;
  const budget = createRedactionBudget({ maxUrlChecks, maxScanSteps });
  let out = '';
  scanAndFilter(noLinks, {
    budget,
    maxOutputChars,
    failClosedTruncatedSchemeRelative,
    emit(idx, width) {
      out += width === 2 ? noLinks.slice(idx, idx + 2) : noLinks[idx];
    },
  });
  return out;
}

/**
 * Compute an exact character keep-mask (`Uint8Array` of 0/1) over `text` using a shared document budget,
 * so DOM-level redaction can remove URLs spanning inline tags (`<code>`, `<em>`, `<wbr>`, etc.) BEFORE rendering Markdown.
 */
export function redactPrivateTextMask(text, budget = createRedactionBudget(), {
  failClosedTruncatedSchemeRelative = false,
} = {}) {
  const kept = new Uint8Array(text.length);
  if (!text || budget.exhausted) return kept;
  const pass1 = stripBracketedLinksWithMap(text, true, 200_000, null, budget);
  const pass2 = pass1.exhausted ? pass1 : stripBracketedLinksWithMap(pass1.text, false, 200_000, pass1.map, budget);
  const { text: noLinks, map, exhausted: linkExhausted } = pass2;
  scanAndFilter(noLinks, {
    budget,
    failClosedTruncatedSchemeRelative,
    emit(idx, width) {
      if (map) {
        kept[map[idx]] = 1;
        if (width === 2) kept[map[idx + 1]] = 1;
      } else {
        kept[idx] = 1;
        if (width === 2) kept[idx + 1] = 1;
      }
    },
  });
  if (linkExhausted) budget.exhausted = true;
  return kept;
}
