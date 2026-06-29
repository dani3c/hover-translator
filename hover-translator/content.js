// =============================================================================
// Hover Translator — Content Script (content.js)
// =============================================================================

(function () {
  'use strict';

  let tooltip = null;
  let debounceTimer = null;
  let lastWord = null;
  let translateNonce = 0; // incremented on each translate call; response is discarded if nonce has changed
  let activeTranslateWord = null; // word currently being fetched; duplicate calls for same word are dropped
  const displayWordCache = new Map(); // word → displayWord (Map so entries for different words don't evict each other)
  let currentX = 0;
  let currentY = 0;
  let settings = { enabled: true, targetLang: 'es', hoverDelay: 400 };

  // ---------------------------------------------------------------------------
  // Init: load settings and start listening
  // ---------------------------------------------------------------------------
  async function init() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (response) settings = response;
    } catch {
      // Extension might not be ready yet
    }

    // Listen for settings changes (e.g. user toggles the extension)
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.settings) {
        settings = { ...settings, ...(changes.settings.newValue || {}) };
      }
    });

    // mousemove: track real-time cursor position, fire translation when cursor stops
    document.addEventListener('mousemove', onMouseMove, { passive: true });
    document.addEventListener('scroll', hideTooltip, { passive: true });
    document.addEventListener('keydown', hideTooltip, { passive: true });
  }

  // ---------------------------------------------------------------------------
  // Mouse events
  // ---------------------------------------------------------------------------
  function onMouseMove(e) {
    if (!settings.enabled) return;

    // Ignore movements inside the tooltip itself
    if (e.target && e.target.closest && e.target.closest('#hover-translator-tooltip')) return;

    currentX = e.clientX;
    currentY = e.clientY;

    // If cursor moved away from the current word, hide after short delay
    // (gives time to reach the tooltip before it disappears)
    if (lastWord && !isMouseOverTooltip) {
      const result = getWordAtPoint(currentX, currentY);
      if (!result || result.word !== lastWord) scheduleHide();
    }

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const result = getWordAtPoint(currentX, currentY);
      if (!result) return;
      if (result.word === lastWord) return;
      lastWord = result.word;
      translate(result.word, result.context, result.sentence, currentX, currentY);
    }, settings.hoverDelay || 400);
  }

  let isMouseOverTooltip = false;

  // ---------------------------------------------------------------------------
  // Word + context extraction
  // ---------------------------------------------------------------------------
  // Binary-search for the true character offset at (x, y) within a text node.
  // caretRangeFromPoint returns the wrong offset (always end-of-node) on elements
  // with user-select:none — a Chrome bug common on news sites. This bypasses it:
  // createRange().getClientRects() works correctly regardless of user-select.
  function charOffsetAt(node, text, x, y) {
    const len = text.length;
    if (len === 0) return 0;
    let lo = 0, hi = len;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const r = document.createRange();
      r.setStart(node, mid);
      r.setEnd(node, Math.min(mid + 1, len));
      // Find the rect on the same vertical line as the cursor
      let lineRect = null;
      for (const rect of r.getClientRects()) {
        if (y >= rect.top - 2 && y <= rect.bottom + 2) { lineRect = rect; break; }
      }
      if (!lineRect) {
        // Character not on cursor's line — decide direction by vertical position
        const rects = r.getClientRects();
        if (!rects.length) { hi = mid; continue; }
        if (rects[0].top > y + 2) hi = mid; else lo = mid + 1;
        continue;
      }
      // On the same line — use horizontal midpoint to decide left/right
      if (x < (lineRect.left + lineRect.right) / 2) hi = mid; else lo = mid + 1;
    }
    return Math.max(0, Math.min(lo, len - 1));
  }

  // Fallback text-node finder: when caretRangeFromPoint returns an element node
  // (happens on BBC and similar sites with complex DOM), walk the subtree under
  // elementFromPoint to find the text node whose visual rect contains (x, y).
  function findTextNodeAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    // Search the element and a few ancestors (wider net)
    let container = el;
    for (let depth = 0; depth < 5; depth++) {
      if (!container || container === document.documentElement) break;
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
      let tNode;
      while ((tNode = walker.nextNode())) {
        if (!tNode.textContent.trim()) continue;
        const r = document.createRange();
        r.selectNodeContents(tNode);
        for (const rect of r.getClientRects()) {
          if (x >= rect.left - 4 && x <= rect.right + 4 &&
              y >= rect.top - 4 && y <= rect.bottom + 4) {
            return tNode;
          }
        }
      }
      container = container.parentElement;
    }
    return null;
  }

  function getWordAtPoint(x, y) {
    try {
      const range = document.caretRangeFromPoint(x, y);

      // Resolve the text node: prefer caretRangeFromPoint result, but verify it is
      // visually at (x, y). caretRangeFromPoint can "snap" to a nearby text node
      // (e.g. the title above) when the element under the cursor has pointer-events
      // or user-select issues. Check the node's own getClientRects first.
      let node = range && range.startContainer;
      if (node && node.nodeType === Node.TEXT_NODE) {
        const nr = document.createRange();
        nr.selectNodeContents(node);
        let atPoint = false;
        for (const rect of nr.getClientRects()) {
          if (x >= rect.left - 10 && x <= rect.right + 10 &&
              y >= rect.top  - 10 && y <= rect.bottom + 10) { atPoint = true; break; }
        }
        if (!atPoint) node = null; // wrong node — fall through to DOM search
      }
      if (!node || node.nodeType !== Node.TEXT_NODE) {
        node = findTextNodeAt(x, y);
        if (!node) return null;
      }

      // Skip inputs/editable areas
      const parent = node.parentElement;
      if (!parent) return null;
      const tag = parent.tagName;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return null;
      if (parent.isContentEditable) return null;

      const text = node.textContent;
      // Use binary search to get the real offset (fixes user-select:none bug)
      let start = charOffsetAt(node, text, x, y);
      let end = start;

      // CJK character ranges (Japanese hiragana, katakana, kanji + Korean + Chinese)
      const cjkChar  = /[぀-ゟ゠-ヿ一-鿿㐀-䶿豈-﫿가-힯]/;
      const wordChar = /[\wÀ-ÿÁáÉéÍíÓóÚúÜüÑñÄäÖöÜüÀ-ɏ\u0600-\u06FF\u0750-\u077F]/;

      const charAtCursor = text[start] || '';

      if (cjkChar.test(charAtCursor)) {
        // ── CJK / Japanese / Korean path ──────────────────────────────────────
        // Japanese has no spaces between words. We expand by script type:
        //   • Katakana (ァ-ン): loanwords — keep expanding katakana chars
        //   • Kanji (一-鿿) + hiragana mix: compound words — up to 6 chars
        //   • Korean (가-힯): syllable blocks — words are typically 2-4 syllables
        // A cap prevents grabbing entire sentences.
        const isKorean   = /[가-힯]/.test(charAtCursor);
        const isKatakana = !isKorean && /[゠-ヿ]/.test(charAtCursor);
        const expandCJK  = isKatakana
          ? /[゠-ヿー]/ // katakana + prolonged sound mark ー
          : isKorean
            ? /[가-힯]/ // Korean syllable blocks only
            : /[぀-ゟ一-鿿㐀-䶿豈-﫿]/; // kanji + hiragana
        // maxLen: Chinese 1-2 chars, Japanese compound up to 6, Korean syllables up to 4.
        // Hiragana presence distinguishes Japanese from Chinese in mixed text.
        // Page lang="ja" fallback catches all-kanji headlines with no nearby hiragana.
        const nearbyText = text.substring(Math.max(0, start - 10), Math.min(text.length, start + 11));
        const hasHiragana = /[぀-ゟ]/.test(nearbyText);
        const isJapanesePage = (document.documentElement.lang || '').toLowerCase().startsWith('ja');
        const maxLen = isKatakana ? 12 : isKorean ? 4 : (hasHiragana || isJapanesePage ? 6 : 2);

        end = start + 1;
        while (end < text.length && (end - start) < maxLen && expandCJK.test(text[end])) end++;
        while (start > 0 && (end - start) < maxLen && expandCJK.test(text[start - 1])) start--;

        let word = text.substring(start, end);
        if (!word || !cjkChar.test(word[0])) return null;

        // Context: grab up to ~20 chars on each side for translation quality
        const ctxStart = Math.max(0, start - 20);
        const ctxEnd   = Math.min(text.length, end + 20);
        const context  = text.substring(ctxStart, ctxEnd).trim();

        return { word, context };
        // ───────────────────────────────────────────────────────────────────────
      }

      // ── Latin / European path (original logic) ─────────────────────────────
      // Expand left — include hyphens between word chars (e.g. "long-standing")
      while (start > 0) {
        if (wordChar.test(text[start - 1])) {
          start--;
        } else if (text[start - 1] === '-' && start > 1 && wordChar.test(text[start - 2])) {
          start--; // skip hyphen, next iteration picks up the word chars to the left
        } else {
          break;
        }
      }
      // Expand right — same logic
      while (end < text.length) {
        if (wordChar.test(text[end])) {
          end++;
        } else if (text[end] === '-' && end + 1 < text.length && wordChar.test(text[end + 1])) {
          end++; // skip hyphen, next iteration picks up the word chars to the right
        } else {
          break;
        }
      }

      let word = text.substring(start, end).trim();

      // Dotted abbreviation (U.S., U.K., e.g., i.e., D.C.) — must run BEFORE the length check.
      // When cursor lands on "U" in "U.S.", normal expansion stops at the dot (not a wordChar).
      // Detect the full form by expanding left/right through letter.letter. patterns.
      if (/^[a-zA-Z]{1,2}$/.test(word)) {
        let aStart = start, aEnd = end;
        // Scan right: dot + up to 3 letters, repeat
        while (aEnd < text.length && text[aEnd] === '.') {
          let segEnd = aEnd + 1;
          while (segEnd < text.length && /[a-zA-Z]/.test(text[segEnd]) && segEnd - aEnd <= 3) segEnd++;
          if (segEnd > aEnd + 1) { aEnd = segEnd; } else break;
        }
        if (aEnd < text.length && text[aEnd] === '.') aEnd++; // absorb trailing dot
        // Scan left: dot + up to 3 letters to the left, repeat
        while (aStart >= 2 && text[aStart - 1] === '.') {
          let segStart = aStart - 2;
          while (segStart > 0 && /[a-zA-Z]/.test(text[segStart - 1]) && aStart - 1 - segStart < 3) segStart--;
          if (segStart < aStart - 1) { aStart = segStart; } else break;
        }
        if (aStart < start || aEnd > end) {
          start = aStart; end = aEnd;
          word = text.substring(start, end).trim();
        }
      }

      if (!word || word.length < 2 || /^\d+$/.test(word) || /^[^a-zA-ZÀ-ÿ]+$/.test(word)) {
        return null;
      }
      // Reject bare possessive suffixes: a single ‘s’ or ‘d’ preceded by apostrophe
      // e.g. hovering on the "s" of "CNN’s" or "it’d"
      if (word.length === 1) return null;
      const charBefore = start > 0 ? text[start - 1] : "";
      // 0x27=’, 0x2018=’, 0x2019=’, 0x02BC=modifier apostrophe
      const isApostCode = (c) => { const n = c ? c.charCodeAt(0) : 0; return n === 0x27 || n === 0x2018 || n === 0x2019 || n === 0x02BC; };
      const cbCode = charBefore ? charBefore.charCodeAt(0) : 0;
      // Only closing/straight apostrophe (U+0027, U+2019, U+02BC) blocks short words.
      // Opening curly quote U+2018 is a quotation mark, NOT a possessive/contraction marker —
      // do NOT block words like "It" in 'It was surreal' or "We" in 'We the people'.
      const isApost = cbCode === 0x27 || cbCode === 0x2019 || cbCode === 0x02BC;
      if (isApost && word.length <= 2) return null;

      // ── Special expansions ──────────────────────────────────────────────────

      // 1. English contractions (right): don’t → nt, I’m → m, you’ve → ve
      //    bare suffixes without apostrophe, check after apostrophe char
      if (end < text.length && isApostCode(text[end])) {
        const bare = ["nt", "t", "m", "re", "ve", "ll", "d"];
        const rest = text.substring(end + 1, end + 4).toLowerCase();
        for (const b of bare) {
          if (rest.startsWith(b) && (end + 1 + b.length >= text.length || !wordChar.test(text[end + 1 + b.length]))) {
            end = end + 1 + b.length;
            word = text.substring(start, end).trim();
            break;
          }
        }
      }

      // 2. Romance prefix contractions (left): l’homme, d’accord, j’aime
      //    single letter + apostrophe immediately before the word
      if (start >= 2 && isApostCode(text[start - 1])) {
        const letterBefore = text[start - 2];
        const beforeLetter = start >= 3 ? text[start - 3] : "";
        if (wordChar.test(letterBefore) && !wordChar.test(beforeLetter)) {
          start -= 2;
          word = text.substring(start, end).trim();
        }
      }

      // 3. Capitalized multi-word proper nouns: New York, Donald Trump (max 3 words)
      // Skip when word has a Romance article/pronoun prefix (l', d', j'…) at index 1.
      // e.g. "L'AFFAIRE" is article+noun — expanding right would wrongly grab
      // following capitalized words like "JOSÉ LUIS" into the lookup term.
      const hasApostrophePrefix = word.length >= 3 &&
        (word.charCodeAt(1) === 0x27 || word.charCodeAt(1) === 0x2019 ||
         word.charCodeAt(1) === 0x2018 || word.charCodeAt(1) === 0x02BC);
      if (!hasApostrophePrefix && /^[A-Z\xC0-\xD6]/.test(word)) {
        let j = end;
        let extraWords = 0;
        while (j < text.length && extraWords < 2) {
          const spaceStart = j;
          while (j < text.length && text.charCodeAt(j) === 32) j++;
          if (j === spaceStart || j >= text.length) break;
          if (/^[A-Z\xC0-\xD6]/.test(text[j])) {
            const nwStart = j;
            while (j < text.length && wordChar.test(text[j])) j++;
            if (j - nwStart >= 2) {
              end = j;
              word = text.substring(start, end).trim();
              extraWords++;
            } else { break; }
          } else { break; }
        }
      }

      // 4. English phrasal verbs: give up, look into, take over
      if (!/^[A-Z\xC0-\xD6]/.test(word)) {
        const particles = ["up","down","in","out","off","on","over","away","back",
          "through","along","around","apart","forward","together","about",
          "across","after","ahead","onto","into"];
        let j = end;
        while (j < text.length && text.charCodeAt(j) === 32) j++;
        if (j > end && j < text.length) {
          const pStart = j;
          while (j < text.length && wordChar.test(text[j])) j++;
          const particle = text.substring(pStart, j).toLowerCase();
          if (particles.includes(particle)) {
            // Don't grab particle if followed by a capitalized word — that's a prepositional
            // phrase, not a phrasal verb. e.g. "tariff on European nations" → "on" + "E" → skip.
            // "give up hope" → "up" + "h" (lowercase) → grab.
            let afterP = j;
            while (afterP < text.length && text.charCodeAt(afterP) === 32) afterP++;
            const nextIsCapital = afterP < text.length && /^[A-Z\xC0-\xD6]/.test(text[afterP]);
            if (!nextIsCapital) {
              end = j;
              word = text.substring(start, end).trim();
            }
          }
        }
      }
      // ───────────────────────────────────────────────────────────────────────

      // Note: we skip both elementFromPoint() and getClientRects() visual checks here.
      // elementFromPoint() fails on sites with transparent overlay divs (Le Monde, BBC, paywalls).
      // getClientRects() was meant to prevent cross-line snapping but causes false negatives
      // when words are expanded (e.g. "Kylian" → "Kylian Mbappé") or inside link elements —
      // the expanded range rect doesn't always cover the original cursor position.
      // caretRangeFromPoint is precise enough on its own.

      // Extract surrounding context: up to 4 words on each side
      const context = extractContext(text, start, end, wordChar, 2);
      // For German separable verb detection we need the full sentence
      const sentence = extractSentenceForNode(node, word);

      return { word, context, sentence };
    } catch {
      return null;
    }
  }

  // Extract up to N words before and after the target word.
  // Stops at clause boundaries (comma, period, etc.) to avoid bleeding into adjacent phrases.
  function extractContext(text, wordStart, wordEnd, wordChar, radius = 2) {
    const clauseBreak = /[,\.;!?:()[\]"""]/;

    // Expand LEFT — stop at clause boundary or possessive boundary
    let i = wordStart - 1;
    let wordsLeft = 0;
    let leftBoundary = wordStart; // tracks start of the leftmost INCLUDED word
    const apostCode = (ch) => { const c = ch ? ch.charCodeAt(0) : 0; return c === 0x27 || c === 0x2018 || c === 0x2019 || c === 0x02BC; };
    while (i >= 0 && wordsLeft < radius) {
      if (clauseBreak.test(text[i])) break;
      if (!wordChar.test(text[i])) {
        i--;
      } else {
        // Scan to the beginning of this word
        while (i >= 0 && wordChar.test(text[i])) i--;
        // i now points to the char just before this word (i+1 = word start).
        // If what precedes this word is a possessive ("singer’s eye", "CNN’s Isa"),
        // the word belongs to that phrase — stop WITHOUT including it.
        let k = i;
        while (k >= 0 && text.charCodeAt(k) === 32) k--;
        if (k >= 0 && (apostCode(text[k]) || (k >= 1 && apostCode(text[k - 1])))) {
          break;
        }
        wordsLeft++;
        leftBoundary = i + 1; // leftmost included word starts here (updated each word)
      }
    }
    // ctxStart = start of the leftmost included left word (or wordStart if none)
    let ctxStart = leftBoundary;
    while (ctxStart < wordStart && !wordChar.test(text[ctxStart])) ctxStart++;

    // Expand RIGHT — stop at clause boundary
    let j = wordEnd;
    let wordsRight = 0;
    while (j < text.length && wordsRight < radius) {
      if (clauseBreak.test(text[j])) break;
      if (!wordChar.test(text[j])) {
        j++;
      } else {
        while (j < text.length && wordChar.test(text[j])) j++;
        wordsRight++;
      }
    }
    const ctxEnd = j;

    const ctx = text.substring(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim();
    // Only return context if it actually adds words beyond the target word itself
    return ctx.split(/\s+/).length > 1 ? ctx : null;
  }


  // Extract the sentence containing the hovered word from the nearest block-level ancestor.
  // Sentence boundaries are detected by sentence-ending punctuation (. ! ?).
  // Falls back to the full block text (up to 500 chars) if no boundaries are found.
  function extractSentenceForNode(textNode, word) {
    try {
      const blockTags = new Set(['P','H1','H2','H3','H4','H5','H6','LI','TD','TH',
        'BLOCKQUOTE','DIV','ARTICLE','SECTION','HEADER','FOOTER']);
      let el = textNode.parentElement;
      // Walk up until we hit a block-level element or body
      while (el && el !== document.body && !blockTags.has(el.tagName)) {
        el = el.parentElement;
      }
      if (!el || el === document.body) el = textNode.parentElement;
      const fullText = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!fullText) return null;

      // Find the sentence containing the hovered word by scanning for . ! ? boundaries.
      // A period is NOT a sentence boundary if:
      //   - preceded by a digit: German ordinals ("19. Februar", "3. Kapitel")
      //   - followed by a digit: dates/decimals ("19.02", "3.14")
      const isSentenceBoundary = (text, i) => {
        const ch = text[i];
        if (ch === '!' || ch === '?') return true;
        if (ch === '.') {
          if (i > 0 && /\d/.test(text[i - 1])) return false;   // ordinal/decimal
          if (i + 1 < text.length && /\d/.test(text[i + 1])) return false; // date
          return true;
        }
        return false;
      };

      if (word && word.length > 1) {
        const wordIdx = fullText.toLowerCase().indexOf(word.toLowerCase());
        if (wordIdx !== -1) {
          // Scan backward for the nearest sentence-ending punctuation
          let sentStart = 0;
          for (let i = wordIdx - 1; i >= 0; i--) {
            if (isSentenceBoundary(fullText, i)) {
              sentStart = i + 1;
              break;
            }
          }
          // Skip any leading whitespace after the boundary
          while (sentStart < wordIdx && /\s/.test(fullText[sentStart])) sentStart++;

          // Scan forward for the nearest sentence-ending punctuation
          let sentEnd = fullText.length;
          for (let i = wordIdx + word.length; i < fullText.length; i++) {
            if (isSentenceBoundary(fullText, i)) {
              sentEnd = i + 1;
              break;
            }
          }

          const sentence = fullText.slice(sentStart, sentEnd).trim();
          // Sanity check: the extracted sentence should contain the word
          if (sentence.toLowerCase().includes(word.toLowerCase())) {
            return sentence.substring(0, 500);
          }
        }
      }

      // Fallback: return full block text
      return fullText.substring(0, 500);
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Translation request
  // ---------------------------------------------------------------------------
  async function translate(word, context, sentence, x, y) {
    if (activeTranslateWord === word) return; // same word already in flight — let that request finish
    activeTranslateWord = word;
    const myNonce = ++translateNonce;
    // If we already resolved displayWord for this word, keep showing it during reload
    const knownDisplay = displayWordCache.get(word) || null;
    showTooltip(knownDisplay || word, null, x, y); // show loading state

    try {
      // Detect the page's declared language from the HTML lang attribute.
      // When the user has sourceLang = "auto", this gives MyMemory an explicit
      // source language (e.g. "sv") instead of guessing from a short word alone —
      // which fixes cases like "skjuten" (sv: shot) being misread as "photographed".
      const pageLang = (document.documentElement.lang || '').split('-')[0].toLowerCase() || null;

      const response = await chrome.runtime.sendMessage({
        type: 'TRANSLATE',
        word,
        context,                    // surrounding phrase for better accuracy
        sentence,                   // full sentence text (for German separable verbs)
        pageLang,                   // page's declared language (e.g. "sv", "fr")
        targetLang: settings.targetLang,
        apiUrl: settings.apiUrl,
        apiKey: settings.apiKey
      });

      if (myNonce !== translateNonce) {
        // Still cache the displayWord even though we discard this response —
        // the next translate() for the same word will benefit from the cache.
        if (response?.displayWord) displayWordCache.set(word, response.displayWord);
        activeTranslateWord = null;
        return;
      } // a newer translate() superseded this one
      if (!response) {
        activeTranslateWord = null;
        hideTooltip();
        return;
      }

      if (response.error === 'DISABLED') {
        hideTooltip();
        return;
      }

      if (response.error === 'LIMIT_REACHED') {
        showTooltip(word, null, x, y, 'limit');
        return;
      }

      if (response.error === 'API_ERROR') {
        showTooltip(word, '⚠ Error de conexión', x, y, 'error');
        return;
      }

      // An echoed context translation is not useful content when sameLanguage is detected
      const usableContext = response.contextTranslation && !response.sameLanguage;
      const hasContent = response.translation || response.definition || usableContext;
      // Use displayWord if background.js fell back to a shorter word (e.g. "Remember" from "Remember Ebola")
      // Prioritize response.displayWord (set by background.js) over the multi-word local expansion:
      // background.js knows better — for "Pablo Iglesias" it returns the full name,
      // for "Ausländerhass Südafrikas Wirtschaft" (no Wikipedia entry) it returns just "Ausländerhass".
      const displayWord = response.displayWord
        || displayWordCache.get(word)
        || (word.includes(' ') ? word : null)
        || word;
      if (/^pablo$/i.test(word) || /^iglesias$/i.test(word)) {
      }
      activeTranslateWord = null; // request finished — allow future requests for this word
      // Cache displayWord so loading state for the same word shows the full name immediately
      if (response.displayWord) displayWordCache.set(word, response.displayWord);
      if (hasContent) {
        showTooltip(displayWord, response.translation, x, y, 'ok', response);
      } else {
        showTooltip(displayWord, null, x, y, 'unknown', response);
      }
    } catch (err) {
      activeTranslateWord = null;
      // Extension context invalidated (e.g. after reload during dev).
      // Show a soft error so the user knows to reload the tab.
      if (err.message && err.message.includes('Extension context invalidated')) {
        showTooltip(word, '↻ Recarga la página (F5)', x, y, 'error');
      } else {
        hideTooltip();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Tooltip
  // ---------------------------------------------------------------------------
  function getTooltip() {
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.id = 'hover-translator-tooltip';
      tooltip.setAttribute('data-hover-translator', 'true');

      tooltip.addEventListener('mouseenter', () => { isMouseOverTooltip = true; });
      tooltip.addEventListener('mouseleave', () => {
        isMouseOverTooltip = false;
        scheduleHide(300);
      });

      document.documentElement.appendChild(tooltip);
    }
    return tooltip;
  }

  function showTooltip(word, translation, x, y, state = 'loading', meta = {}) {
    if (/^pablo$/i.test(word) || /^pablo iglesias$/i.test(word)) {
    }
    const el = getTooltip();

    el.className = 'hover-translator-tooltip';
    if (state !== 'ok') el.classList.add(`hover-translator--${state}`);

    if (state === 'loading') {
      el.innerHTML = `
        <div class="ht-header">
          <span class="ht-word">${escapeHtml(word)}</span>
        </div>
        <div class="ht-body">
          <span class="ht-spinner"></span>
        </div>
      `;
    } else if (state === 'limit') {
      el.innerHTML = `
        <div class="ht-header">
          <span class="ht-word">${escapeHtml(word)}</span>
        </div>
        <div class="ht-body ht-limit">
          <span>🔒 Daily limit reached</span>
          <span class="ht-limit-sub">100/100 words · <a href="#" class="ht-upgrade-link">Activate Premium</a></span>
        </div>
      `;
      el.querySelector('.ht-upgrade-link')?.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.runtime.sendMessage({ type: 'OPEN_POPUP' });
      });
    } else if (state === 'unknown') {
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(word)}`;
      const isSameLang = meta && meta.sameLanguage;
      el.innerHTML = `
        <div class="ht-header">
          <span class="ht-word">${escapeHtml(word)}</span>
        </div>
        <div class="ht-body ht-unknown">
          ${isSameLang
            ? `<span class="ht-same-lang-note">(this page is in your target language)</span>`
            : `<span>Not in database</span>`}
          <a href="${searchUrl}" target="_blank" class="ht-search-link">🔍 Search on Google</a>
        </div>
      `;
    } else if (state === 'error') {
      el.innerHTML = `
        <div class="ht-header">
          <span class="ht-word">${escapeHtml(word)}</span>
        </div>
        <div class="ht-body ht-error">
          <span>${escapeHtml(translation)}</span>
        </div>
      `;
    } else {
      // ok
      const { count, limit, isPremium, translatable, definition, contextPhrase, contextTranslation, sentenceTranslation = null, sentMinusTranslation = null, sentenceExtracted = null, sameLanguage, extractedTranslation, alternatives = [], posGroups = [], separableVerb = null, isGermanNoun = false, isGermanPage = false } = meta;

      // Premium users see nothing in the header — they already paid, no need to remind them.
      // Free users see their daily count so they know how many words remain.
      const usageHtml = isPremium
        ? ''
        : (count != null ? `<span class="ht-usage">${count}/${limit}</span>` : '');

      // ----- Display logic -----
      //
      // TRANSLATABLE words  (e.g. "showing"):
      //   PRIMARY   → word translation ("mostrando")
      //   SECONDARY → context, only when context disagrees with word translation
      //               ("mostrando sus" agrees → hide; "de toda una vida" disagrees → show)
      //
      // UNTRANSLATABLE words  (e.g. "shimmy"):
      //   PRIMARY   → dictionary definition
      //   SECONDARY → context phrase (how it's used in this sentence)

      let mainHtml;
      let secondaryHtml = '';

      if (translatable && translation) {
        // ── Translatable word ──
        // Prefer the chunk-extracted translation when available (GT maps source→target chunks,
        // giving context-aware results: "skjuten" → "disparada" instead of "disparo").
        // Chunk extraction is reliable — it's GT's own alignment, not positional guessing.
        // Only use it when it's ≤3 words (avoid showing full phrase snippets as word translation)
        // and differs from the isolated word translation.
        const chunkWords = extractedTranslation ? extractedTranslation.trim().split(/\s+/).length : 0;
        // Prefer the chunk when:
        //   • chunk gives MORE words than isolated (richer context: "hijo"→"del hijo"), OR
        //   • chunk matches a known dict alternative — meaning it's a valid translation for
        //     this specific context (e.g. "ett"→isolated:"a" but chunk:"un" is in dict alts)
        //     This avoids using random chunks (e.g. "conductores" for "att") that are NOT
        //     in the bilingual dictionary and therefore clearly wrong.
        //   • the extracted form is ≤3 words (no full-sentence snippets)
        //   • it actually differs from the isolated translation
        const isolatedWords = translation ? translation.trim().split(/\s+/).length : 0;
        const chunkTrimLower = extractedTranslation ? extractedTranslation.toLowerCase().trim() : '';
        const chunkMatchesDict = chunkTrimLower &&
          alternatives.some(a => a.toLowerCase() === chunkTrimLower);
        // When a separable verb is detected, don't rely on chunk extraction:
        // GT maps the split verb to a periphrasis (e.g. "greift...an" → "vuelve a atacar")
        // and the chunk for the finite form often aligns to the wrong word ("vuelve").
        // Use the separable verb's translation instead.
        const useChunk = !separableVerb && extractedTranslation &&
          (chunkWords > isolatedWords || chunkMatchesDict) &&
          chunkWords <= 3 &&
          chunkTrimLower !== translation.toLowerCase();
        // If the isolated translation appears verbatim in the sentence translation, the
        // sentence has confirmed it's contextually correct — don't let a 2-word chunk
        // (which may include prepositions like "con drones" for "Drohnen") override it.
        // Token-based check — \b regex fails on accented chars ("Moscú", "drones", etc.)
        const sentToksLow = sentenceTranslation
          ? (sentenceTranslation.toLowerCase().match(/[\wáéíóúüäöñàèìòùçßÀ-ɏ]+/g) || [])
          : [];
        // isoConfirmedBySentence: the isolated translation appears in the WITH-word sentence
        // but NOT in the WITHOUT-word sentence → it's genuinely there because of this word.
        // Without the sentMinus check, common verbs like "conseguir" produce false positives:
        // they appear in the WITH-word sentence translation by coincidence (e.g. from a nearby
        // "gewinnen wollte" clause), causing the wrong isolated translation to override sentenceExtracted.
        const sentMinusToksLow = sentMinusTranslation
          ? (sentMinusTranslation.toLowerCase().match(/[\wáéíóúüäöñàèìòùçßÀ-ɏ]+/g) || [])
          : [];
        // isoConfirmedBySentence: the isolated translation appears in the WITH-word sentence
        // AND either: (a) we have no minus sentence to compare against, but the translation
        // also disappears when the word is removed (confirmed by diff), OR (b) the minus
        // sentence doesn't contain it (so it only appears BECAUSE of this word).
        // When sentMinusTranslation is null, require extra confirmation via sentenceExtracted.
        const isoInSentence = !!(translation && sentToksLow.some(t => t === translation.toLowerCase().trim()));
        const isoInMinus = sentMinusToksLow.length > 0 && sentMinusToksLow.some(t => t === translation.toLowerCase().trim());
        // Confirmed only when: (appears in sentence) AND (minus is missing → trust only if no sentenceExtracted overrides it, OR minus is present but doesn't have it)
        const isoConfirmedBySentence = isoInSentence && !isoInMinus && sentMinusToksLow.length > 0;

        // Multi-word translations from the bilingual dict are specific and reliable — trust them.
        // e.g. "erneut" → "de nuevo" (pivot): don't override with sentence-diff "vuelve".
        const isMultiWordTranslation = !!(translation && translation.includes(' '));
        // Priority: separableVerb > iso-confirmed-by-sentence | multi-word → sentence-diff > chunk > iso
        // In German, capitalized words are ALWAYS nouns — if posGroups has noun translations,
        // use the first one directly, bypassing verb-biased priority chain entirely.
        const _nounGroups = posGroups.filter(g => /^noun|^sustantivo|^Substantiv/i.test(g.pos));
        const germanNounOverride = isGermanNoun && _nounGroups.length > 0
          ? _nounGroups[0].translations[0] : null;

        // German rule: lowercase words are NEVER nouns (German capitalizes ALL nouns).
        // Defined early — used in both displayTranslation and posGroups filtering below.
        const _isGermanLower = !isGermanNoun && isGermanPage &&
          word && word[0] === word[0].toLowerCase();

        const displayTranslation = germanNounOverride ||
          ((separableVerb?.translation && separableVerb.translation !== translation)
            ? separableVerb.translation
            : (isoConfirmedBySentence || isMultiWordTranslation
                ? translation
                : (sentenceExtracted && sentenceExtracted.toLowerCase() !== translation.toLowerCase()
                    // For German lowercase words (verbs/adj/adv), a multi-word sentenceExtracted
                    // is always a diff artefact (sentence restructuring), never the real translation.
                    // E.g. removing "kulturelle" leaves "se infraestructura" adjacent in the output
                    // but the correct translation is simply "cultural" from GT.
                    && (!_isGermanLower || !sentenceExtracted.includes(' '))
                    ? sentenceExtracted
                    : (useChunk && (!_isGermanLower || !extractedTranslation?.includes(' '))
                        ? extractedTranslation
                        : translation))));

        // Show word translation + alternatives.
        // When the bilingual dict returns ≥2 POS groups (verb + noun, verb + adj, etc.),
        // display each group on its own line with a small POS chip for clarity.
        // Otherwise fall back to the flat "primary / alt1 / alt2" format.
        // POS group display rules:
        //   • isGermanNoun   → noun groups only (word is always a noun if capitalized in German)
        //   • _isGermanLower → verb groups only (lowercase words can NEVER be nouns in German)
        //   • all others     → ALL groups shown, so the user sees every possible meaning
        const _activePosGroups = (_isGermanLower && posGroups.length > 0)
          ? posGroups.filter(g => !/^noun|^sustantivo|^Substantiv/i.test(g.pos))
          : posGroups;
        const verbPosGroups = _activePosGroups.filter(g => /^verb/i.test(g.pos));
        const nounPosGroups = _activePosGroups.filter(g => /^noun|^sustantivo|^Substantiv/i.test(g.pos));
        const displayPosGroups = isGermanNoun
          // Confirmed German noun → show noun groups only (never verb groups)
          ? (nounPosGroups.length > 0 ? nounPosGroups : _activePosGroups.filter(g => !/^verb/i.test(g.pos)) || _activePosGroups)
          : _isGermanLower
            // German lowercase (verb/adj/adv) → show verb groups only, suppressing any noun leak
            ? (verbPosGroups.length > 0 ? verbPosGroups : _activePosGroups)
            // Everything else → show ALL groups so the user sees all possible meanings
            : _activePosGroups;

        // When the sentence-diff algorithm has extracted a contextual translation
        // (e.g. 'quiere' for 'wolle'), displayTranslation === sentenceExtracted.
        // In that case, skip the posGroups template entirely — the extracted word
        // is more reliable than the dictionary groups (which may be noun-biased).
        const _sentenceOverride = !!sentenceExtracted &&
          sentenceExtracted.toLowerCase() !== translation.toLowerCase() &&
          displayTranslation === sentenceExtracted;

        let altsHtml;
        if (!_sentenceOverride && displayPosGroups.length >= 2) {
          const groupsHtml = displayPosGroups.map(({ pos, translations }) =>
            `<div class="ht-pos-group"><span class="ht-pos-label">${escapeHtml(pos)}</span> ${translations.map(escapeHtml).join(' \xb7 ')}</div>`
          ).join('');
          altsHtml = `<div class="ht-pos-groups">${groupsHtml}</div>`;
        } else if (!_sentenceOverride && displayPosGroups.length === 1) {
          // Single verb group: render inline (no group label needed if only one)
          const { translations } = displayPosGroups[0];
          altsHtml = translations.length > 1
            ? ` <span class="ht-alts">/ ${translations.slice(1).map(escapeHtml).join(' / ')}</span>`
            : '';
        } else {
          // Suppress alternatives when sentence-extracted translation overrides the word translation,
          // since those alts come from an unrelated word lookup.
          // For German lowercase words (verbs/adj), still show up to 2 alternatives so the user
          // can see multiple verb meanings (e.g. "besetzt" → ocupado / adornado).
          const _filteredAlts = _sentenceOverride ? [] : (_isGermanLower ? alternatives.slice(0, 2) : alternatives);
          altsHtml = _filteredAlts.length
            ? ` <span class="ht-alts">/ ${_filteredAlts.map(escapeHtml).join(' / ')}</span>`
            : '';
        }
        // Show word translation + all alternatives as primary, context as secondary.
        // The user can cross-reference the context sentence if the word translation
        // looks wrong (e.g. a CJK boundary fragment like "榜营" → "golpeando").
        mainHtml = (!_sentenceOverride && displayPosGroups.length >= 2)
          ? `<div class="ht-pos-groups-wrap">${altsHtml}</div>`
          : `<span class="ht-translation">${escapeHtml(displayTranslation)}${altsHtml}</span>`;
        // When a Wikipedia definition is also present (e.g. Anthropic → cognate "antrópico"
        // but also an AI company), show it below the translation for extra context.
        if (definition) {
          const defs = Array.isArray(definition) ? definition : [{ text: String(definition) }];
          const defText = defs[0]?.text ?? String(defs[0]);
          secondaryHtml = `<div class="ht-definition">${escapeHtml(defText)}</div>`;
        }
        {
          const displaySentence = sentenceTranslation || contextTranslation;
          if (displaySentence) {
            secondaryHtml += `<div class="ht-context">${escapeHtml(displaySentence)}</div>`;
          } else if (contextPhrase) {
            secondaryHtml += `<div class="ht-phrase-hint">« ${escapeHtml(contextPhrase)} »</div>`;
          }
        }
        if (separableVerb && separableVerb.infinitive && separableVerb.translation) {
          secondaryHtml += `<div class="ht-sep-verb">→ <em>${escapeHtml(separableVerb.infinitive)}</em>: ${escapeHtml(separableVerb.translation)}</div>`;
        }
      } else if (definition) {
        // ── Untranslatable word ──
        // When context translation is available, it reflects the ACTUAL usage in this
        // sentence — more reliable than a generic dictionary entry that might pick the
        // wrong sense (e.g. "media" → anatomical vs. social media).
        // Context is only useful when it doesn't just echo the word back
        // e.g. "to shimmy with" → "para hacer shimmy con" is useless for "shimmy"
        const ctxUseful = contextTranslation &&
          contextTranslation.trim().split(/\s+/).length <= 2 &&
          !new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i')
            .test(contextTranslation);

        if (ctxUseful) {
          // Context is reliable — show it as primary.
          // Do NOT show the English dictionary definition alongside it: it would be the
          // English meaning of the word (e.g. "premier" = Prime Minister) which is
          // irrelevant or wrong when the source text is another language (French "premier" = first).
          mainHtml = `<span class="ht-translation">${escapeHtml(contextTranslation)}</span>`;
          secondaryHtml = '';
          if (sentenceTranslation && sentenceTranslation !== contextTranslation) {
            secondaryHtml += `<div class="ht-context">${escapeHtml(sentenceTranslation)}</div>`;
          } else if (contextPhrase) {
            secondaryHtml += `<div class="ht-phrase-hint">« ${escapeHtml(contextPhrase)} »</div>`;
          }
        } else {
          // No context available: fall back to dictionary definition
          // definition is now an array [{text, pos}, ...] — one entry per POS
          const defs = Array.isArray(definition) ? definition : [definition];
          mainHtml = defs.map(d => {
            const posHtml = d.pos ? `<span class="ht-pos">${escapeHtml(d.pos)}</span> ` : '';
            return `<span class="ht-definition">${posHtml}${escapeHtml(d.text)}</span>`;
          }).join('<br>');
        }
      } else if (contextTranslation && contextTranslation.trim().split(/\s+/).length <= 2) {
        // ── No word translation and no definition: context is all we have ──
        // Only use if it's 1-2 words (a word translation), not a sentence fragment
        mainHtml = `<span class="ht-translation">${escapeHtml(contextTranslation)}</span>`;
      } else {
        mainHtml = `<span class="ht-no-translation">sin datos / no direct translation</span>`;
      }

      // Hint when text is already in the target language
      const sameLangHtml = sameLanguage
        ? `<div class="ht-same-lang">(this page is in your target language)</div>`
        : '';

      // If a separable verb was detected, show the full infinitive in the header
      const sepVerbLabel = (separableVerb && separableVerb.infinitive)
        ? ` <span class="ht-sep-infinitive">(${escapeHtml(separableVerb.infinitive)})</span>`
        : '';

      el.innerHTML = `
        <div class="ht-header">
          <span class="ht-word">${escapeHtml(word)}${sepVerbLabel}</span>
          ${usageHtml}
        </div>
        <div class="ht-body">
          ${mainHtml}
          ${secondaryHtml}
          ${sameLangHtml}
        </div>
      `;

    }

    // Position tooltip
    positionTooltip(el, x, y);
    el.classList.add('ht-visible');
  }

  let hideTimer = null;

  function scheduleHide(delay = 200) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!isMouseOverTooltip) hideTooltip();
    }, delay);
  }

  function hideTooltip() {
    clearTimeout(hideTimer);
    if (tooltip) {
      tooltip.classList.remove('ht-visible');
    }
    lastWord = null;
  }

  function positionTooltip(el, x, y) {
    el.style.visibility = 'hidden';
    el.style.display = 'block';

    const tooltipW = el.offsetWidth || 200;
    const tooltipH = el.offsetHeight || 60;
    const margin = 12;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = x + margin;
    let top = y + margin;

    // Flip horizontally if too close to right edge
    if (left + tooltipW > vw - margin) {
      left = x - tooltipW - margin;
    }
    // Flip vertically if too close to bottom edge
    if (top + tooltipH > vh - margin) {
      top = y - tooltipH - margin;
    }

    // Keep within viewport bounds
    left = Math.max(margin, Math.min(left, vw - tooltipW - margin));
    top  = Math.max(margin, Math.min(top,  vh - tooltipH - margin));

    el.style.left = `${left}px`;
    el.style.top  = `${top}px`;
    el.style.visibility = 'visible';
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------
  function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------
  init();
})();
