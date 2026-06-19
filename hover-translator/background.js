// =============================================================================
// Hover Translator — Service Worker (background.js)
// =============================================================================

const HMAC_SECRET = '4b3513210b5222f854582282135d18e17aa7fd6d4f997801414a4565069ef503';

const FREE_DAILY_LIMIT = 100;

// Cache version — bump this whenever extraction logic changes to invalidate stale entries.
const CACHE_VERSION = 90;

// Providers
const PROVIDER_MYMEMORY     = 'mymemory';
const PROVIDER_LIBRETRANSLATE = 'libretranslate';

// Languages where GT's direct path to Romance/other languages is weak but lang↔en/en↔es are strong.
// For these we pivot: word → English → target (phrase context still goes direct for chunk alignment).
const PIVOT_LANGS = new Set(['sv', 'da', 'no', 'nn', 'fi', 'is', 'et', 'lv', 'lt', 'nl', 'de', 'pl', 'ru']);

// ---------------------------------------------------------------------------
// German separable verb (Trennbare Verben) detection
// Separable verbs split across the clause: "bereitet...vor" -> vorbereiten
// ---------------------------------------------------------------------------
const GERMAN_SEP_PREFIXES = [
  // Longer compound particles (must come before shorter substrings)
  'zusammen', 'zurück',
  'vorwärts', 'vorüber', 'voraus',  'vorbei',  'voran',
  'hinunter', 'hinüber', 'hinauf',  'hinein',  'hinaus',  'hinab',
  'herunter', 'herüber', 'hervor',  'herauf',  'herein',  'heraus', 'herum', 'heran', 'herbei', 'herab',
  'weiter', 'wieder',
  // 5-char
  'bevor', 'durch', 'hinter', 'nieder', 'unter',
  // 4-char
  'über', 'fest', 'frei', 'fort', 'nach', 'statt', 'teil', 'wahr', 'preis',
  // 3-char
  'aus', 'auf', 'her', 'hin', 'los', 'mit', 'weg', 'vor',
  // 2-char (shortest last to avoid shadowing longer prefixes)
  'ab', 'an', 'bei', 'dar', 'ein', 'um', 'zu',
].sort((a, b) => b.length - a.length); // longest-first to avoid partial matches
// Common German separable verbs with known translations.
// Fast-path: if the reconstructed infinitive is in this table, skip GT and use the direct translation.
// Format: infinitive → { es: '...', en: '...' }  (add more langs as needed)
const GERMAN_SEP_VERB_TRANSLATIONS = {
  'abbiegen':          { es: 'girar/doblar',                    en: 'to turn' },
  'abfahren':          { es: 'partir/salir',                    en: 'to depart' },
  'abholen':           { es: 'recoger',                         en: 'to pick up' },
  'ablehnen':          { es: 'rechazar',                        en: 'to reject' },
  'abmachen':          { es: 'acordar',                         en: 'to agree' },
  'abnehmen':          { es: 'bajar/adelgazar',                 en: 'to decrease' },
  'absagen':           { es: 'cancelar',                        en: 'to cancel' },
  'abschließen':       { es: 'concluir/cerrar con llave',       en: 'to conclude' },
  'abstimmen':         { es: 'votar/coordinar',                 en: 'to vote' },
  'abwarten':          { es: 'esperar/aguardar',                en: 'to wait and see' },
  'anfangen':          { es: 'empezar/comenzar',                en: 'to begin' },
  'angreifen':         { es: 'atacar/agredir',                  en: 'to attack' },
  'anhalten':          { es: 'parar/detener',                   en: 'to stop' },
  'ankommen':          { es: 'llegar',                          en: 'to arrive' },
  'anmelden':          { es: 'registrarse/inscribirse',         en: 'to register' },
  'annehmen':          { es: 'aceptar/asumir',                  en: 'to accept' },
  'anpassen':          { es: 'adaptar',                         en: 'to adapt' },
  'anrufen':           { es: 'llamar por teléfono',             en: 'to call' },
  'ansehen':           { es: 'mirar/ver',                       en: 'to look at' },
  'anwenden':          { es: 'aplicar/usar',                    en: 'to apply' },
  'anziehen':          { es: 'ponerse/atraer',                  en: 'to put on' },
  'aufbauen':          { es: 'construir/desarrollar',           en: 'to build up' },
  'aufgeben':          { es: 'rendirse/abandonar',              en: 'to give up' },
  'aufhalten':         { es: 'detener/parar',                   en: 'to stop/hold up' },
  'aufhören':          { es: 'parar/dejar de',                  en: 'to stop' },
  'aufmachen':         { es: 'abrir',                           en: 'to open' },
  'aufnehmen':         { es: 'grabar/admitir',                  en: 'to record' },
  'aufräumen':         { es: 'ordenar/limpiar',                 en: 'to tidy up' },
  'aufschreiben':      { es: 'anotar/apuntar',                  en: 'to write down' },
  'aufstehen':         { es: 'levantarse',                      en: 'to get up' },
  'aufwachen':         { es: 'despertarse',                     en: 'to wake up' },
  'ausführen':         { es: 'ejecutar/llevar a cabo',          en: 'to carry out' },
  'ausgehen':          { es: 'salir',                           en: 'to go out' },
  'auslösen':          { es: 'desencadenar/provocar',           en: 'to trigger' },
  'ausmachen':         { es: 'apagar/acordar',                  en: 'to turn off' },
  'ausprobieren':      { es: 'probar/intentar',                 en: 'to try out' },
  'ausruhen':          { es: 'descansar',                       en: 'to rest' },
  'aussteigen':        { es: 'bajar (del transporte)',          en: 'to get off' },
  'auswählen':         { es: 'seleccionar/elegir',              en: 'to select' },
  'beitreten':         { es: 'unirse/adherirse',                en: 'to join' },
  'bevorstehen':       { es: 'avecinarse/ser inminente',        en: 'to be imminent' },
  'durchführen':       { es: 'llevar a cabo/realizar',          en: 'to carry out' },
  'einführen':         { es: 'introducir',                      en: 'to introduce' },
  'einkaufen':         { es: 'hacer compras/comprar',           en: 'to shop' },
  'einladen':          { es: 'invitar',                         en: 'to invite' },
  'einschlafen':       { es: 'dormirse/quedarse dormido',       en: 'to fall asleep' },
  'einsteigen':        { es: 'subir (al transporte)',           en: 'to board' },
  'fernsehen':         { es: 'ver la televisión',               en: 'to watch TV' },
  'feststellen':       { es: 'constatar/determinar',            en: 'to determine' },
  'fortsetzen':        { es: 'continuar/proseguir',             en: 'to continue' },
  'freigeben':         { es: 'liberar/publicar',                en: 'to release' },
  'herausfinden':      { es: 'averiguar/descubrir',             en: 'to find out' },
  'herausstellen':     { es: 'resultar/revelarse',              en: 'to turn out' },
  'herstellen':        { es: 'producir/fabricar',               en: 'to produce' },
  'hervorrufen':       { es: 'causar/provocar',                 en: 'to cause' },
  'hinweisen':         { es: 'señalar/indicar',                 en: 'to point out' },
  'hinzufügen':        { es: 'añadir/agregar',                  en: 'to add' },
  'losgehen':          { es: 'empezar/irse',                    en: 'to start' },
  'loslassen':         { es: 'soltar/dejar ir',                 en: 'to let go' },
  'mitbringen':        { es: 'traer',                           en: 'to bring along' },
  'mitmachen':         { es: 'participar/unirse',               en: 'to join in' },
  'mitnehmen':         { es: 'llevarse/llevar',                 en: 'to take along' },
  'mitteilen':         { es: 'comunicar/informar',              en: 'to inform' },
  'nachdenken':        { es: 'reflexionar/pensar',              en: 'to think about' },
  'nachgeben':         { es: 'ceder',                           en: 'to give in' },
  'nachweisen':        { es: 'demostrar/probar',                en: 'to prove' },
  'stattfinden':       { es: 'tener lugar/celebrarse',          en: 'to take place' },
  'teilnehmen':        { es: 'participar',                      en: 'to participate' },
  'übereinstimmen':    { es: 'coincidir/concordar',             en: 'to agree' },
  'übertreffen':       { es: 'superar/sobrepasar',              en: 'to surpass' },
  'umgehen':           { es: 'evitar/tratar con',               en: 'to deal with' },
  'umsetzen':          { es: 'implementar/convertir',           en: 'to implement' },
  'umsteigen':         { es: 'hacer transbordo/cambiar',        en: 'to transfer' },
  'vorantreiben':      { es: 'impulsar/promover',               en: 'to drive forward' },
  'vorhaben':          { es: 'tener previsto/planear',          en: 'to plan' },
  'vorlegen':          { es: 'presentar/mostrar',               en: 'to present' },
  'vornehmen':         { es: 'proponerse/emprender',            en: 'to undertake' },
  'vorschlagen':       { es: 'proponer/sugerir',                en: 'to suggest' },
  'vorsehen':          { es: 'prever/contemplar',               en: 'to plan' },
  'vorstellen':        { es: 'presentar/imaginar',              en: 'to introduce' },
  'wahrnehmen':        { es: 'percibir/aprovechar',             en: 'to perceive' },
  'weggehen':          { es: 'irse/marcharse',                  en: 'to go away' },
  'weitergehen':       { es: 'seguir/continuar',                en: 'to go on' },
  'weitermachen':      { es: 'continuar/seguir',                en: 'to continue' },
  'zuhören':           { es: 'escuchar',                        en: 'to listen' },
  'zumachen':          { es: 'cerrar',                          en: 'to close' },
  'zunehmen':          { es: 'aumentar/engordar',               en: 'to increase' },
  'zurückgehen':       { es: 'retroceder/remontarse',           en: 'to go back' },
  'zurückkehren':      { es: 'regresar/volver',                 en: 'to return' },
  'zurücklegen':       { es: 'recorrer/ahorrar',                en: 'to cover/save' },
  'zusammenarbeiten':  { es: 'colaborar/trabajar juntos',       en: 'to collaborate' },
  'zusammenbrechen':   { es: 'derrumbarse/colapsar',            en: 'to collapse' },
  'zusammenfassen':    { es: 'resumir',                         en: 'to summarize' },
  'zusammenkommen':    { es: 'reunirse/juntarse',               en: 'to come together' },
  'zustimmen':         { es: 'estar de acuerdo/aprobar',        en: 'to agree' },
};

function stripGermanVerbEnding(word) {
  // Try common 3rd-person present/past endings, longest first
  const endings = ['eten', 'etet', 'ete', 'est', 'et', 'en', 'e', 'st', 't'];
  const w = word.toLowerCase();
  for (const e of endings) {
    if (w.endsWith(e) && w.length - e.length >= 2) {
      return w.slice(0, w.length - e.length);
    }
  }
  return null;
}

async function findSeparableVerb(word, sentence, targetLang) {
  if (!sentence || !word) return null;

  // The sentence parameter is the full innerText of the block element and may contain
  // multiple sentences (e.g. "...statt. Spiele aus 48 Nationen werden daran teilnehmen.").
  // We need only the clause/sentence that contains the hovered word, because the separable
  // particle must be the LAST token of THAT clause — not of the whole block.
  // Split on ". "/"! "/"? " but NOT when a digit precedes "." (German ordinals: "19. Juli").
  const wordLower = word.toLowerCase();
  let clauseText = sentence;
  const sentenceParts = sentence.split(/(?<!\d)\.\s+|[!?]+\s+/);
  if (sentenceParts.length > 1) {
    const match = sentenceParts.find(p =>
      p.toLowerCase().split(/\s+/).some(t => t.replace(/[.,!?;:()\"\[\]]/g, '') === wordLower)
    );
    if (match) clauseText = match;
  }

  // Tokenize clause -- strip punctuation, lowercase
  const tokens = clauseText.trim()
    .split(/\s+/)
    .map(t => t.replace(/[.,!?;:()\"\[\]]/g, '').toLowerCase())
    .filter(Boolean);
  if (tokens.length < 2) return null;

  // The separable particle (Verbzusatz) must be the VERY LAST token of the clause.
  // German V2 word order: [Subject] [Finite-Verb] [...complement...] [Particle]
  // Checking "last 2 tokens" caused false positives when a preposition like "bei"
  // happened to appear second-to-last (e.g. "...Gewalt bei der Rekrutierung" truncated
  // to "...Gewalt bei" with "der Rekrutierung" cut off).
  const lastTok = tokens[tokens.length - 1];

  // Also keep the second-to-last ONLY if the last token is a common short qualifier
  // that can follow a particle ("nicht", "mehr", "noch", "auch", "immer").
  // In all other cases, the particle IS the last token.
  const PARTICLE_FOLLOWERS = new Set(['nicht', 'mehr', 'noch', 'auch', 'immer', 'wieder', 'schon']);
  const secondTok = PARTICLE_FOLLOWERS.has(lastTok) && tokens.length >= 2
    ? tokens[tokens.length - 2]
    : null;

  let foundPrefix = null;
  for (const prefix of GERMAN_SEP_PREFIXES) {
    if (lastTok === prefix) { foundPrefix = prefix; break; }
    if (secondTok === prefix) { foundPrefix = prefix; break; }
  }
  if (!foundPrefix) return null;

  // Extra guard: if the token IMMEDIATELY AFTER the found prefix in the original sentence
  // is a German article (der/die/das/dem/den/des/ein/eine/…), the prefix is a preposition,
  // not a separable particle. "bei der Rekrutierung" → "der" follows → preposition.
  {
    const GERMAN_ARTICLES = new Set([
      'der','die','das','dem','den','des',
      'ein','eine','einen','eines','einer','einem',
      'kein','keine','keinen','keines','keiner','keinem'
    ]);
    const prefixIdx = tokens.lastIndexOf(foundPrefix);
    const tokenAfter = prefixIdx >= 0 ? tokens[prefixIdx + 1] : undefined;
    if (tokenAfter && GERMAN_ARTICLES.has(tokenAfter)) return null;
  }

  // V2 position guard: in German main clauses, the finite verb is in position 2.
  // If there is already a lowercase word ending in 't' BEFORE the hovered word,
  // that word is the finite verb and the hovered word is an adverb/adjective, not a verb.
  // e.g. "Ukraine greift Moskau erneut...an": "greift" (lowercase, ends in 't') precedes
  // "erneut" → "erneut" is an adverb, skip separable-verb detection.
  // German nouns are ALWAYS capitalized, so a lowercase '-t'-ending word = conjugated verb.
  {
    const origTokens = clauseText.trim()
      .split(/\s+/)
      .map(t => t.replace(/[.,!?;:()\"\[\]]/g, ''))
      .filter(Boolean);
    const wordIdx = origTokens.findIndex(t => t.toLowerCase() === word.toLowerCase());
    if (wordIdx > 0) {
      const hasVerbBefore = origTokens.slice(0, wordIdx).some(t =>
        t.length >= 3 &&
        !/^[A-ZÄÖÜÀ-ÖØ-Þ]/.test(t) && // not a noun (capitalized)
        (
          // 3rd sg present: greift, steht, kommt…
          (t.endsWith('t') && t.slice(0, -1).length >= 2) ||
          // weak past plural: machten, spielten, arbeiteten…
          (t.endsWith('ten') && t.length >= 5) ||
          (t.endsWith('eten') && t.length >= 6)
        )
      );
      if (hasVerbBefore) return null;
    }
  }

  // Skip if the hovered word already starts with this prefix (not a split case)
  if (word.toLowerCase().startsWith(foundPrefix)) return null;

  // Extract stem by stripping conjugation ending
  const stem = stripGermanVerbEnding(word);
  if (!stem) return null;

  // Reconstruct the infinitive: prefix + stem + 'en'
  const infinitive = foundPrefix + stem + 'en';

  // Fast-path: if we have a known translation for this infinitive, skip GT entirely
  const knownVerb = GERMAN_SEP_VERB_TRANSLATIONS[infinitive];
  if (knownVerb) {
    const translation = knownVerb[targetLang] || knownVerb['en'];
    console.log('[HT-sep-dict]', infinitive, '→', translation);
    return { infinitive, translation };
  }

  // Validate by translating de→en first (German→English is strong for verbs).
  // Reject if: (a) GT echoes the infinitive (not a real word), or
  //            (b) GT's bilingual dict has no entry (posGroups empty = GT is guessing).
  // Real separable verbs like "angreifen", "vorbereiten" always have dict entries;
  // nonsense forms like "anerneuen" don't.
  let enResult;
  try {
    enResult = await callGoogleTranslate(infinitive, 'de', 'en', false);
  } catch {
    console.log('[HT-sep3] GT threw exception for', infinitive);
    return null;
  }
  if (!enResult?.text) return null;
  if (enResult.text.toLowerCase().trim() === infinitive.toLowerCase()) return null;
  // Guard against GT paraphrasing non-words: reject only when there is NO dict entry AND
  // the translation is multi-word (spaces = GT is parsing the compound literally, e.g.
  // "bevordrohnen" → "before threatening"). Single-word results like "bevorstehen" →
  // "impending" are reliable even without a bilingual dict entry.
  const noDict = (enResult.posGroups ?? []).length === 0 && (enResult.alternatives ?? []).length === 0;
  if (noDict && enResult.text.trim().includes(' ')) return null;

  // For the final translation, try the German infinitive directly → targetLang first.
  // This gives proper verb forms (e.g. "bevorstehen" de→es → "avecinarse"/"ser inminente")
  // instead of translating an English participial like "impending" → "inminente" (adjective).
  // Fall back to en→targetLang pivot if direct translation echoes or fails.
  let translation = enResult.text;
  if (targetLang !== 'en') {
    try {
      const directResult = await callGoogleTranslate(infinitive, 'de', targetLang, false);
      if (directResult?.text && directResult.text.toLowerCase().trim() !== infinitive.toLowerCase()) {
        translation = directResult.text;
      } else {
        // Fallback: pivot via English result
        const enWord = enResult.text.trim();
        const pivot = (enWord.indexOf(' ') === -1 && !enWord.startsWith('to ') && !enWord.endsWith('ing'))
          ? 'to ' + enWord
          : enWord;
        const tgtResult = await callGoogleTranslate(pivot, 'en', targetLang, false);
        if (tgtResult?.text) translation = tgtResult.text;
      }
    } catch { /* keep en result */ }
  }


  return { infinitive, translation };
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'TRANSLATE':
      handleTranslate(message.word, message.context, message.pageLang, message.sentence)
        .then(sendResponse)
        .catch(err => sendResponse({ error: err.message }));
      return true;

    case 'GET_USAGE':
      getDailyUsage().then(sendResponse);
      return true;

    case 'ACTIVATE_PREMIUM':
      activatePremium(message.key).then(sendResponse);
      return true;

    case 'GET_SETTINGS':
      getSettings().then(sendResponse);
      return true;

    case 'SAVE_SETTINGS':
      saveSettings(message.settings).then(sendResponse);
      return true;

    case 'TEST_CONNECTION':
      testConnection(message.provider, message.apiUrl, message.apiKey, message.email)
        .then(sendResponse);
      return true;
  }
});

// ---------------------------------------------------------------------------
// Translation entry point
// ---------------------------------------------------------------------------
async function handleTranslate(word, context, pageLang, sentence) {
  if (!word || word.length < 2) return { error: 'WORD_TOO_SHORT' };

  const settings = await getSettings();
  if (!settings.enabled) return { error: 'DISABLED' };

  // Cache key includes word + context. For German, also include the sentence
  // (the same conjugated form maps to different infinitives in different sentences).
  const isGerman = settings.sourceLang === 'de' || pageLang === 'de';
  const sentenceKey = isGerman ? `__${(sentence || '').substring(0, 50)}` : '';
  const cacheKey = `v${CACHE_VERSION}__${word.toLowerCase()}__${settings.targetLang}__${pageLang || 'auto'}__${(context || '').substring(0, 40)}${sentenceKey}`;
  const cached = await getCache(cacheKey);
  if (cached) return { ...cached, cached: true };

  // Check daily limit
  const { count, isPremium } = await getDailyUsage();
  if (!isPremium && count >= FREE_DAILY_LIMIT) {
    return { error: 'LIMIT_REACHED', count, limit: FREE_DAILY_LIMIT };
  }

  try {
    const result = await callProviderWithContext(word, context, settings, pageLang, sentence);

    await setCache(cacheKey, result);
    if (!isPremium) await incrementDailyCount();

    return { ...result, count: count + 1, limit: FREE_DAILY_LIMIT, isPremium };
  } catch (err) {
    return { error: 'API_ERROR', message: err.message };
  }
}

// ---------------------------------------------------------------------------
// Context-aware translation — parallel calls for speed
// ---------------------------------------------------------------------------
async function callProviderWithContext(word, context, settings, pageLang, sentence) {
  const provider = settings.provider || PROVIDER_MYMEMORY;
  const isPhrase = context && context.length > word.length;

  // When the user has sourceLang = "auto", use the page's declared HTML lang attribute
  // as an explicit source language. This dramatically improves quality for short or
  // ambiguous words (e.g. Swedish "skjuten" → "disparada" instead of "fotografiada").
  const sourceLang = (settings.sourceLang && settings.sourceLang !== 'auto')
    ? settings.sourceLang
    : (pageLang || 'auto');
  const targetLang = settings.targetLang || 'es';

  // Multi-word capitalized phrases in Title Case ("Lionel Messi", "Donald Trump", "New York")
  // are proper nouns assembled by content.js — translating them gives wrong results.
  // Exception: ALL-CAPS phrases ("JUST NU", "BREAKING NEWS") are headline labels, not names —
  // they must be translated normally.
  const isAllCaps = word === word.toUpperCase() && /[A-ZÀ-Ö]/.test(word);
  const isMultiWordProperNoun = word.includes(' ') &&
    word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase() &&
    !isAllCaps;
  if (isMultiWordProperNoun) {
    const definition = await lookupDefinition(word, targetLang, context);
    if (definition) {
      return {
        translation: null, alternatives: [], translatable: false, sameLanguage: false,
        definition,
        extractedTranslation: null,
        contextPhrase: context || null,
        contextTranslation: null,
        sentenceTranslation: null,
        sentenceExtracted: null
      };
    }
    // Wikipedia found nothing for the compound phrase — the assembly was likely wrong
    // (e.g. content.js grabbed "Remember Ebola" when only "Ebola" is the proper noun).
    // Fall back to translating the first word alone so common words like "Remember"
    // still produce a translation ("recordar") rather than "Not in database".
    // Include displayWord so content.js shows just "Remember" not "Remember Ebola".
    const firstWord = word.split(/\s+/)[0];
    const fallbackResult = await callProviderWithContext(firstWord, context, settings, pageLang);
    return { ...fallbackResult, displayWord: firstWord };
  }

  // ── Same-language early exit ────────────────────────────────────────────────
  // If the page language (from HTML lang attribute) matches the target language,
  // the content is already in the right language — no translation should be shown.
  // Exception: Title-Case proper nouns may still have a useful Wikipedia definition.
  {
    const normSrc = (sourceLang || '').split('-')[0].toLowerCase();
    const normTgt = (targetLang || '').split('-')[0].toLowerCase();
    if (normSrc && normSrc !== 'auto' && normSrc === normTgt) {
      // Try Wikipedia only in the target language — no English fallback.
      // If es.wikipedia doesn't have "escenarios", return null (not in database),
      // rather than jumping to en.wikipedia and showing an English definition.
      const lang = normTgt === 'en' ? 'en' : normTgt;
      const wikiResult = await fetchWikiSummary(word, lang)
        || (normTgt !== 'en' ? null : await fetchWikiSummary(word, 'en'));
      const definition = wikiResult ? [wikiResult] : null;
      return {
        translation: null, alternatives: [], translatable: false, sameLanguage: true,
        definition: definition || null,
        extractedTranslation: null,
        contextPhrase: context || null,
        contextTranslation: null,
        sentenceTranslation: null,
        sentenceExtracted: null
      };
    }
  }

  // Single all-caps word = acronym (GOP, FBI, NATO, etc.).
  // GT translates these phonetically, producing garbage (GOP → "gopo").
  // Try Wikipedia first; fall back to normal GT if Wikipedia has nothing.
  // Also matches dotted abbreviations: U.S., U.K., D.C. (letters alternating with dots)
  const isDottedAbbrev = /^[A-Za-z](\.[A-Za-z])+\.?$/.test(word);
  const isSingleAcronym = !word.includes(' ') && (
    (isAllCaps && /^[A-ZÀ-Ö]+$/.test(word) && word.length >= 3) || isDottedAbbrev
  );
  if (isSingleAcronym) {
    const acronymDef = await lookupDefinition(word, targetLang, context);
    if (acronymDef && acronymDef.length > 0) {
      return {
        translation: null, alternatives: [], translatable: false, sameLanguage: false,
        definition: acronymDef,
        extractedTranslation: null,
        contextPhrase: context || null,
        contextTranslation: null,
        sentenceTranslation: null,
        sentenceExtracted: null
      };
    }
    // No Wikipedia result — fall through to normal GT translation
  }

  // Normalize word to lowercase before sending to translation API.
  // Strip Romance article/pronoun apostrophe prefix so GT sees just the content word.
  // "l'ex-premier" → "ex-premier", "d'accord" → "accord", "j'aime" → "aime"
  // English I-contractions (I'm, I'd) use uppercase I so won't match the lowercase check.
  let wordForApi = word.toLowerCase();
  const _apostrophePrefixRe = /^([a-zà-ÿ]{1,2})['‘’](.+)$/;
  const _apostrophePrefixMatch = wordForApi.match(_apostrophePrefixRe);
  // prefixWasStripped: true when we stripped "l'", "d'", etc. from the word before sending to GT.
  // Needed because Signal B (length divergence) fires spuriously on these words: "l'enquête"→"enquête"
  // has srcLetters=7 but the Spanish translation "investigación" has 13 letters → 86% divergence
  // looks like a proper-noun transliteration but is a legitimate semantic translation.
  // Also, if GT echoes the stripped form we retry with the full form (the prefix gives GT context).
  const prefixWasStripped = !!(
    _apostrophePrefixMatch &&
    !isAllCaps &&  // ALL-CAPS words ("L'ENQUÊTE") keep prefix: avoids all-caps echo issues
    ['l','d','j','m','t','s','n','qu'].includes(_apostrophePrefixMatch[1])
    // Note: 'c' intentionally omitted — "c'est"→stripped "est" → GT sees "east"="este" not "is"="es"
  );
  if (prefixWasStripped) {
    wordForApi = _apostrophePrefixMatch[2];
  }

  // translate(text): Google Translate (free, no key) → MyMemory fallback.
  // LibreTranslate is used when the user has explicitly configured it.
  // For PIVOT_LANGS (Nordic/Baltic) translating to non-English, isolated words
  // go through English as a pivot (source→en→target) for much better quality.
  // The phrase context always goes direct (needed for sv→es chunk alignment).
  // Short words (≤3 chars) look like English words and confuse the sv→en step
  // (e.g. "har" sv→en = "hare" instead of "have"). Direct translation handles them fine.
  const usePivot = PIVOT_LANGS.has(sourceLang) && targetLang !== 'en' && wordForApi.length > 3;
  const translate = async (text, returnChunks = false) => {
    if (provider === PROVIDER_LIBRETRANSLATE) {
      return callLibreTranslate(text, sourceLang, targetLang, settings.apiUrl, settings.apiKey);
    }
    // Default: Google Translate (fast, no key) → MyMemory fallback
    try {
      if (usePivot && !returnChunks) {
        // Isolated word: pivot through English for better quality
        return await callGoogleTranslatePivot(text, sourceLang, targetLang);
      }
      const _gtResult = await callGoogleTranslate(text, sourceLang, targetLang, returnChunks);
      // When sourceLang was 'auto', GT tells us the detected language in detectedLang.
      // If that language is in PIVOT_LANGS (e.g. de) but pivot wasn't active (because
      // we only knew 'auto'), redo the call via pivot for much better quality.
      // Example: German page without lang="de" → GT auto-detects 'de' → pivot de→en→es.
      if (!usePivot && !returnChunks && _gtResult.detectedLang &&
          PIVOT_LANGS.has(_gtResult.detectedLang) && targetLang !== 'en' && text.length > 3) {
        return await callGoogleTranslatePivot(text, _gtResult.detectedLang, targetLang);
      }
      return _gtResult;
    } catch (e) {
      // If GT echoed the stripped form (e.g. GT treats "enquête" as a Spanish loanword),
      // retry with the full word including its Romance prefix ("l'enquête").
      // The prefix gives GT enough context to return a real translation ("la investigación").
      if (e.message === 'GT echoed input' && prefixWasStripped && text === wordForApi) {
        try {
          return await callGoogleTranslate(word.toLowerCase(), sourceLang, targetLang, returnChunks);
        } catch { /* fall through */ }
      }
      // If the direct call failed/echoed and this could be a PIVOT_LANG word (e.g. "Drohnen"
      // de→es echoes because GT misreads it as a verb), try pivot through English before
      // falling to MyMemory. This catches cases where the pivot check never ran.
      if (!usePivot && !returnChunks && targetLang !== 'en' && text.length > 3) {
        try {
          return await callGoogleTranslatePivot(text, sourceLang, targetLang);
        } catch { /* fall through to MyMemory */ }
      }
      void e;
      return callMyMemory(text, sourceLang, targetLang, settings.email);
    }
  };

  // Fire word, phrase and full-sentence translation in parallel.
  // For the phrase, request chunk alignment so we can extract the specific word's translation.
  // The sentence translation is shown below the tooltip so the user sees the full context.
  const sentenceForTranslation = sentence ? sentence.substring(0, 300) : null;
  // Build "sentence without the hovered word" — used for diff-based extraction (see below).
  const _sentLang = sourceLang === 'auto' ? 'auto' : sourceLang;
  const sentenceWithoutWord = sentenceForTranslation ? (() => {
    let removed = false;
    return sentenceForTranslation.split(/\s+/).filter(tok => {
      if (!removed && tok.replace(/[.,!?;:()"[\]]/g, '').toLowerCase() === word.toLowerCase()) {
        removed = true; return false;
      }
      return true;
    }).join(' ');
  })() : null;
  const [wordResult, phraseResult, sentenceResult, sentMinusResult] = await Promise.allSettled([
    translate(wordForApi),
    isPhrase ? translate(context, true) : Promise.resolve(null),
    sentenceForTranslation
      ? callGoogleTranslate(sentenceForTranslation, _sentLang, targetLang, true)
      : Promise.resolve(null),
    // Sentence-without-word (fires in parallel — no extra latency)
    sentenceWithoutWord && sentenceWithoutWord !== sentenceForTranslation
      ? callGoogleTranslate(sentenceWithoutWord, _sentLang, targetLang, false)
      : Promise.resolve(null)
  ]);

  // callMyMemory returns {text, alternatives}; callLibreTranslate returns a string.
  // Normalise both to a plain string for existing logic, and capture alternatives separately.
  const wordRawFull = wordResult.status === 'fulfilled' ? wordResult.value : null;
  let wordRaw       = wordRawFull?.text ?? wordRawFull ?? null;
  let wordAlts      = wordRawFull?.alternatives ?? [];
  let wordPosGroups = wordRawFull?.posGroups ?? [];

  // Supplement posGroups via English when the direct language pair gives < 2 POS groups.
  // GT bilingual dicts for non-English source pairs (fr→es, de→es, etc.) are weaker than
  // the source→en pair. So we pivot: source→en (rich POS dict) → translate each group
  // en→target to build the final posGroups.
  // Example: "été" fr→es data[1] = only [noun="verano"]; fr→en data[1] = [noun + verb]
  // → translate "been" en→es = "sido/estado" → verb posGroup added.
  // sourceLang may be 'auto' when the page has no lang attribute — that's fine,
  // GT auto-detects the language and still returns a bilingual dict for source→en.
  // The only case to skip is when sourceLang is explicitly 'en' (posGroups already
  // come from the en→es bilingual dict) or when usePivot handles it instead.
  if (wordPosGroups.length < 2 && wordRaw &&
      sourceLang !== 'en' &&
      targetLang && targetLang !== 'en' && !usePivot) {
    const supplemented = await supplementPosGroupsViaEn(wordForApi, sourceLang, targetLang);
    if (supplemented) {
      // Anchor check: only use the supplement if the direct translation (wordRaw) appears in one
      // of the supplemented groups. This prevents the supplement from overriding a correct direct
      // translation ("audiencia") with completely unrelated pivoted content ("casa", "audición"…).
      // "été": wordRaw="verano", supplement group 1 contains "verano" → accepted ✓
      // "Audience": wordRaw="audiencia", supplement has "casa"/"audición" → rejected ✓
      const directLower = (typeof wordRaw === 'string') ? wordRaw.toLowerCase() : null;
      const anchored = !directLower ||
        supplemented.some(g => g.translations.some(t => t.toLowerCase() === directLower));
      if (anchored) wordPosGroups = supplemented;
    }
  }

  const phraseRawFull = phraseResult.status === 'fulfilled' ? phraseResult.value : null;
  const phraseRaw     = phraseRawFull?.text ?? phraseRawFull ?? null;
  const phraseChunks  = phraseRawFull?.chunks ?? null;

  const sentenceRawFull  = sentenceResult.status === 'fulfilled' ? sentenceResult.value : null;
  const sentenceRaw      = sentenceRawFull?.text ?? sentenceRawFull ?? null;
  const sentenceChunks   = sentenceRawFull?.chunks ?? null;
  const sentMinusRawFull = sentMinusResult.status === 'fulfilled' ? sentMinusResult.value : null;
  const sentMinusRaw     = sentMinusRawFull?.text ?? sentMinusRawFull ?? null;

  // Sentence-context extraction — two-step strategy:
  //
  // Step 1: chunk alignment on the sentence (works when GT provides fine-grained chunks,
  //         rare for long sentences but free when available).
  //
  // Step 2: if the isolated word translation does NOT appear as a whole word in the
  //         sentence translation, the isolated reading is wrong for this context.
  //         Positional extraction from the sentence pair gives a better contextual form.
  //
  // Examples:
  //   "massiv" isolated → "masivo" (adj); not in "…masivamente…" → positional → "masivamente" ✓
  //   "Drohnen" isolated → "drones";    "drones" IS in sentence → sentenceExtracted = null,
  //                                      displayTranslation keeps "drones" ✓
  // ── Sentence-diff extraction ────────────────────────────────────────────────
  // Strategy: translate the sentence WITH and WITHOUT the hovered word, then diff.
  // Words that appear in the full translation but not in the minus-one translation
  // are the target-language equivalent of the hovered word.
  //   "massiv" removed → "masivamente" disappears from ES sentence → "masivamente" ✓
  //   "Drohnen" removed → "drones" disappears → "drones" ✓
  // This fires in parallel (no extra latency) and is more reliable than positional.
  let sentenceExtracted = sentenceChunks ? extractWordFromChunks(word, sentenceChunks) : null;
  // Reject multi-word sentenceExtracted (> 3 words): sentence-level chunk alignment can
  // return an entire clause (e.g. "Fluten" → "con inundaciones y sequías globales").
  // Single or 2-3 word results are reliable; longer results are almost always noise.
  if (sentenceExtracted && sentenceExtracted.trim().split(/\s+/).length > 3) {
    sentenceExtracted = null;
  }
  if (!sentenceExtracted && sentenceRaw && sentMinusRaw) {
    const _fullToks = new Set((sentenceRaw.toLowerCase().match(/[\wáéíóúüäöñàèìòùçßÀ-ɏ]+/g) || []));
    const _minusToks = new Set((sentMinusRaw.toLowerCase().match(/[\wáéíóúüäöñàèìòùçßÀ-ɏ]+/g) || []));
    const _unique = [..._fullToks].filter(t => !_minusToks.has(t) && t.length >= 3);
    // Only use when diff is small (< half of full tokens changed — larger diffs mean
    // GT restructured the whole sentence, making the diff meaningless).
    if (_unique.length === 1) {  // Only use diff when exactly 1 word disappears
      _unique.sort((a, b) => b.length - a.length); // longest = most specific
      // Use .find() so we skip candidates that equal wordRaw (e.g. "rugido" for Drohnen)
      // and pick the next best candidate ("drones") instead.
      const _cand = _unique.find(t => t !== word.toLowerCase() && t !== (wordRaw || '').toLowerCase());
      if (_cand) {
        sentenceExtracted = _cand;
      }
    }
  }

  // Word is "untranslatable" when the API echoes it back unchanged
  const wordSameAsInput = wordRaw && wordRaw.toLowerCase().trim() === wordForApi.trim();

  // Proper-noun detection — two independent signals, either triggers suppression:
  //
  // Signal A: word appears unchanged in the context translation (GT kept it as a name).
  //   Works when GT correctly preserves the name in sentence context but mis-translates
  //   it in isolation (less common with gtx endpoint).
  //
  // Signal B: translation has a divergent letter count (>25% longer or shorter than source).
  //   Transliterations keep length: Police(6)→policía(7)=17% OK, France(6)→Francia(7)=17% OK.
  //   Semantic translations diverge: Trump(5)→Triunfo(7)=40% ✗, Lionel(6)→León(4)=33% ✗.
  //   Threshold 25% avoids false positives like Government(10)→Gobierno(8)=20%.
  const isCapitalized = word.length >= 3 &&
    word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase();

  // Signal A
  const wordAppearsInContext = isCapitalized && phraseRaw &&
    new RegExp(`(?:^|[^\\wÀ-ɏ])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^\\wÀ-ɏ]|$)`, 'i')
      .test(phraseRaw);

  // Signal B
  // Use wordForApi (apostrophe prefix already stripped, e.g. "enquête" not "L'ENQUÊTE")
  // so the letter count reflects what was actually sent to GT.
  const srcLetters = wordForApi.replace(/[^a-zA-ZÀ-ɏ]/g, '').length;
  const tgtLetters = wordRaw ? wordRaw.replace(/[^a-zA-ZÀ-ɏ]/g, '').length : 0;
  const lengthDivergence = srcLetters > 0 ? Math.abs(tgtLetters - srcLetters) / srcLetters : 0;
  // Signal B only applies to single words — multi-word phrases naturally diverge in length
  // because the grammar of the target language can change phrase structure significantly.
  // Also requires ≥5 source letters: short words (HAR=3, BRA=3) produce high divergence
  // just from different word lengths in the target, not because they're proper nouns.
  // Short proper nouns (KIM, MAO) are already caught by wordSameAsInput (Signal A).
  // SKIP for English source pages — English→Romance translations legitimately diverge
  // (behold→contemplar=67%, freedom→libertad=40%) and Signal A alone is sufficient there.
  // SKIP for all-caps words — they are headline labels (L'ENQUÊTE, BREAKING), not proper nouns;
  // legitimate semantic translations (enquête→investigación) diverge in length normally.
  // SKIP for prefix-stripped words — stripping "l'" from "l'enquête" gives srcLetters=7,
  // but the Spanish translation "investigación" has 13 letters → 86% divergence, which is
  // a false positive: it's a real semantic translation, not a proper-noun transliteration.
  const isEnglishSource = sourceLang === 'en' || (!sourceLang || sourceLang === 'auto') && (pageLang === 'en' || pageLang === 'en-US' || pageLang === 'en-GB');
  // Words with distinctly German morphological suffixes (-ung, -heit, -keit, etc.) are
  // always common nouns — never proper nouns — regardless of page lang attribute.
  // Exempt them from hasDivergentTranslation suppression so "Abkühlung"→"enfriamiento"
  // (33% divergence) isn't incorrectly treated as a transliterated proper noun.
  const hasDistinctGermanNounSuffix = /(?:ung|heit|keit|schaft|tum(?:s)?|nis(?:se)?|ling(?:e)?|sal)$/i.test(word);
  // SKIP on German/Nordic pivot pages: in German, ALL nouns are capitalized, so high
  // length divergence (e.g. "Fluten"→"inundaciones" = 100%, "Kinder"→"niños") is normal
  // for common nouns and not a sign of a proper noun. Signal A (wordAppearsInContext)
  // is the reliable proper-noun detector for these pages.
  const hasDivergentTranslation = isCapitalized && !isEnglishSource && !isAllCaps && !prefixWasStripped && wordRaw && lengthDivergence > 0.25 &&
    !word.includes(' ') && srcLetters >= 5 && !hasDistinctGermanNounSuffix && !usePivot;

  // Signal C (multi-word only): all words of the translation start with uppercase →
  // GT transliterated/adapted a proper noun rather than genuinely translating it.
  // "Lionel Messi" → "León Messi"  (both capped = still a name)    → suppress ✓
  // "just nu"      → "ahora mismo" (both lower = real translation)  → keep ✓
  // "New York"     → "Nueva York"  (both capped = proper noun)      → suppress ✓
  const translationIsAllCaps = isCapitalized && word.includes(' ') && wordRaw &&
    wordRaw.trim().split(/\s+/).every(w => w.length > 0 && w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase());

  // Suppress isolated translation when proper-noun signals fire.
  // ALL-CAPS non-acronym words (e.g. L'ENQUÊTE) are headline labels — skip ALL suppression:
  // their capitalization is presentational, not a sign of a proper noun.
  //
  // Exception: if the translation appears verbatim in the phrase translation, it's confirmed
  // correct by context — don't suppress even when letter count diverges.
  // e.g. "Russland"→"Rusia": 37% divergence would normally suppress, but "Rusia" IS in
  // "Toda Rusia tiene una crisis..." → confirmed → keep.
  // "Deutschland"→"Alemania" (27% divergence) is also rescued this way.
  const translationConfirmedByPhrase = !!(wordRaw && phraseRaw &&
    new RegExp(
      `(?:^|[^\\wÀ-ɏ])${wordRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^\\wÀ-ɏ]|$)`,
      'i'
    ).test(phraseRaw));

  const properNounSuppression = !isAllCaps && !translationConfirmedByPhrase && (
    wordSameAsInput ||
    ((wordAppearsInContext || hasDivergentTranslation || translationIsAllCaps) && wordRaw && wordRaw.toLowerCase() !== wordForApi)
  );
  const wordTranslation = (!wordRaw || properNounSuppression) ? null : wordRaw;

  // Detect "same language" — word echoes AND (no context OR context also echoes).
  // Distinguishes from proper nouns (e.g. "Daniel"): a name echoes but its
  // surrounding context WOULD translate differently, so phraseEchoed = false.
  const phraseEchoed = phraseRaw && context &&
    phraseRaw.replace(/\s+/g, ' ').trim().toLowerCase() ===
    context.replace(/\s+/g, ' ').trim().toLowerCase();
  // ALL-CAPS words (headers, emphasis) in the same language may get normalized by GT
  // (e.g. "NECESIDADES" → "necesidad"), making wordSameAsInput false even though the
  // page is already in the target language. Use phrase-echo as same-language fallback.
  const sameLanguageAllCaps = isAllCaps && !!(phraseRaw && context &&
    phraseRaw.replace(/\s+/g, ' ').trim().toLowerCase() ===
    context.replace(/\s+/g, ' ').trim().toLowerCase());
  const sameLanguage = !!(
    (wordSameAsInput && (!phraseRaw || phraseEchoed)) ||
    sameLanguageAllCaps
  );

  // Extract the word's specific translation from GT's chunk alignment.
  // GT returns [[translated_part, source_part], ...] — much more reliable than
  // positional alignment because GT itself provides the word-level mapping.
  // Chunk extraction always uses the DIRECT phrase translation (never pivoted), so
  // it's independent of any pivot error in the isolated word step.
  const extractedFromChunks = extractWordFromChunks(word, phraseChunks);
  const extractedTranslation = extractedFromChunks
    || (usePivot ? null : extractWordFromContext(word, context, phraseRaw)); // positional fallback only for non-pivot

  // Pivot validation: the phrase is always translated DIRECTLY (sv→es), so phraseRaw
  // reflects the true meaning in context. If the pivot result (isolated word) doesn't
  // appear in that direct translation, the pivot likely got a wrong word sense
  // (e.g. "sköt" sv→en="sheet" instead of "shot" → en→es="hoja").
  // In that case, fall back to the phrase-derived extraction (chunk alignment first,
  // positional alignment as secondary), which comes from the correct direct translation.
  // Note: extractWordFromContext is only used here for pivot validation — NOT returned as
  // extractedTranslation (which would let content.js re-override the corrected result).
  let finalWordTranslation = wordTranslation;
  // Pivot validation: the context phrase is translated DIRECTLY (de→es, no pivot), so
  // phraseRaw reflects the true contextual meaning. If the pivot result doesn't appear
  // there (nor any of its synonyms), the pivot likely got a wrong word sense and we
  // fall back to the chunk extraction from the direct translation.
  // SKIP when the pivot result is multi-word — truncated context phrases (radius=2 words)
  // can omit critical particles (e.g. "an" in "angreifen"), producing a wrong phraseRaw.
  // Multi-word results like "de nuevo" are already specific and reliable without validation.
  // NOTE: extractWordFromContext (positional alignment) is intentionally NOT used here
  // because German word order changes radically in translation (inverted questions, V2 order),
  // making positional mapping unreliable (e.g. "ganz" pos=1 → "Rusia" pos=1 in translation).
  if (usePivot && wordTranslation && phraseRaw && !wordTranslation.includes(' ')) {
    // Check whether the pivot result (or any alt) appears in the direct phrase translation.
    // Use stem match to handle Spanish gender/number: "todo"↔"toda", "nueva"↔"nuevo", etc.
    const wordsToCheck = [wordTranslation, ...wordAlts].filter(w => w && w.length >= 3);
    const pivotInPhrase = wordsToCheck.some(w => {
      const stem = w.length >= 4 ? w.slice(0, -1) : w;
      return new RegExp(
        `(?:^|[^\wÀ-ɏ])${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\wÀ-ɏ]*(?:[^\wÀ-ɏ]|$)`,
        'i'
      ).test(phraseRaw);
    });
    if (!pivotInPhrase) {
      // Pivot result absent from direct phrase translation → wrong word sense detected.
      // Clear posGroups + alts: they came from the same wrong bilingual dict entry
      // (e.g. "verließen" de→en="left" → posGroups show izquierda/adj/adv but no verb).
      wordPosGroups = [];
      wordAlts = [];
      // Cap to ≤3 words: chunk alignment can occasionally map a word to an entire clause
      // (e.g. "Fluten" → "con inundaciones y sequías globales"). Single/short extractions OK.
      const pivotCandidate = (extractedFromChunks && extractedFromChunks.trim().split(/\s+/).length <= 3)
        ? extractedFromChunks : null;  // chunk-aligned only; no positional fallback
      if (pivotCandidate) {
        finalWordTranslation = pivotCandidate;
      } else {
        // No chunk extraction → try direct sourceLang→targetLang as last resort
        // (e.g. "verließen" de→es directly may give "abandonaron" even though pivot gave wrong "left")
        try {
          const directResult = await callGoogleTranslate(word, sourceLang, targetLang, false);
          if (directResult?.text && directResult.text.toLowerCase().trim() !== word.toLowerCase()) {
            finalWordTranslation = directResult.text;
            wordPosGroups = directResult.posGroups ?? [];
            wordAlts = directResult.alternatives ?? [];
          }
        } catch { /* keep wordTranslation */ }
      }
    }
  }

  // False-cognate fix: when the isolated translation echoes the source word but it's NOT
  // the same language (e.g. "de" sv="they" echoes to "de" es="of"), the bilingual dict
  // alternatives contain the real translations. Use them instead of showing nothing.
  // We prefer context extraction (phrase-derived) as the primary translation when available,
  // since it reflects the actual usage in the sentence.
  let effectiveAlts = [...wordAlts];

  // Context-chunk correction: for function words, dt=at gives multiple valid translations
  // (e.g. "att" → primary "a", alts ["que","para"]) but the RIGHT one depends on context.
  // If the phrase chunk gives a translation that's in our alternatives list, promote it to
  // primary and push the old primary into alternatives.
  // e.g. "jag tror att det" → chunk "que" → promote "que", alts become ["a","para"] ✓
  // Also handles case with no alts: chunk gives first/only translation for function words.
  if (!usePivot && extractedFromChunks && finalWordTranslation) {
    const chunkLower = extractedFromChunks.toLowerCase().trim();
    const chunkLetters = extractedFromChunks.replace(/[^a-zA-ZÀ-ɏ]/g, '').length;
    // Guard: skip chunk refinement when the isolated translation is already multi-word.
    // Multi-word translations (e.g. "de nuevo", "de hecho") are rich and specific enough
    // that a positionally-extracted single token would only corrupt them.
    // e.g. "erneut"→"de nuevo": don't add/promote "tomar" from the "erneut nehmen" chunk.
    const isoIsMultiWord = finalWordTranslation.includes(' ');
    if (!isoIsMultiWord && chunkLetters <= 5 && chunkLower !== finalWordTranslation.toLowerCase()) {
      if (effectiveAlts.length === 0) {
        // No alts yet: chunk gives the only context-based translation
        // Keep raw as the first alternative so user sees both options
        effectiveAlts = [finalWordTranslation];
        finalWordTranslation = extractedFromChunks;
      } else {
        const chunkIsAlt = effectiveAlts.some(a => a.toLowerCase() === chunkLower);
        if (chunkIsAlt) {
          // Chunk matches a known alternative → promote it to primary
          effectiveAlts = [finalWordTranslation, ...effectiveAlts.filter(a => a.toLowerCase() !== chunkLower)].slice(0, 3);
          finalWordTranslation = extractedFromChunks;
        } else {
          // Chunk is NOT in dict alternatives — it's the contextual meaning of this
          // specific sentence (e.g. "été" dict="summer", in "a été entendu" chunk="been").
          // Add it as an extra alternative so the user sees both meanings.
          // Guard: single word only (avoids promoting misaligned multi-word chunks).
          const chunkWordCount = extractedFromChunks.trim().split(/\s+/).length;
          if (chunkWordCount === 1 && effectiveAlts.length < 3) {
            effectiveAlts = [...effectiveAlts, extractedFromChunks];
          }
        }
      }
    }
  }

  // Context-alternative promotion for large single-chunk translations (common in CJK headlines).
  // GT sometimes returns the entire sentence as one chunk with no sub-alignment for individual words.
  // In that case extractedFromChunks = null, so the chunk promotion above never ran.
  // Example: "中国" → dict="Porcelana", alts=["China","Loza fina"],
  //          context = "...de China se reduce..." → "China" is the correct sense.
  // Fix: if the dict primary doesn't appear in the context translation, but one of the
  // alternatives does, promote that alternative to primary.
  if (!extractedFromChunks && finalWordTranslation && phraseRaw && effectiveAlts.length > 0) {
    const phraseRawLower = phraseRaw.toLowerCase();
    const primaryLower = finalWordTranslation.toLowerCase();
    if (!phraseRawLower.includes(primaryLower)) {
      for (const alt of effectiveAlts) {
        const altLower = alt.toLowerCase();
        if (altLower.length >= 3 && phraseRawLower.includes(altLower)) {
          effectiveAlts = [finalWordTranslation, ...effectiveAlts.filter(a => a.toLowerCase() !== altLower)].slice(0, 3);
          finalWordTranslation = alt;
          break;
        }
      }
    }
  }

  if (!finalWordTranslation && wordSameAsInput && !sameLanguage && wordAlts.length > 0) {
    const contextCandidate = extractedFromChunks
      || (phraseRaw ? extractWordFromContext(word, context, phraseRaw) : null);
    // Use context candidate only when it matches a known dict translation (not garbage)
    if (contextCandidate && wordAlts.some(a => a.toLowerCase() === contextCandidate.toLowerCase())) {
      finalWordTranslation = contextCandidate;
      effectiveAlts = wordAlts.filter(a => a.toLowerCase() !== finalWordTranslation.toLowerCase());
    } else {
      finalWordTranslation = wordAlts[0];
      effectiveAlts = wordAlts.slice(1);
    }
  }

  if (!finalWordTranslation && !phraseRaw) {
    // No usable translation — look up definition anyway (useful for same-language case)
    const definition = await lookupDefinition(word, targetLang, context);
    return {
      translation: null,
      alternatives: [],
      translatable: false,
      sameLanguage,
      definition,
      extractedTranslation: usePivot ? null : (extractedTranslation || null),
      contextPhrase: context || null,
      contextTranslation: null
    };
  }

  // Last-resort fallback for German common nouns: if the pivot failed or properNounSuppression
  // misfired for a word with a German noun suffix (-ung, -heit, -keit, etc.), try a direct
  // de→targetLang call. These words are never proper nouns so suppression is always wrong.
  // e.g. "Abkühlung" pivot→"enfriamiento" suppressed → de→es directly → "enfriamiento" ✓
  // Use the already-computed hasDistinctGermanNounSuffix (no sourceLang check needed —
  // works even when the page has no lang attribute and sourceLang='auto').
  // Also cover -ion/-tion/-sion for explicitly German pages.
  const hasGermanNounSuffixEarly = hasDistinctGermanNounSuffix ||
    (sourceLang === 'de' && /(?:ion|tion|sion)$/i.test(word));
  if (!finalWordTranslation && hasGermanNounSuffixEarly && !word.includes(' ')) {
    try {
      const directResult = await callGoogleTranslate(word, 'de', targetLang, false);
      if (directResult?.text && directResult.text.toLowerCase().trim() !== word.toLowerCase()) {
        finalWordTranslation = directResult.text;
        if (directResult.posGroups?.length) wordPosGroups = directResult.posGroups;
        if (directResult.alternatives?.length) wordAlts = directResult.alternatives;
      }
    } catch { /* keep null */ }
  }

  // Cognate-company override: if a capitalized word (≥6 chars) translated to a near-cognate
  // (same 3-char normalized stem), GT may have treated a company/org name as a common word
  // via shared etymology (e.g. "Anthropic" → "antrópico" via Greek ánthrōpos).
  // Check Wikipedia proactively; if it confirms the word is an organization, prefer that
  // over the GT adjective translation.
  let definition = null;
  if (isCapitalized && finalWordTranslation && !word.includes(' ') && wordForApi.length >= 6) {
    const normSrc3 = wordForApi.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '').substring(0, 3);
    const normTrx3 = finalWordTranslation.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '').substring(0, 3);
    if (normSrc3.length === 3 && normSrc3 === normTrx3) {
      const cogWiki = await lookupDefinition(word, targetLang, context);
      if (cogWiki && cogWiki.length > 0) {
        const cogText = (cogWiki[0]?.text ?? String(cogWiki[0])) || '';
        // Keywords in multiple languages — Wikipedia description may be in target language
        const isOrgLike = /\b(company|corporation|founded|ai safety|artificial intelligence|startup|research lab|organization|institute|nonprofit|safety company|empresa|corporaci[oó]n|fundad[ao]|inteligencia artificial|organizaci[oó]n|investigaci[oó]n y desarrollo|soci[eé]t[eé]|entreprise|unternehmen|azienda)\b/i.test(cogText);
        if (isOrgLike) {
          definition = cogWiki;
          // Keep finalWordTranslation — show both the cognate translation AND the Wikipedia definition
        }
      }
    }
  }
  // If word has no translation (including after cognate-org override above), look up definition.
  // Skip Wikipedia for words with German common-noun suffixes (-ung, -heit, -keit, -schaft,
  // -tum, -nis, -ling, -sal) — these are grammatically common nouns, never proper nouns.
  // e.g. "Abkühlung" suppressed by length-divergence → lookup finds "place in Kyrgyzstan" ✗
  const hasGermanNounSuffix = hasGermanNounSuffixEarly;
  if (!definition && !finalWordTranslation && !hasGermanNounSuffix) {
    definition = await lookupDefinition(word, targetLang, context);
  }

  // German separable verb detection (Trennbare Verben)
  // Only for German single-word hovers: "bereitet" + "vor" in sentence -> vorbereiten
  let separableVerb = null;
  if (sourceLang === 'de' && !word.includes(' ')) {
    // Guard: skip if GT's bilingual dict identified the word as a non-verb POS.
    // e.g. "erneut" → pos "adverbio", "massiv" → pos "adjetivo" — neither can be a sep. verb.
    // If POS is unknown (no dict entry), we still attempt detection.
    const wordPos = ((wordPosGroups[0]?.pos) || '').toLowerCase();
    // "verbo" starts with "verb" → is verb; "adverbio" starts with "adv" → not a verb.
    // Using startsWith avoids the false match of "adverb" containing "verb" substring.
    const isNonVerbPos = wordPos.length > 0 && !wordPos.startsWith('verb');

    // Note: capitalized words are no longer skipped here — V1 sentence-initial verbs
    // ("Steht ganz Russland... bevor?") are capitalized and must reach findSeparableVerb.
    // German nouns are protected by downstream guards (stripGermanVerbEnding, GT echo,
    // GT dict entry check). But we DO skip:
    //   • ALL-CAPS words ("TREIBSTOFF-KRISE") — headline labels, never verb conjugations
    //   • Hyphenated compounds ("Treibstoff-Krise") — compound nouns, not verb stems
    // Words starting with German negation prefix "un-" (unerlaubt, ungültig, unmöglich…)
    // are adjectives/adverbs — never conjugated forms of separable verbs.
    // Exclude "unter…" (inseparable prefix), "und" (conjunction), "um" (handled separately).
    const startsWithNegUn = /^un(?!ter|d|fang)/i.test(word);
    // Words with typical German adjective/adverb suffixes are also never separable verbs.
    const hasAdjSuffix = /(?:lich|ig|isch|bar|sam|los|voll|haft|mäßig|weise|artig|förmig)$/i.test(word);

    if (!isNonVerbPos && !isAllCaps && !word.includes('-') && !startsWithNegUn && !hasAdjSuffix) {
      separableVerb = await findSeparableVerb(word, sentence, targetLang);
    }
  }

  // If a separable verb was found but the word itself has no translation
  // (e.g. "Steht" at V1 position: pivot gives "es", 60% length divergence →
  // properNounSuppression=true → finalWordTranslation=null), use the separable verb's
  // translation as the primary so translatable=true and content.js shows it correctly.
  if (separableVerb?.translation && !finalWordTranslation) {
    finalWordTranslation = separableVerb.translation;
    effectiveAlts = [];
    definition = null; // suppress spurious Wikipedia result (looked up before sep-verb was known)
  }

  return {
    translation: finalWordTranslation,
    alternatives: finalWordTranslation ? effectiveAlts : [],
    posGroups: finalWordTranslation ? wordPosGroups : [],
    translatable: !!finalWordTranslation,
    sameLanguage,
    definition,
    extractedTranslation: usePivot ? null : (extractedTranslation || null),
    contextPhrase: context || null,
    contextTranslation: phraseRaw || null,
    sentenceTranslation: sentenceRaw || null,
    sentenceExtracted: sentenceExtracted || null,
    separableVerb
  };
}

// ---------------------------------------------------------------------------
// Chunk-based word extraction — uses GT's own source→target alignment.
// GT's data[0] = [[translated_part, source_part, ...], ...] pairs.
// We find the chunk whose source_part matches the hovered word and return its translation.
// This is far more reliable than positional alignment.
// ---------------------------------------------------------------------------
function extractWordFromChunks(word, chunks) {
  if (!chunks || !Array.isArray(chunks) || !word) return null;
  const wl = word.toLowerCase().trim();
  try {
    // Pass 1: exact match — source_part trimmed equals word (single-word chunk)
    for (const chunk of chunks) {
      const src = (chunk?.[1] ?? '').trim().toLowerCase();
      if (src === wl) {
        const tgt = (chunk?.[0] ?? '').trim();
        if (tgt && tgt.toLowerCase() !== wl) return tgt;
      }
    }
    // Pass 2: source chunk contains the word as a whole token.
    // Only for tight chunks (≤2 source tokens, e.g. "Person skjuten" → "Persona abatida").
    // Larger chunks are too imprecise for positional guessing within the chunk —
    // those fall through to extractWordFromContext which handles the whole sentence.
    for (const chunk of chunks) {
      const srcTokens = (chunk?.[1] ?? '').toLowerCase().split(/\s+/).filter(t => t.length > 0);
      if (srcTokens.length > 2) continue; // skip large chunks

      const wordIdx = srcTokens.findIndex(t => t === wl || t.replace(/[^a-zA-ZÀ-ɏ]/g, '') === wl);
      if (wordIdx === -1) continue;

      const tgtRaw = (chunk?.[0] ?? '').trim();
      if (!tgtRaw) continue;

      const tgtTokens = tgtRaw.split(/\s+/).filter(t => t.length > 0);
      if (!tgtTokens.length) continue;

      let tgt;
      if (srcTokens.length === 1) {
        // Single-word source chunk — use the whole target (may be a multi-word compound)
        tgt = tgtRaw;
      } else {
        // 2-token source chunk: map word position (0 or 1) to the target
        const rel = wordIdx / (srcTokens.length - 1);
        const mappedIdx = Math.min(Math.round(rel * (tgtTokens.length - 1)), tgtTokens.length - 1);
        tgt = tgtTokens[mappedIdx];
      }
      if (tgt && tgt.toLowerCase() !== wl) return tgt;
    }
  } catch { /* ignore */ }
  return null;
}

// ---------------------------------------------------------------------------
// Positional word alignment — extract the translated equivalent of `word`
// from the full phrase translation, without any extra API call.
//
// Algorithm: find word's relative position in the source context, map that
// position into the translated context, and pick the best content word nearby.
//
// Example: "convicts" is at index 1/4 in "Brazil convicts Jair Bolsonaro"
//          → maps to index ~1/5 in "Brasil condena a Jair Bolsonaro"
//          → candidates: ["Brasil","condena","a"] → longest ≥3 chars → "condena" ✓
// ---------------------------------------------------------------------------
function extractWordFromContext(word, sourceContext, translatedContext) {
  if (!sourceContext || !translatedContext || !word) return null;
  try {
    // Tokenize into word tokens (Latin + extended Latin + Cyrillic)
    const tokenize = (s) => s.match(/[\wÀ-ɏЀ-ӿ]+/g) || [];

    const src = tokenize(sourceContext);
    const tgt = tokenize(translatedContext);
    if (src.length < 2 || !tgt.length) return null;

    // Find the hovered word's position in the source tokens (case-insensitive)
    const wl  = word.toLowerCase();
    const wi  = src.findIndex(t => t.toLowerCase() === wl);
    if (wi === -1) return null;

    // Map relative position into target
    const rel = wi / Math.max(src.length - 1, 1);
    const ti  = Math.min(Math.round(rel * (tgt.length - 1)), tgt.length - 1);

    // Check ±1 window around mapped position; prefer content words (longer tokens)
    const windowIdxs = [ti - 1, ti, ti + 1].filter(i => i >= 0 && i < tgt.length);
    const candidates = windowIdxs
      .map(i => ({ token: tgt[i], i, dist: Math.abs(i - ti) }))
      .filter(c => c.token.length >= 3);
    if (!candidates.length) return tgt[ti] || null;

    // Sort: closest to mapped position first (strongest signal); ties broken by longest token
    candidates.sort((a, b) => a.dist - b.dist || b.token.length - a.token.length);
    const best = candidates[0];

    // Safety check: if the extracted word shares its first 4 characters with a SOURCE
    // neighbor (not the hovered word itself), it's likely the translation of that neighbor —
    // a cognate or borrowed word rather than a true translation of our word.
    // Example: "sonens fiasko" (sv) → extracted "fiasco" matches neighbor "fiasko" → reject.
    const bestLower = best.token.toLowerCase();
    const isCognateOfNeighbor = src.some((t, i) => {
      if (i === wi) return false; // skip the hovered word itself
      const tl = t.toLowerCase();
      const minLen = Math.min(tl.length, bestLower.length);
      if (minLen < 4) return false;
      return tl.substring(0, 4) === bestLower.substring(0, 4);
    });
    if (isCognateOfNeighbor) return null;

    // Expand "X de Y" Spanish/Portuguese compound (e.g. "buque de guerra", "jefe de estado")
    if (best.i >= 2 && tgt[best.i - 1]?.toLowerCase() === 'de' && tgt[best.i - 2]?.length >= 2) {
      return `${tgt[best.i - 2]} de ${best.token}`;
    }

    return best.token;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Full-name extraction — for proper nouns, scan the surrounding context for
// adjacent capitalized words so we can look up "Donald Trump" or "Lionel Messi"
// in Wikipedia instead of just "Donald" or "Lionel".
// ---------------------------------------------------------------------------
function extractFullName(word, context) {
  if (!context) return word;
  try {
    const tokens = context.match(/\S+/g) || [];
    const wl = word.replace(/[^a-zA-ZÀ-ɏ-]/g, '').toLowerCase();
    const idx = tokens.findIndex(t => t.replace(/[^a-zA-ZÀ-ɏ-]/g, '').toLowerCase() === wl);
    if (idx === -1) return word;

    // Start with the canonical form from context (preserves original casing)
    let name = tokens[idx].replace(/[^a-zA-ZÀ-ɏ-]/g, '');

    // Extend rightward for up to 2 more consecutive capitalized tokens
    for (let i = idx + 1; i < tokens.length && i <= idx + 2; i++) {
      const rawTok = tokens[i];
      const next = rawTok.replace(/[^a-zA-ZÀ-ɏ-]/g, '');
      // Must start with uppercase (not a preposition/article like "de", "van", "of")
      if (next.length >= 2 &&
          next[0] === next[0].toUpperCase() && next[0] !== next[0].toLowerCase()) {
        name += ' ' + next;
        // Trailing punctuation (comma, colon, period…) marks the end of the name component.
        // e.g. "Trump," → include "Trump" but stop — don't grab the next "Barack".
        if (/[,.:;!?»"')\]]$/.test(rawTok)) break;
      } else {
        break;
      }
    }
    return name;
  } catch {
    return word;
  }
}

// ---------------------------------------------------------------------------
// Definition lookup — Wikipedia (target lang first) + Free Dictionary fallback
// For proper nouns, tries the full name extracted from context before falling
// back to the single word.
// ---------------------------------------------------------------------------
async function lookupDefinition(word, targetLang = 'en', context = null) {
  // For capitalized words, try to build the full name from surrounding context
  // e.g. "Donald" + context "Donald Trump prend la parole" → look up "Donald Trump"
  const isCapitalized = word.length >= 2 &&
    word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase();

  if (isCapitalized && context) {
    const fullName = extractFullName(word, context);
    if (fullName !== word && fullName.includes(' ')) {
      const wikiFullName = await lookupWikipedia(fullName, targetLang);
      if (wikiFullName) return [wikiFullName];
    }
  }

  // Wikipedia is only meaningful for proper nouns (capitalized words).
  // For lowercase common words (e.g. "defends"), OpenSearch returns unrelated
  // articles (e.g. "The Defenders" Marvel show) — skip Wikipedia entirely.
  if (isCapitalized) {
    const wiki = await lookupWikipedia(word, targetLang);
    if (wiki) {
      // If the Wikipedia result describes a geographic place but the surrounding
      // context signals a person (e.g. "Vance" → Belgian commune vs VP Vance),
      // try to find the person article instead.
      // If Wikipedia returns a geographic article for a capitalized word, try to find
      // a person article instead. Geographic false positives (user reading about a commune)
      // are rare — most capitalized words in context are people, not places.
      const isGeoResult = /\b(commun[ae]|comuni?[ao]|municipalit[yé]|municipio|municipality|village|villaggio|pueblo|aldea|localidad|Gemeinde|gemeente|town\s+in|city\s+in|borough|hamlet|parish|census-designated|unincorporated)\b/i.test(wiki.text);
      if (isGeoResult) {
        const personWiki = await lookupWikipediaPersonFallback(word, targetLang);
        if (personWiki) return [personWiki];
      }
      return [wiki];
    }
  }
  // FreeDictionary returns an array of {text, pos} (one per POS)
  if (targetLang === 'en') return lookupFreeDictionary(word);
  return null;
}

// Fallback when a Wikipedia direct-lookup returns a geographic article but the
// hover context suggests the word is a person (politician, official, etc.).
// Tries disambiguation suffixes, then an OpenSearch for "word politician".
async function lookupWikipediaPersonFallback(word, targetLang) {
  for (const suffix of ['(politician)', '(American politician)', '(person)']) {
    const r = await fetchWikiSummary(`${word} ${suffix}`, 'en');
    if (r) return r;
  }
  try {
    const res = await fetch(
      `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(word + ' politician')}&limit=3&format=json&origin=*`
    );
    if (!res.ok) return null;
    const data = await res.json();
    const titles = data[1] || [];
    for (const title of titles) {
      if (title.toLowerCase().includes(word.toLowerCase())) {
        const r = await fetchWikiSummary(title, 'en');
        if (r) return r;
      }
    }
  } catch {}
  return null;
}

// Wikipedia REST API — tries target-language Wikipedia first, then English.
// This means "Météo-France" will show a Spanish description on es.wikipedia.org
// when the target language is Spanish, rather than the English one.
async function lookupWikipedia(word, targetLang = 'en') {
  try {
    // 1. Try target-language Wikipedia (skipped when target is already English)
    if (targetLang !== 'en') {
      const targetResult = await fetchWikiSummary(word, targetLang);
      if (targetResult) {
        // If target-lang returned a biographical entry (person born in a year), also check
        // English Wikipedia before returning. Some target-lang Wikis have the same title
        // pointing to a person while the more notable entry is the concept/disease/etc.
        // e.g. "Ebola" → es.wikipedia = Icelandic musician, en.wikipedia = viral disease.
        const isBiographical = /\b(born|nacido|nació|né|geboren)\b.{0,30}\d{4}|\(\d{4}[–\-]/.test(targetResult.text);
        if (!isBiographical) return targetResult;
        const engResult = await fetchWikiSummary(word, 'en');
        if (engResult) {
          const engIsBio = /\bborn\b.{0,30}\d{4}|\(\d{4}[–\-]/.test(engResult.text);
          if (!engIsBio) return engResult; // English has a non-biographical result — prefer it
        }
        return targetResult; // Both biographical or no English result — keep target-lang
      }
    }

    // 2. Try English Wikipedia direct lookup
    const direct = await fetchWikiSummary(word, 'en');
    if (direct) return direct;

    // 3. OpenSearch fallback on English Wikipedia.
    // Skip for hyphenated compounds — the fuzzy match returns unrelated articles
    // (e.g. "AI-KRASCHEN" → "Ai" the Taiwanese artist instead of "AI crash").
    if (word.includes('-')) return null;

    const searchRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(word)}&limit=1&format=json&origin=*`
    );
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    const articleTitle = searchData[1]?.[0];
    if (!articleTitle || articleTitle.toLowerCase() === word.toLowerCase()) return null;

    // Reject if the article title is much shorter than the query — indicates a
    // prefix-only match rather than a genuine article for this term.
    // e.g. "Ai" (2 letters) found for "AI-KRASCHEN" (10 letters) → reject.
    const cleanTitle = articleTitle.replace(/[^a-zA-ZÀ-ɏ]/g, '');
    const cleanWord  = word.replace(/[^a-zA-ZÀ-ɏ]/g, '');
    if (cleanTitle.length < cleanWord.length * 0.5) return null;

    // For multi-word queries, require the article title to contain ALL significant words.
    // Prevents false matches like "Remember Ebola" → "Remember (Ólafur Arnalds album)"
    // where the OpenSearch found a title with only one of the two words.
    if (word.includes(' ')) {
      const queryWords = word.toLowerCase().split(/\s+/)
        .map(w => w.replace(/[^a-zà-ÿ]/gi, '').toLowerCase())
        .filter(w => w.length >= 4);
      const titleLower = articleTitle.toLowerCase();
      if (queryWords.length > 0 && !queryWords.every(qw => titleLower.includes(qw))) return null;
    }

    // 4. If target-lang Wikipedia has the article under the English title, prefer it
    if (targetLang !== 'en') {
      const targetByEnTitle = await fetchWikiSummary(articleTitle, targetLang);
      if (targetByEnTitle) return targetByEnTitle;
    }
    return await fetchWikiSummary(articleTitle, 'en');
  } catch {
    return null;
  }
}

async function fetchWikiSummary(title, lang = 'en') {
  try {
    const res = await fetch(
      `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (!res.ok) return null;

    const data = await res.json();
    if (data.type === 'disambiguation') return null;

    // Prefer description (short phrase, already trimmed, no splitting needed)
    // Extract needs sentence splitting — skip on abbreviations like U.S., Dr., etc.
    let text;
    if (data.description) {
      text = data.description;
    } else if (data.extract) {
      const safe = data.extract.replace(/([A-Z])\.([A-Z])/g, '$1\x00$2');
      const sentence = safe.split(/\.\s+[A-Z]/)[0].replace(/\x00/g, '.').replace(/\.$/, '');
      text = sentence;
    }
    if (!text) return null;
    const short = text.length > 120 ? text.substring(0, 117) + '…' : text;
    return { text: short, pos: '' };
  } catch {
    return null;
  }
}

// Free Dictionary API — English only, used only when target language is English
// https://dictionaryapi.dev  (free, no key)
async function lookupFreeDictionary(word) {
  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`);
    if (!res.ok) return null;

    const data = await res.json();
    if (!Array.isArray(data) || !data[0]) return null;

    const meanings = data[0].meanings || [];
    const results = [];
    for (const meaning of meanings) {
      const def = meaning.definitions?.[0]?.definition;
      if (def) {
        const pos = meaning.partOfSpeech || '';
        const short = def.length > 100 ? def.substring(0, 97) + '…' : def;
        results.push({ text: short, pos });
        if (results.length >= 3) break;
      }
    }
    if (!results.length) return null;
    // Sort: verb first — most relevant for action words in news context
    results.sort((a, b) => {
      if (a.pos === 'verb' && b.pos !== 'verb') return -1;
      if (a.pos !== 'verb' && b.pos === 'verb') return 1;
      return 0;
    });
    return results; // array of {text, pos}
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Provider router
// ---------------------------------------------------------------------------
async function callProvider(word, settings) {
  const provider = settings.provider || PROVIDER_MYMEMORY;

  if (provider === PROVIDER_LIBRETRANSLATE) {
    return callLibreTranslate(word, settings.sourceLang, settings.targetLang,
      settings.apiUrl, settings.apiKey);
  }

  // Default: MyMemory
  return callMyMemory(word, settings.sourceLang, settings.targetLang, settings.email);
}

// ---------------------------------------------------------------------------
// Pivot translation: source → English → target.
// Used for PIVOT_LANGS (Nordic/Baltic) when translating to non-English.
// GT's sv↔en and en↔es corpora are large; sv→es direct is much smaller.
// Only called for isolated words (never for phrase context — we need
// source→target chunks for chunk alignment in extractWordFromChunks).
// ---------------------------------------------------------------------------
async function callGoogleTranslatePivot(text, sourceLang, targetLang) {
  // Step 1: source → English
  const enResult = await callGoogleTranslate(text, sourceLang, 'en', false);
  const enText = enResult.text;
  if (!enText) throw new Error('Pivot step 1 failed');

  // Step 2: English → target (bilingual dict applies if single word)
  try {
    const esResult = await callGoogleTranslate(enText, 'en', targetLang, false, true); // throwOnEcho=true: loanwords echo cleanly → catch returns enText
    // The en→es bilingual dict sometimes includes English words as alternatives
    // (e.g. "fiasco"→en→es dict: ["fracaso","failure","flop"]).
    // Filter out any alternative that also appeared in the English step-1 result.
    const enWords = new Set([
      enText.toLowerCase(),
      ...enResult.alternatives.map(a => a.toLowerCase())
    ]);
    const cleanAlts = esResult.alternatives.filter(a => !enWords.has(a.toLowerCase()));
    return { ...esResult, alternatives: cleanAlts };
  } catch (e) {
    // "GT echoed input" means the English word is identical in the target language.
    // e.g. "fiasko" sv→en="fiasco", en→es="fiasco" (same word) → valid translation.
    // Return the English intermediate directly. Don't carry over English alternatives.
    if (e.message === 'GT echoed input') {
      return { text: enText, alternatives: [] };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Google Translate  (unofficial gtx endpoint, free, no key, fast)
// Used by dozens of browser extensions. Falls back to MyMemory if unavailable.
// Returns {text, alternatives} — same shape as callMyMemory.
// ---------------------------------------------------------------------------
async function callGoogleTranslate(text, sourceLang, targetLang, returnChunks = false, throwOnEcho = false) {
  const src = (!sourceLang || sourceLang === 'auto') ? 'auto' : sourceLang;
  const tgt = targetLang || 'es';

  // For single words, request bilingual dict (dt=bd) AND alternative translations (dt=at).
  // dt=bd: POS-categorised translations — works for most content words but returns null
  //        for many function words (att, ett, de, en, …).
  // dt=at: alternative translations in data[5] — fills the gap when dt=bd gives nothing.
  // For multi-word phrases we skip both — they're meaningless for sentences.
  const isSingleWord = !text.trim().includes(' ');
  const dtParams = isSingleWord ? '&dt=t&dt=bd&dt=at' : '&dt=t';

  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(src)}&tl=${encodeURIComponent(tgt)}${dtParams}&q=${encodeURIComponent(text)}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`GT HTTP ${res.status}`);

  const data = await res.json();

  // data[0]: [[translated_chunk, source_chunk, ...], ...]
  const chunks = Array.isArray(data[0]) ? data[0] : [];
  const rawTranslation = chunks.map(chunk => chunk?.[0] || '').join('').trim();

  // data[1] (bilingual dict, dt=bd):
  // [[pos_label, [trans1, trans2, ...], [rev_trans], [[trans1, [back], score], ...]], ...]
  // POS-aware, gives grammatically correct forms. Often null for function words.
  let dictTranslation = null;
  const dictAlternatives = [];
  if (isSingleWord && Array.isArray(data[1])) {
    for (const entry of data[1]) {
      // GT dt=bd structure:
      //   entry[1] = ["trans1", "trans2", ...] — short list, sometimes only 1 entry or null
      //   entry[2] = [["trans1", ["back"], score], ...] — scored list, often more complete
      // Merge both sources: entry[1] order first, then any unique entries from entry[2].
      const e1 = Array.isArray(entry?.[1]) ? entry[1].filter(t => t && typeof t === 'string') : [];
      const e2 = Array.isArray(entry?.[2])
        ? entry[2].map(item => (Array.isArray(item) ? item[0] : null)).filter(t => t && typeof t === 'string')
        : [];
      const posTranslations = [...new Set([...e1, ...e2])];
      if (!posTranslations.length) continue;
      if (!dictTranslation) {
        dictTranslation = posTranslations[0];
        for (const t of posTranslations.slice(1, 4)) {
          if (t !== dictTranslation && !dictAlternatives.includes(t)) dictAlternatives.push(t);
        }
      } else {
        for (const t of posTranslations) {
          if (t !== dictTranslation && !dictAlternatives.includes(t)) {
            dictAlternatives.push(t);
            break;
          }
        }
      }
      if (dictAlternatives.length >= 4) break;
    }
  }

  // data[5] (alternative translations, dt=at) — fallback when dt=bd returns nothing.
  // Real structure (confirmed by debug): data[5] is a flat array where data[5][0] is:
  //   [source_word, null, [[trans, null, bool, bool, [score]], ...], [pos_range]]
  // Translations are at entry[2], NOT entry[1] (entry[1] is null).
  // e.g. "att" → entry[2] = [["a",null,true,false,[11]],["para",...],["en",...],...]
  // e.g. "ett" → entry[2] = [["a",...],["un",...],["una",...],["la",...],...]
  if (isSingleWord && !dictTranslation && Array.isArray(data[5])) {
    for (const entry of data[5]) {
      if (!Array.isArray(entry) || !Array.isArray(entry[2])) continue;
      for (const alt of entry[2]) {
        const t = Array.isArray(alt) ? alt[0] : null;
        if (!t || typeof t !== 'string') continue;
        const tl = t.toLowerCase().trim();
        if (!tl || tl === text.toLowerCase().trim()) continue; // skip echoes
        if (!dictTranslation) {
          dictTranslation = t;
        } else if (t !== dictTranslation && !dictAlternatives.includes(t)) {
          dictAlternatives.push(t);
          if (dictAlternatives.length >= 3) break;
        }
      }
      if (dictAlternatives.length >= 3) break;
    }
  }

  // Supplement alternatives with data[5] when data[1] gave a primary but fewer than 3 alts.
  // This catches additional word senses absent from the bilingual dict (homographs like
  // French "été": data[1] only gives noun="summer", but data[5] also has verb="been").
  if (isSingleWord && dictTranslation && dictAlternatives.length < 3 && Array.isArray(data[5])) {
    const dictPrimaryLower = dictTranslation.toLowerCase();
    const textLower = text.toLowerCase().trim(); // use the local `text` param, not wordForApi
    for (const entry of data[5]) {
      if (!Array.isArray(entry) || !Array.isArray(entry[2])) continue;
      for (const alt of entry[2]) {
        const t = Array.isArray(alt) ? alt[0] : null;
        if (!t || typeof t !== 'string') continue;
        const tl = t.toLowerCase().trim();
        if (!tl || tl === textLower) continue; // skip echoes
        if (tl === dictPrimaryLower) continue; // already the primary
        if (dictAlternatives.some(a => a.toLowerCase() === tl)) continue; // already listed
        dictAlternatives.push(t);
        if (dictAlternatives.length >= 3) break;
      }
      if (dictAlternatives.length >= 3) break;
    }
  }

  // Prefer the translation with more words — it's usually more complete/grammatical.
  // e.g. "sonens" (sv→es): rawTranslation="del hijo" (2 words) beats dictTranslation="hijo" (1 word).
  // When word count is equal, prefer the dict ONLY when dict and raw are semantically related
  // (one contains the other as a substring). When they DISAGREE at equal word count, the
  // neural MT result (raw/dt=t) is more reliable — it handles polysemy better in context.
  // e.g. "Drohnen de→es": raw="Drones" (correct noun) vs dict="fragor" (wrong verb sense)
  //      → raw wins. "massiv de→en": raw="massive" vs dict="massive" → same, dict wins.
  const rawWords  = rawTranslation  ? rawTranslation.trim().split(/\s+/).length  : 0;
  const dictWords = dictTranslation ? dictTranslation.trim().split(/\s+/).length : 0;
  const rawLow  = (rawTranslation  || '').toLowerCase();
  const dictLow = (dictTranslation || '').toLowerCase();
  const rawAndDictRelated = !!(rawLow && dictLow &&
    (rawLow.includes(dictLow) || dictLow.includes(rawLow)));
  const useDict = !!(dictTranslation &&
    (dictWords > rawWords || (dictWords === rawWords && rawAndDictRelated)));
  const translation = useDict ? dictTranslation : rawTranslation;

  if (!translation || translation.toLowerCase() === text.toLowerCase().trim()) {
    // Before throwing, check if data[5] gave us a non-echo alternative that can serve as primary.
    // e.g. "pastor" en→es: dictTranslation="pastor" (echo), but data[5] has "párroco" → use it.
    // Skip this when throwOnEcho=true — used by pivot step-2 so loanwords ("drones" en→es)
    // throw cleanly and the pivot catch-block returns the correct English intermediate.
    if (!throwOnEcho) {
      const nonEchoAlt = dictAlternatives.find(a => a.toLowerCase().trim() !== text.toLowerCase().trim());
      if (nonEchoAlt) {
        const restAlts = dictAlternatives.filter(a => a !== nonEchoAlt);
        return { text: nonEchoAlt, alternatives: restAlts, ...(returnChunks ? { chunks } : {}) };
      }
    }
    throw new Error('GT echoed input');
  }

  // Build posGroups when data[1] has ≥2 POS entries (e.g. "oppose" = verb + adjective).
  // Each group: { pos: string label, translations: string[] }.
  // Single-POS words skip this — the flat alternatives list is sufficient.
  const posGroups = [];
  if (isSingleWord && Array.isArray(data[1]) && data[1].length >= 2) {
    for (const entry of data[1]) {
      const pos = (typeof entry?.[0] === 'string' && entry[0]) ? entry[0] : null;
      if (!pos) continue;
      const g1 = Array.isArray(entry?.[1]) ? entry[1].filter(t => t && typeof t === 'string') : [];
      const g2 = Array.isArray(entry?.[2])
        ? entry[2].map(item => (Array.isArray(item) ? item[0] : null)).filter(t => t && typeof t === 'string')
        : [];
      const groupTranslations = [...new Set([...g1, ...g2])].slice(0, 3);
      if (groupTranslations.length) posGroups.push({ pos, translations: groupTranslations });
    }
  }

  // firstPos: the POS label from data[1][0] regardless of how many entries data[1] has.
  // Used by supplementPosGroupsViaEn to filter Path B alternatives by POS.
  const firstPos = (isSingleWord && Array.isArray(data[1]) && data[1].length >= 1 &&
                    typeof data[1][0]?.[0] === 'string' && data[1][0][0])
    ? data[1][0][0] : '';
  const detectedLang = (typeof data[2] === 'string' && data[2]) ? data[2] : null;
  // When we used rawTranslation over a DISAGREEING dictTranslation, the dict alternatives
  // and posGroups all come from the wrong word sense — discard them to avoid confusion.
  // e.g. "Drohnen de→es": raw="Drones" wins over dict="fragor"; discard [fragor/retumbar/zumbar].
  const _discardDict = !useDict && !!dictTranslation && !rawAndDictRelated;
  return {
    text: translation, rawText: rawTranslation,
    alternatives: _discardDict ? [] : dictAlternatives,
    posGroups:    _discardDict ? [] : posGroups,
    firstPos, detectedLang,
    ...(returnChunks ? { chunks } : {})
  };
}

// ---------------------------------------------------------------------------
// POS supplementation via English pivot
// When the direct language pair (e.g. fr→es) gives < 2 POS groups, call
// source→en (GT's bilingual dict is usually richer here) and then translate
// each POS group's primary English term en→target.
// Returns an array of posGroup objects, or null if supplement doesn't help.
// ---------------------------------------------------------------------------
async function supplementPosGroupsViaEn(word, sourceLang, targetLang) {
  // Step 1: source → en (get rich POS structure + data[5] alternatives)
  let enResult;
  try { enResult = await callGoogleTranslate(word, sourceLang, 'en', false); }
  catch (e) { console.log('[HT-debug] supplementPosGroupsViaEn src→en failed:', e.message); return null; }
  const enPosGroups = enResult.posGroups ?? [];
  console.log('[HT-debug] src→en result:', { text: enResult.text, alts: enResult.alternatives, posGroups: JSON.stringify(enPosGroups) });

  // Path A: data[1] gave ≥2 POS groups → translate each group primary term en→target.
  if (enPosGroups.length >= 2) {
    const groups = [];
    const seenLower = new Set();
    for (const epg of enPosGroups) {
      const enTerm = epg.translations[0];
      if (!enTerm) continue;
      let tgtText, tgtAlts = [];
      try {
        const r = await callGoogleTranslate(enTerm, 'en', targetLang, false);
        tgtText = r.text;
        tgtAlts = r.alternatives ?? [];
      } catch { continue; }
      if (!tgtText) continue;
      const tgtLower = tgtText.toLowerCase();
      if (seenLower.has(tgtLower)) continue;
      seenLower.add(tgtLower);
      const translations = [tgtText, ...tgtAlts.filter(a => !seenLower.has(a.toLowerCase()))].slice(0, 3);
      groups.push({ pos: epg.pos, translations });
      if (groups.length >= 3) break;
    }
    return groups.length >= 2 ? groups : null;
  }

  // Path B: data[1] only has ≤1 POS group.
  // Use data[5] alternatives from src→en to detect distinct meanings.
  // "été" fr→en: data[1] only has noun="summer", but data[5] includes "been" (PP of être).
  // Translate primary en→target, then each alternative. If an alternative translates to
  // a DIFFERENT target word it is a distinct semantic sense → build a second posGroup.
  const enPrimary = enResult.text;
  const enAlts = enResult.alternatives ?? [];
  if (!enPrimary) return null;
  // Cognate guard: if the source word appears as ANY English translation (primary or alternative),
  // it's a cognate and data[5] alternatives are just loosely related synonyms, not distinct
  // grammatical senses. Normalise away accents for the comparison so "été"≠"ete" doesn't
  // accidentally fire, while "Audience"→"audience" and "corruption"→"corruption" do.
  // Examples that MUST skip: "corruption"→"corruption", "Audience"→["Hearing","audience",...]
  // Examples that MUST proceed: "été"→["summer","been"] (no match with "été" after norm)
  const _wordNorm = word.toLowerCase().trim().normalize('NFD').replace(/\p{M}/gu, '');
  const _enTexts  = [enPrimary, ...enAlts].map(t => t.toLowerCase().trim().normalize('NFD').replace(/\p{M}/gu, ''));
  if (_enTexts.some(t => t === _wordNorm)) return null;
  if (enAlts.length === 0) return null;

  // Translate primary en→target to get the first group
  let primaryTgtResult;
  try { primaryTgtResult = await callGoogleTranslate(enPrimary, 'en', targetLang, false); }
  catch { return null; }
  const primaryTgt = primaryTgtResult?.text;
  if (!primaryTgt) return null;

  const seenLower = new Set();
  seenLower.add(primaryTgt.toLowerCase());
  const primaryAlts = (primaryTgtResult.alternatives ?? []).filter(a => {
    const al = a.toLowerCase(); if (seenLower.has(al)) return false; seenLower.add(al); return true;
  });
  const primaryPosLabel = enPosGroups[0]?.pos ?? '';
  const groups = [{ pos: primaryPosLabel, translations: [primaryTgt, ...primaryAlts].slice(0, 3) }];

  // Try each en alternative — only accept it as a new sense if:
  //  (a) its en→target translation is NOT polysemous (posGroups.length < 2), AND
  //  (b) its POS (firstPos) differs from the primary group's POS.
  // This rejects loose synonyms like "drive"→"conducir" for "attaque" (polysemous verb+noun),
  // while accepting "been"→"sido" for "été" (unambiguous verb, different POS than "summer"=noun).
  const primaryFirstPos = primaryTgtResult?.firstPos ?? '';
  for (const enAlt of enAlts) {
    let altResult;
    try { altResult = await callGoogleTranslate(enAlt, 'en', targetLang, false); }
    catch { continue; }
    const altTgt = altResult?.text;
    if (!altTgt) continue;
    // Reject polysemous alts — they give unreliable contextual translations
    if ((altResult.posGroups ?? []).length >= 2) continue;
    // Reject alts with the same POS as the primary — they're synonyms, not distinct senses
    const altFirstPos = altResult?.firstPos ?? '';
    if (primaryFirstPos && altFirstPos && altFirstPos === primaryFirstPos) continue;
    const altTgtLower = altTgt.toLowerCase();
    if (seenLower.has(altTgtLower)) continue;
    seenLower.add(altTgtLower);
    const altAlts = (altResult.alternatives ?? []).filter(a => {
      const al = a.toLowerCase(); if (seenLower.has(al)) return false; seenLower.add(al); return true;
    });
    const altPos = altFirstPos || (altResult.posGroups ?? [])[0]?.pos || '';
    groups.push({ pos: altPos, translations: [altTgt, ...altAlts].slice(0, 3) });
    if (groups.length >= 3) break;
  }

  console.log('[HT-debug] Path B groups:', JSON.stringify(groups));
  return groups.length >= 2 ? groups : null;
}

// ---------------------------------------------------------------------------
// MyMemory API  (free, no key required, 1000 words/day anonymous)
// ---------------------------------------------------------------------------
async function callMyMemory(word, sourceLang, targetLang, email) {
  const src = (!sourceLang || sourceLang === 'auto') ? 'autodetect' : sourceLang;
  const langpair = `${src}|${targetLang || 'es'}`;

  let url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(word)}&langpair=${encodeURIComponent(langpair)}`;
  if (email) url += `&de=${encodeURIComponent(email)}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);

  const data = await res.json();

  // MyMemory returns 200 even for errors — check responseStatus
  if (data.responseStatus !== 200) {
    throw new Error(data.responseDetails || `MyMemory error ${data.responseStatus}`);
  }

  const text = data.responseData?.translatedText;
  // MyMemory sometimes echoes the original if it can't translate
  if (!text || text.toLowerCase() === word.toLowerCase()) {
    throw new Error('Sin traducción disponible');
  }

  // Extract alternative translations from the matches array MyMemory returns.
  // MyMemory TM entries can be full sentence fragments, so we filter strictly:
  // only single words or short 2-word phrases, no digits, no punctuation.
  const alternatives = [];
  if (Array.isArray(data.matches)) {
    const seen = new Set([text.toLowerCase(), word.toLowerCase()]);
    for (const m of data.matches) {
      const t = (m.translation || '').trim();
      if (!t) continue;
      const tl = t.toLowerCase();
      if (seen.has(tl)) continue;
      if (parseFloat(m.match ?? 1) < 0.65) continue; // only high-confidence matches
      if (/\d/.test(t)) continue;                     // skip entries with numbers
      if (/[.!?;:()\[\]]/.test(t)) continue;          // skip sentence fragments
      if (t.split(/\s+/).length > 2) continue;        // max 2-word alternatives
      seen.add(tl);
      alternatives.push(t);
      if (alternatives.length >= 2) break;
    }
  }

  return { text, alternatives };
}

// ---------------------------------------------------------------------------
// LibreTranslate API  (self-hosted or third-party instance)
// ---------------------------------------------------------------------------
async function callLibreTranslate(word, sourceLang, targetLang, apiUrl, apiKey) {
  const url = (apiUrl || '').replace(/\/$/, '');
  if (!url) throw new Error('URL de LibreTranslate no configurada');

  const body = {
    q: word,
    source: sourceLang || 'auto',
    target: targetLang || 'es',
    format: 'text'
  };
  if (apiKey) body.api_key = apiKey;

  const res = await fetch(`${url}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error(`El servidor devolvió HTML (HTTP ${res.status}) — instancia no disponible`);
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`LibreTranslate HTTP ${res.status}: ${data.error || ''}`);
  }

  const data = await res.json();
  return data.translatedText;
}

// ---------------------------------------------------------------------------
// Test connection (called from options page)
// ---------------------------------------------------------------------------
async function testConnection(provider, apiUrl, apiKey, email) {
  try {
    let translation;
    if (provider === PROVIDER_LIBRETRANSLATE) {
      translation = await callLibreTranslate('hello', 'en', 'es', apiUrl, apiKey);
    } else {
      const result = await callMyMemory('hello', 'en', 'es', email);
      translation = result?.text ?? result;
    }
    return { ok: true, sample: translation };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Daily usage counter
// ---------------------------------------------------------------------------
async function getDailyUsage() {
  const today = getToday();
  const data = await chrome.storage.local.get(['daily_date', 'daily_count', 'premium']);
  const isPremium = !!data.premium;
  let count = 0;
  if (data.daily_date === today) {
    count = data.daily_count || 0;
  } else {
    await chrome.storage.local.set({ daily_date: today, daily_count: 0 });
  }
  return { count, limit: FREE_DAILY_LIMIT, isPremium };
}

async function incrementDailyCount() {
  const today = getToday();
  const data = await chrome.storage.local.get(['daily_date', 'daily_count']);
  const newCount = (data.daily_date === today ? (data.daily_count || 0) : 0) + 1;
  await chrome.storage.local.set({ daily_date: today, daily_count: newCount });
  return newCount;
}

function getToday() {
  return new Date().toISOString().split('T')[0];
}

// ---------------------------------------------------------------------------
// Premium key validation
// ---------------------------------------------------------------------------
async function activatePremium(key) {
  if (!key || typeof key !== 'string') return { success: false, error: 'INVALID_KEY' };
  const cleanKey = key.trim().toUpperCase();
  const isValid = await validatePremiumKey(cleanKey);
  if (isValid) {
    await chrome.storage.local.set({ premium: true, premium_key: cleanKey });
    return { success: true };
  }
  return { success: false, error: 'INVALID_KEY' };
}

async function validatePremiumKey(key) {
  const parts = key.split('-');
  if (parts.length !== 3 || parts[0] !== 'HVTR') return false;
  const data = parts[1];
  const providedHash = parts[2];
  if (data.length !== 8 || providedHash.length !== 8) return false;
  try {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', encoder.encode(HMAC_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', keyMaterial, encoder.encode(data));
    const hashHex = Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0')).join('')
      .substring(0, 8).toUpperCase();
    return hashHex === providedHash;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  enabled: true,
  provider: PROVIDER_MYMEMORY,   // 'mymemory' | 'libretranslate'
  targetLang: 'es',
  sourceLang: 'auto',
  email: '',                      // MyMemory: optional email for higher daily limit
  apiUrl: '',                     // LibreTranslate only
  apiKey: '',
  blacklist: [],
  hoverDelay: 400
};

async function getSettings() {
  const data = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
}

async function saveSettings(newSettings) {
  const current = await getSettings();
  const merged = { ...current, ...newSettings };
  await chrome.storage.local.set({ settings: merged });
  return { success: true, settings: merged };
}

// Translation cache
async function getCache(key) {
  try {
    const data = await chrome.storage.session.get(`cache_${key}`);
    return data[`cache_${key}`] || null;
  } catch { return null; }
}

async function setCache(key, value) {
  try {
    await chrome.storage.session.set({ [`cache_${key}`]: value });
  } catch { /* fail silently */ }
}
