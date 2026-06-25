// =============================================================================
// Hover Translator — Service Worker (background.js)
// =============================================================================
const HMAC_SECRET = '4b3513210b5222f854582282135d18e17aa7fd6d4f997801414a4565069ef503';

// URL del Cloudflare Worker de licencias.
// Actualiza esto con tu worker URL real (visible en el Cloudflare dashboard).
const LICENSE_WORKER_URL = 'https://hover-translator-licenses.daniel-marina.workers.dev';

const FREE_DAILY_LIMIT = 100;

// Cache version — bump this whenever extraction logic changes to invalidate stale entries.
const CACHE_VERSION = 133;

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

  // ── Function words early exit (multi-language) ────────────────────────────
  // Pronouns, particles and conjunctions whose removal restructures the sentence,
  // causing the diff pipeline to produce garbage (e.g. "man"→"hombre", "es"→wrong,
  // French "on"→wrong, Italian "si"→wrong).
  // We bypass the entire pipeline and return a hardcoded result.
  // Organised by source language; only fires when target is Spanish (es).
  // Other target languages fall through to the normal pipeline.
  {
    const _normTgt = (targetLang || '').split('-')[0].toLowerCase();
    const _normSrc = (sourceLang || '').split('-')[0].toLowerCase();
    const _srcFromPage = (pageLang || '').split('-')[0].toLowerCase();
    const _effectiveSrc = (_normSrc && _normSrc !== 'auto') ? _normSrc : _srcFromPage;

    if (!word.includes(' ') && _normTgt === 'es' && _effectiveSrc) {
      // pos: pron=pronombre, adv=adverbio, conj=conjunción, part=partícula
      const FUNC_WORDS_ES = {
        'de': {
          // Pronombres
          'man':     { t: 'uno',           alts: ['se', 'la gente', 'alguien'],     pos: 'pron.' },
          'es':      { t: 'ello',          alts: ['hay', 'se'],                      pos: 'pron.' },
          'sich':    { t: 'se',            alts: ['sí mismo', 'consigo mismo'],      pos: 'pron.' },
          'einem':   { t: 'a uno',         alts: ['le'],                             pos: 'pron.' },
          'einen':   { t: 'a uno',         alts: ['lo'],                             pos: 'pron.' },
          'etwas':   { t: 'algo',          alts: ['alguna cosa'],                    pos: 'pron.' },
          'jemand':  { t: 'alguien',       alts: ['alguna persona'],                 pos: 'pron.' },
          'nichts':  { t: 'nada',          alts: [],                                 pos: 'pron.' },
          // Adverbios
          'auch':    { t: 'también',       alts: ['además'],                         pos: 'adv.'  },
          'noch':    { t: 'todavía',       alts: ['aún', 'además'],                  pos: 'adv.'  },
          'schon':   { t: 'ya',            alts: ['de todas formas'],                pos: 'adv.'  },
          'nur':     { t: 'solo',          alts: ['únicamente', 'nada más'],         pos: 'adv.'  },
          'sehr':    { t: 'muy',           alts: ['mucho'],                          pos: 'adv.'  },
          'viel':    { t: 'mucho',         alts: ['bastante'],                       pos: 'adv.'  },
          'wenig':   { t: 'poco',          alts: ['escaso'],                         pos: 'adv.'  },
          'immer':   { t: 'siempre',       alts: ['cada vez'],                       pos: 'adv.'  },
          'nie':     { t: 'nunca',         alts: ['jamás'],                          pos: 'adv.'  },
          'niemals': { t: 'nunca',         alts: ['jamás'],                          pos: 'adv.'  },
          'jetzt':   { t: 'ahora',         alts: ['en este momento'],                pos: 'adv.'  },
          'hier':    { t: 'aquí',          alts: ['acá'],                            pos: 'adv.'  },
          'da':      { t: 'ahí',           alts: ['allí', 'entonces', 'ya que'],     pos: 'adv.'  },
          'dann':    { t: 'entonces',      alts: ['luego', 'después'],               pos: 'adv.'  },
          'so':      { t: 'así',           alts: ['tan', 'entonces'],                pos: 'adv.'  },
          'wie':     { t: 'cómo',          alts: ['como', 'cuánto'],                 pos: 'adv.'  },
          'wo':      { t: 'dónde',         alts: ['donde'],                          pos: 'adv.'  },
          'wann':    { t: 'cuándo',        alts: ['cuando'],                         pos: 'adv.'  },
          'warum':   { t: 'por qué',       alts: ['para qué'],                       pos: 'adv.'  },
          // Partículas modales (muy difíciles para el diff)
          'halt':    { t: 'simplemente',   alts: ['pues', 'ya'],                     pos: 'part.' },
          'mal':     { t: 'una vez',       alts: ['por favor', 'alguna vez'],        pos: 'part.' },
          'eben':    { t: 'justo',         alts: ['precisamente', 'simplemente'],    pos: 'part.' },
          'wohl':    { t: 'probablemente', alts: ['supongo que', 'seguramente'],     pos: 'part.' },
          'doch':    { t: 'pero sí',       alts: ['sin embargo', 'de todas formas'], pos: 'part.' },
          // Conjunciones
          'aber':    { t: 'pero',          alts: ['sin embargo'],                    pos: 'conj.' },
          'oder':    { t: 'o',             alts: ['u'],                              pos: 'conj.' },
          'denn':    { t: 'porque',        alts: ['pues', 'ya que'],                 pos: 'conj.' },
          'weil':    { t: 'porque',        alts: ['ya que', 'dado que'],             pos: 'conj.' },
          'wenn':    { t: 'cuando',        alts: ['si'],                             pos: 'conj.' },
          'ob':      { t: 'si',            alts: ['si acaso'],                       pos: 'conj.' },
          'dass':    { t: 'que',           alts: [],                                 pos: 'conj.' },
          'obwohl':  { t: 'aunque',        alts: ['a pesar de que'],                 pos: 'conj.' },
          'damit':   { t: 'para que',      alts: ['con eso'],                        pos: 'conj.' },
          'trotzdem':{ t: 'de todas formas',alts: ['sin embargo', 'aun así'],        pos: 'conj.' },
          'deshalb': { t: 'por eso',       alts: ['por eso mismo'],                  pos: 'conj.' },
    'weit':       { t: 'lejos',       alts: ['amplio', 'mucho', 'a lo lejos'],        pos: 'adv.'  },
    'weitgehend': { t: 'en gran medida', alts: ['ampliamente', 'en su mayor parte'],    pos: 'adv.'  },
    'weitaus':    { t: 'con mucho',    alts: ['ampliamente', 'en gran medida'],          pos: 'adv.'  },
    'angesichts': { t: 'ante',        alts: ['en vista de', 'dado', 'frente a'],        pos: 'prep.' },
    'aufgrund':   { t: 'debido a',    alts: ['a causa de', 'por'],                   pos: 'prep.' },
    'während':    { t: 'durante',     alts: ['mientras', 'a lo largo de'],            pos: 'conj.' },
    'trotz':      { t: 'a pesar de',  alts: ['pese a', 'aunque'],                    pos: 'prep.' },
    'laut':       { t: 'según',       alts: ['conforme a', 'de acuerdo con'],         pos: 'prep.' },
    'statt':      { t: 'en lugar de', alts: ['en vez de'],                            pos: 'prep.' },
    'gegenüber':  { t: 'frente a',    alts: ['ante', 'respecto a'],                  pos: 'prep.' },
    'innerhalb':  { t: 'dentro de',   alts: ['en el interior de'],                   pos: 'prep.' },
    'außerhalb':  { t: 'fuera de',    alts: ['más allá de'],                         pos: 'prep.' },
    'infolge':    { t: 'a consecuencia de', alts: ['como resultado de', 'debido a'], pos: 'prep.' },
    'mithilfe':   { t: 'con ayuda de', alts: ['mediante', 'gracias a'],              pos: 'prep.' },
      'novelle':        { t: 'enmienda',      alts: ['reforma', 'modificación legal'],       pos: 'sust.' },
      'stellungnahmen': { t: 'declaraciones', alts: ['posicionamientos', 'comentarios'],     pos: 'sust.' },
      'stellungnahme':  { t: 'declaración',   alts: ['posicionamiento', 'comentario'],       pos: 'sust.' },
      'eingetroffen':   { t: 'recibido',      alts: ['llegado'],                             pos: 'adj.'  },
      'eingetroffenen': { t: 'recibidas',     alts: ['llegadas'],                            pos: 'adj.'  },
      // German comparative/declined adjectives that start sentences (uppercase) but are NOT proper nouns
      'längere':   { t: 'más largo',    alts: ['más larga', 'mayor duración'],    pos: 'adj.'  },
      'längeren':  { t: 'más largos',   alts: ['más largas'],                     pos: 'adj.'  },
      'längerem':  { t: 'más largo',    alts: [],                                  pos: 'adj.'  },
      'längerer':  { t: 'más larga',    alts: ['de más duración'],                pos: 'adj.'  },
      'längeres':  { t: 'más largo',    alts: [],                                  pos: 'adj.'  },
      'längste':   { t: 'el más largo', alts: ['la más larga'],                   pos: 'adj.'  },
      'kürzere':   { t: 'más corto',    alts: ['más corta', 'más breve'],         pos: 'adj.'  },
      'kürzeren':  { t: 'más cortos',   alts: ['más cortas'],                     pos: 'adj.'  },
      'größere':   { t: 'mayor',        alts: ['más grande'],                     pos: 'adj.'  },
      'größeren':  { t: 'mayores',      alts: ['más grandes'],                    pos: 'adj.'  },
      'größerer':  { t: 'mayor',        alts: ['más grande'],                     pos: 'adj.'  },
      'kleinere':  { t: 'menor',        alts: ['más pequeño', 'más pequeña'],     pos: 'adj.'  },
      'kleineren': { t: 'menores',      alts: ['más pequeños'],                   pos: 'adj.'  },
      'weitere':   { t: 'adicional',    alts: ['más', 'otro', 'ulterior'],        pos: 'adj.'  },
      'weiteren':  { t: 'adicionales',  alts: ['más', 'otros'],                   pos: 'adj.'  },
      'weiterer':  { t: 'adicional',    alts: ['otro más'],                       pos: 'adj.'  },
      'frühere':   { t: 'anterior',     alts: ['previo', 'pasado'],               pos: 'adj.'  },
      'früheren':  { t: 'anteriores',   alts: ['previos', 'pasados'],             pos: 'adj.'  },
      'spätere':   { t: 'posterior',    alts: ['ulterior', 'futuro'],             pos: 'adj.'  },
      'späteren':  { t: 'posteriores',  alts: ['futuros'],                        pos: 'adj.'  },
      'höhere':    { t: 'mayor',        alts: ['más alto', 'superior'],           pos: 'adj.'  },
      'höheren':   { t: 'mayores',      alts: ['más altos', 'superiores'],        pos: 'adj.'  },
      'niedrigere':{ t: 'menor',        alts: ['más bajo', 'inferior'],           pos: 'adj.'  },
      'stärkere':  { t: 'más fuerte',   alts: ['mayor', 'más intenso'],          pos: 'adj.'  },
      'stärkeren': { t: 'más fuertes',  alts: ['mayores'],                        pos: 'adj.'  },
      'schnellere':{ t: 'más rápido',   alts: ['más veloz'],                      pos: 'adj.'  },
      'bessere':   { t: 'mejor',        alts: ['mejores'],                        pos: 'adj.'  },
      'besseren':  { t: 'mejores',      alts: [],                                  pos: 'adj.'  },
      'schlechtere':{ t: 'peor',        alts: ['peores'],                         pos: 'adj.'  },
      'geringere': { t: 'menor',        alts: ['más reducido', 'inferior'],       pos: 'adj.'  },
      'geringeren':{ t: 'menores',      alts: ['más reducidos'],                  pos: 'adj.'  },
      // German ordinal adjectives — never proper nouns
      'erster':   { t: 'primero',    alts: [],                                    pos: 'adj.'  },
      'erste':    { t: 'primero',    alts: ['primera'],                           pos: 'adj.'  },
      'ersten':   { t: 'primeros',   alts: ['primeras', 'primera'],               pos: 'adj.'  },
      'erstem':   { t: 'primero',    alts: [],                                    pos: 'adj.'  },
      'erstes':   { t: 'primero',    alts: [],                                    pos: 'adj.'  },
      'zweiter':  { t: 'segundo',    alts: [],                                    pos: 'adj.'  },
      'zweite':   { t: 'segundo',    alts: ['segunda'],                           pos: 'adj.'  },
      'zweiten':  { t: 'segundos',   alts: ['segunda'],                           pos: 'adj.'  },
      'dritter':  { t: 'tercero',    alts: [],                                    pos: 'adj.'  },
      'dritte':   { t: 'tercero',    alts: ['tercera'],                           pos: 'adj.'  },
      'dritten':  { t: 'terceros',   alts: ['tercera'],                           pos: 'adj.'  },
      'vierter':  { t: 'cuarto',     alts: [],                                    pos: 'adj.'  },
      'vierte':   { t: 'cuarto',     alts: ['cuarta'],                            pos: 'adj.'  },
      'vierten':  { t: 'cuartos',    alts: [],                                    pos: 'adj.'  },
      'fünfter':  { t: 'quinto',     alts: [],                                    pos: 'adj.'  },
      'fünfte':   { t: 'quinto',     alts: ['quinta'],                            pos: 'adj.'  },
      'letzter':  { t: 'último',     alts: [],                                    pos: 'adj.'  },
      'letzte':   { t: 'último',     alts: ['última'],                            pos: 'adj.'  },
      'letzten':  { t: 'últimos',    alts: ['última'],                            pos: 'adj.'  },
      'nächster': { t: 'próximo',    alts: [],                                    pos: 'adj.'  },
      'nächste':  { t: 'próximo',    alts: ['próxima'],                           pos: 'adj.'  },
      'nächsten': { t: 'próximos',   alts: ['siguiente'],                         pos: 'adj.'  },
      // Common German verb infinitives — GT often mistranslates these in short contexts
      'wirken':   { t: 'actuar',      alts: ['funcionar', 'tener efecto'],        pos: 'v.'    },
      'wirkt':    { t: 'actúa',       alts: ['funciona', 'tiene efecto'],          pos: 'v.'    },
      'wirken auf':{ t: 'afectar a',  alts: ['influir en'],                        pos: 'v.'    },
      'steigen':  { t: 'subir',       alts: ['aumentar', 'ascender'],              pos: 'v.'    },
      'steigt':   { t: 'sube',        alts: ['aumenta'],                           pos: 'v.'    },
      'sinken':   { t: 'bajar',       alts: ['descender', 'disminuir'],            pos: 'v.'    },
      'sinkt':    { t: 'baja',        alts: ['desciende', 'disminuye'],            pos: 'v.'    },
      'wachsen':  { t: 'crecer',      alts: ['aumentar'],                          pos: 'v.'    },
      'wächst':   { t: 'crece',       alts: ['aumenta'],                           pos: 'v.'    },
      'fallen':   { t: 'caer',        alts: ['bajar', 'descender'],                pos: 'v.'    },
      'fällt':    { t: 'cae',         alts: ['baja'],                              pos: 'v.'    },
      'fordern':  { t: 'exigir',      alts: ['reclamar', 'pedir'],                 pos: 'v.'    },
      'fordert':  { t: 'exige',       alts: ['reclama', 'pide'],                   pos: 'v.'    },
      'warnen':   { t: 'advertir',    alts: ['alertar'],                           pos: 'v.'    },
      'warnt':    { t: 'advierte',    alts: ['alerta'],                            pos: 'v.'    },
      'drohen':   { t: 'amenazar',    alts: ['arriesgar'],                         pos: 'v.'    },
      'droht':    { t: 'amenaza',     alts: ['pende'],                             pos: 'v.'    },
      'scheitern':{ t: 'fracasar',    alts: ['fallar'],                            pos: 'v.'    },
      'scheitert':{ t: 'fracasa',     alts: ['falla'],                             pos: 'v.'    },
      'kämpfen':  { t: 'luchar',      alts: ['combatir', 'pelear'],                pos: 'v.'    },
      'kämpft':   { t: 'lucha',       alts: ['combate'],                           pos: 'v.'    },
      'treffen':  { t: 'encontrarse', alts: ['reunirse', 'acordar'],               pos: 'v.'    },
      'trifft':   { t: 'se encuentra',alts: ['reúne', 'acuerda'],                  pos: 'v.'    },
      'einigen':  { t: 'acordar',     alts: ['ponerse de acuerdo'],                pos: 'v.'    },
      'einigt':   { t: 'acuerda',     alts: ['se pone de acuerdo'],                pos: 'v.'    },
      'belasten': { t: 'perjudicar',  alts: ['gravar', 'cargar'],                  pos: 'v.'    },
      'belastet': { t: 'perjudica',   alts: ['grava', 'carga'],                    pos: 'v.'    },
      'betreffen':{ t: 'afectar',     alts: ['concernir'],                         pos: 'v.'    },
      'betrifft': { t: 'afecta',      alts: ['concierne'],                         pos: 'v.'    },
      // German strong verb Präteritum (irregular past tense) — GT often mistranslates these
      // because they look like unrelated words (e.g. "stieg"→"rose"→"rosa")
      'stieg':    { t: 'subió',       alts: ['aumentó', 'ascendió'],              pos: 'v.'    },
      'stiegen':  { t: 'subieron',    alts: ['aumentaron'],                       pos: 'v.'    },
      'fiel':     { t: 'cayó',        alts: ['bajó', 'descendió'],                pos: 'v.'    },
      'fielen':   { t: 'cayeron',     alts: ['bajaron'],                          pos: 'v.'    },
      'sank':     { t: 'bajó',        alts: ['cayó', 'descendió'],                pos: 'v.'    },
      'sanken':   { t: 'bajaron',     alts: ['cayeron'],                          pos: 'v.'    },
      'stieg an': { t: 'aumentó',     alts: ['subió'],                            pos: 'v.'    },
      'wuchs':    { t: 'creció',      alts: ['aumentó'],                          pos: 'v.'    },
      'wuchsen':  { t: 'crecieron',   alts: ['aumentaron'],                       pos: 'v.'    },
      'kam':      { t: 'llegó',       alts: ['vino'],                             pos: 'v.'    },
      'kamen':    { t: 'llegaron',    alts: ['vinieron'],                         pos: 'v.'    },
      'ging':     { t: 'fue',         alts: ['marchó', 'se fue'],                 pos: 'v.'    },
      'gingen':   { t: 'fueron',      alts: ['marcharon'],                        pos: 'v.'    },
      'stand':    { t: 'estuvo',      alts: ['estaba', 'se encontraba'],          pos: 'v.'    },
      'standen':  { t: 'estuvieron',  alts: ['estaban'],                          pos: 'v.'    },
      'war':      { t: 'era',         alts: ['fue', 'estaba'],                    pos: 'v.'    },
      'waren':    { t: 'eran',        alts: ['fueron', 'estaban'],                pos: 'v.'    },
      'hatte':    { t: 'tenía',       alts: ['tuvo'],                             pos: 'v.'    },
      'hatten':   { t: 'tenían',      alts: ['tuvieron'],                         pos: 'v.'    },
      'wurde':    { t: 'fue',         alts: ['se convirtió', 'resultó'],          pos: 'v.'    },
      'wurden':   { t: 'fueron',      alts: ['se convirtieron'],                  pos: 'v.'    },
      'blieb':    { t: 'quedó',       alts: ['permaneció', 'siguió'],             pos: 'v.'    },
      'blieben':  { t: 'quedaron',    alts: ['permanecieron'],                    pos: 'v.'    },
      'brachte':  { t: 'trajo',       alts: ['llevó'],                            pos: 'v.'    },
      'brachten': { t: 'trajeron',    alts: ['llevaron'],                         pos: 'v.'    },
      'sprach':   { t: 'habló',       alts: ['dijo'],                             pos: 'v.'    },
      'sprachen': { t: 'hablaron',    alts: ['dijeron'],                          pos: 'v.'    },
      'zog':      { t: 'se fue',      alts: ['se trasladó', 'atrajo'],            pos: 'v.'    },
      'zogen':    { t: 'se fueron',   alts: ['se trasladaron'],                   pos: 'v.'    },
      'brach':    { t: 'rompió',      alts: ['estalló', 'quebró'],                pos: 'v.'    },
      'brachen':  { t: 'rompieron',   alts: ['estallaron'],                       pos: 'v.'    },
      'starb':    { t: 'murió',       alts: ['falleció'],                         pos: 'v.'    },
      'starben':  { t: 'murieron',    alts: ['fallecieron'],                      pos: 'v.'    },
      'nahm':     { t: 'tomó',        alts: ['asumió', 'aceptó'],                 pos: 'v.'    },
      'nahmen':   { t: 'tomaron',     alts: ['asumieron'],                        pos: 'v.'    },
      'gab':      { t: 'dio',         alts: ['hubo', 'había'],                    pos: 'v.'    },
      'gaben':    { t: 'dieron',      alts: [],                                    pos: 'v.'    },
      'sah':      { t: 'vio',         alts: ['observó'],                          pos: 'v.'    },
      'sahen':    { t: 'vieron',      alts: [],                                    pos: 'v.'    },
      'hielt':    { t: 'mantuvo',     alts: ['celebró', 'sostuvo'],               pos: 'v.'    },
      'hielten':  { t: 'mantuvieron', alts: ['celebraron'],                       pos: 'v.'    },
      'ließ':     { t: 'dejó',        alts: ['permitió', 'mandó'],                pos: 'v.'    },
      'ließen':   { t: 'dejaron',     alts: ['permitieron'],                      pos: 'v.'    },
      'traf':     { t: 'encontró',    alts: ['se reunió con', 'golpeó'],          pos: 'v.'    },
      'trafen':   { t: 'encontraron', alts: ['se reunieron'],                     pos: 'v.'    },
      'fand':     { t: 'encontró',    alts: ['halló'],                            pos: 'v.'    },
      'fanden':   { t: 'encontraron', alts: ['hallaron'],                         pos: 'v.'    },
      'schloss':  { t: 'cerró',       alts: ['concluyó', 'firmó'],                pos: 'v.'    },
      'schlossen':{ t: 'cerraron',    alts: ['concluyeron'],                      pos: 'v.'    },
      'warf':     { t: 'lanzó',       alts: ['tiró', 'arrojó'],                   pos: 'v.'    },
      'warfen':   { t: 'lanzaron',    alts: [],                                    pos: 'v.'    },
      'rief':     { t: 'llamó',       alts: ['convocó', 'gritó'],                 pos: 'v.'    },
      'riefen':   { t: 'llamaron',    alts: [],                                    pos: 'v.'    },
      'schrieb':  { t: 'escribió',    alts: ['redactó'],                          pos: 'v.'    },
      'schrieben':{ t: 'escribieron', alts: [],                                    pos: 'v.'    },
      'lief':     { t: 'corrió',      alts: ['funcionó', 'fue'],                  pos: 'v.'    },
      'liefen':   { t: 'corrieron',   alts: ['funcionaron'],                      pos: 'v.'    },
      'zeigte':   { t: 'mostró',      alts: ['indicó', 'señaló'],                 pos: 'v.'    },
      'zeigten':  { t: 'mostraron',   alts: ['indicaron'],                        pos: 'v.'    },
      // German past participles used as predicate verbs in headlines (ge-...-en forms)
      'geborgen':  { t: 'rescatado',    alts: ['recuperado', 'puesto a salvo'],   pos: 'v.'    },
      'gefunden':  { t: 'encontrado',   alts: ['hallado'],                        pos: 'v.'    },
      'gestorben': { t: 'fallecido',    alts: ['muerto', 'ha muerto'],            pos: 'v.'    },
      'getötet':   { t: 'muerto',       alts: ['asesinado', 'matado'],            pos: 'v.'    },
      'verhaftet': { t: 'arrestado',    alts: ['detenido'],                       pos: 'v.'    },
      'festgenommen': { t: 'detenido',  alts: ['arrestado'],                      pos: 'v.'    },
      'verletzt':  { t: 'herido',       alts: ['lesionado'],                      pos: 'v.'    },
      'verloren':  { t: 'perdido',      alts: ['extraviado'],                     pos: 'v.'    },
      'gewonnen':  { t: 'ganado',       alts: ['conquistado'],                    pos: 'v.'    },
      'geschlossen':{ t: 'cerrado',     alts: ['clausurado'],                     pos: 'v.'    },
      'geöffnet':  { t: 'abierto',      alts: ['inaugurado'],                     pos: 'v.'    },
      'gestürzt':  { t: 'caído',        alts: ['derrocado', 'se ha caído'],       pos: 'v.'    },
      'entlassen': { t: 'despedido',    alts: ['liberado', 'dado de alta'],       pos: 'v.'    },
      'gesperrt':  { t: 'bloqueado',    alts: ['cerrado', 'prohibido'],           pos: 'v.'    },
      'genehmigt': { t: 'aprobado',     alts: ['autorizado'],                     pos: 'v.'    },
      'abgelehnt': { t: 'rechazado',    alts: ['denegado'],                       pos: 'v.'    },
      'beschlossen':{ t: 'decidido',    alts: ['acordado', 'resuelto'],           pos: 'v.'    },
      'angeklagt': { t: 'acusado',      alts: ['imputado'],                       pos: 'v.'    },
      'verurteilt':{ t: 'condenado',    alts: ['sentenciado'],                    pos: 'v.'    },
      'freigesprochen': { t: 'absuelto', alts: ['declarado inocente'],            pos: 'v.'    },
      'gestohlen': { t: 'robado',       alts: ['hurtado'],                        pos: 'v.'    },
      'gerettet':  { t: 'rescatado',    alts: ['salvado'],                        pos: 'v.'    },
      'ertrunken': { t: 'ahogado',      alts: ['muerto por ahogamiento'],         pos: 'v.'    },
      'verunglückt':{ t: 'accidentado', alts: ['herido en accidente', 'fallecido en accidente'], pos: 'v.' },
          'deswegen':{ t: 'por eso',       alts: ['por esa razón'],                  pos: 'conj.' },
          'außerdem':{ t: 'además',        alts: ['por otro lado'],                  pos: 'conj.' },
          // Correlativas y grados
          'je':      { t: 'alguna vez',    alts: ['nunca', 'en absoluto'],           pos: 'adv.'  },
          'desto':   { t: 'más',           alts: ['cuanto más... más', 'tanto más'], pos: 'conj.' },
          'umso':    { t: 'tanto más',     alts: ['aún más', 'cuanto más'],          pos: 'conj.' },
        },
        'fr': {
          // Pronombres
          'on':      { t: 'uno',           alts: ['se', 'la gente', 'nosotros'],     pos: 'pron.' },
          'y':       { t: 'allí',          alts: ['hay', 'ahí'],                     pos: 'pron.' },
          'en':      { t: 'de ello',       alts: ['en', 'de ahí'],                   pos: 'pron.' },
          'se':      { t: 'se',            alts: ['sí mismo'],                       pos: 'pron.' },
          'dont':    { t: 'cuyo',          alts: ['del que', 'de quien'],             pos: 'pron.' },
          'rien':    { t: 'nada',          alts: [],                                  pos: 'pron.' },
          // Adverbios
          'aussi':   { t: 'también',       alts: ['además', 'así que'],              pos: 'adv.'  },
          'même':    { t: 'mismo',         alts: ['incluso', 'hasta'],               pos: 'adv.'  },
          'encore':  { t: 'todavía',       alts: ['aún', 'otra vez'],                pos: 'adv.'  },
          'déjà':    { t: 'ya',            alts: ['alguna vez'],                     pos: 'adv.'  },
          'jamais':  { t: 'nunca',         alts: ['jamás'],                          pos: 'adv.'  },
          'toujours':{ t: 'siempre',       alts: ['todavía', 'aún'],                 pos: 'adv.'  },
          'très':    { t: 'muy',           alts: ['bastante'],                       pos: 'adv.'  },
          'trop':    { t: 'demasiado',     alts: ['muy'],                            pos: 'adv.'  },
          'peu':     { t: 'poco',          alts: ['apenas'],                         pos: 'adv.'  },
          'beaucoup':{ t: 'mucho',         alts: ['bastante'],                       pos: 'adv.'  },
          'bien':    { t: 'bien',          alts: ['muy', 'bastante'],                pos: 'adv.'  },
          // Conjunciones / partículas
          'ne':      { t: 'no',            alts: [],                                  pos: 'part.' },
          'si':      { t: 'si',            alts: ['sí'],                             pos: 'conj.' },
          'donc':    { t: 'entonces',      alts: ['por tanto', 'así que'],           pos: 'conj.' },
          'car':     { t: 'porque',        alts: ['pues', 'ya que'],                 pos: 'conj.' },
          'pourtant':{ t: 'sin embargo',   alts: ['no obstante', 'aun así'],         pos: 'conj.' },
          'cependant':{ t: 'sin embargo',  alts: ['no obstante'],                    pos: 'conj.' },
          'or':      { t: 'ahora bien',    alts: ['pero', 'sin embargo'],            pos: 'conj.' },
        },
        'it': {
          // Pronombres
          'si':      { t: 'se',            alts: ['uno', 'sí mismo'],                pos: 'pron.' },
          'ci':      { t: 'nos',           alts: ['allí', 'ahí'],                    pos: 'pron.' },
          'vi':      { t: 'os',            alts: ['allí', 'ahí'],                    pos: 'pron.' },
          'ne':      { t: 'de ello',       alts: ['de ahí'],                         pos: 'pron.' },
          'niente':  { t: 'nada',          alts: [],                                  pos: 'pron.' },
          'nulla':   { t: 'nada',          alts: [],                                  pos: 'pron.' },
          'qualcosa':{ t: 'algo',          alts: ['alguna cosa'],                    pos: 'pron.' },
          'qualcuno':{ t: 'alguien',       alts: ['alguna persona'],                 pos: 'pron.' },
          // Adverbios
          'già':     { t: 'ya',            alts: ['antes'],                          pos: 'adv.'  },
          'ancora':  { t: 'todavía',       alts: ['aún', 'otra vez'],                pos: 'adv.'  },
          'sempre':  { t: 'siempre',       alts: [],                                  pos: 'adv.'  },
          'mai':     { t: 'nunca',         alts: ['jamás'],                          pos: 'adv.'  },
          'anche':   { t: 'también',       alts: ['incluso'],                        pos: 'adv.'  },
          'molto':   { t: 'muy',           alts: ['mucho'],                          pos: 'adv.'  },
          'poco':    { t: 'poco',          alts: ['apenas'],                         pos: 'adv.'  },
          'troppo':  { t: 'demasiado',     alts: ['muy'],                            pos: 'adv.'  },
          // Conjunciones
          'però':    { t: 'pero',          alts: ['sin embargo'],                    pos: 'conj.' },
          'dunque':  { t: 'entonces',      alts: ['por tanto'],                      pos: 'conj.' },
          'quindi':  { t: 'entonces',      alts: ['por tanto', 'así que'],           pos: 'conj.' },
          'poiché':  { t: 'porque',        alts: ['ya que', 'dado que'],             pos: 'conj.' },
          'tuttavia':{ t: 'sin embargo',   alts: ['no obstante', 'aun así'],         pos: 'conj.' },
          'eppure':  { t: 'sin embargo',   alts: ['aun así'],                        pos: 'conj.' },
        },
        'pt': {
          // Pronombres
          'se':      { t: 'se',            alts: ['sí mismo'],                       pos: 'pron.' },
          'lhe':     { t: 'le',            alts: ['os'],                             pos: 'pron.' },
          'lhes':    { t: 'les',           alts: [],                                  pos: 'pron.' },
          'nada':    { t: 'nada',          alts: [],                                  pos: 'pron.' },
          'algo':    { t: 'algo',          alts: [],                                  pos: 'pron.' },
          'alguém':  { t: 'alguien',       alts: [],                                  pos: 'pron.' },
          'ninguém': { t: 'nadie',         alts: [],                                  pos: 'pron.' },
          // Adverbios
          'já':      { t: 'ya',            alts: [],                                  pos: 'adv.'  },
          'ainda':   { t: 'todavía',       alts: ['aún'],                            pos: 'adv.'  },
          'sempre':  { t: 'siempre',       alts: [],                                  pos: 'adv.'  },
          'nunca':   { t: 'nunca',         alts: ['jamás'],                          pos: 'adv.'  },
          'também':  { t: 'también',       alts: ['además'],                         pos: 'adv.'  },
          'muito':   { t: 'muy',           alts: ['mucho'],                          pos: 'adv.'  },
          'pouco':   { t: 'poco',          alts: [],                                  pos: 'adv.'  },
          // Conjunciones
          'mas':     { t: 'pero',          alts: ['sin embargo'],                    pos: 'conj.' },
          'pois':    { t: 'porque',        alts: ['pues', 'ya que'],                 pos: 'conj.' },
          'porém':   { t: 'sin embargo',   alts: ['no obstante'],                    pos: 'conj.' },
          'contudo': { t: 'sin embargo',   alts: ['no obstante', 'aun así'],         pos: 'conj.' },
          'portanto':{ t: 'por tanto',     alts: ['entonces', 'así que'],            pos: 'conj.' },
          'embora':  { t: 'aunque',        alts: ['a pesar de que'],                 pos: 'conj.' },
        },
        'nl': {
          // Pronombres
          'men':     { t: 'uno',           alts: ['se', 'la gente'],                 pos: 'pron.' },
          'er':      { t: 'allí',          alts: ['hay', 'ello'],                    pos: 'pron.' },
          'zich':    { t: 'se',            alts: ['sí mismo'],                       pos: 'pron.' },
          'iets':    { t: 'algo',          alts: [],                                  pos: 'pron.' },
          'iemand':  { t: 'alguien',       alts: [],                                  pos: 'pron.' },
          'niets':   { t: 'nada',          alts: [],                                  pos: 'pron.' },
          // Adverbios
          'ook':     { t: 'también',       alts: ['además'],                         pos: 'adv.'  },
          'nog':     { t: 'todavía',       alts: ['aún', 'además'],                  pos: 'adv.'  },
          'al':      { t: 'ya',            alts: ['todos'],                           pos: 'adv.'  },
          'heel':    { t: 'muy',           alts: ['bastante'],                       pos: 'adv.'  },
          'erg':     { t: 'muy',           alts: ['bastante'],                       pos: 'adv.'  },
          'weinig':  { t: 'poco',          alts: [],                                  pos: 'adv.'  },
          'veel':    { t: 'mucho',         alts: ['bastante'],                       pos: 'adv.'  },
          'nooit':   { t: 'nunca',         alts: ['jamás'],                          pos: 'adv.'  },
          'altijd':  { t: 'siempre',       alts: [],                                  pos: 'adv.'  },
          // Conjunciones
          'maar':    { t: 'pero',          alts: ['sin embargo', 'solo'],            pos: 'conj.' },
          'dus':     { t: 'entonces',      alts: ['por tanto'],                      pos: 'conj.' },
          'want':    { t: 'porque',        alts: ['pues'],                           pos: 'conj.' },
          'hoewel':  { t: 'aunque',        alts: ['a pesar de que'],                 pos: 'conj.' },
          'toch':    { t: 'sin embargo',   alts: ['de todas formas', 'aun así'],     pos: 'conj.' },
        },
      };

      const _langWords = FUNC_WORDS_ES[_effectiveSrc];
      if (_langWords) {
        const _wordLow = word.toLowerCase();
        // "je ... desto/umso" correlative: "Je mehr... desto mehr" = "Cuanto más... más"
        if (_wordLow === 'je' && _effectiveSrc === 'de' && /\b(desto|umso)\b/i.test(sentence || '')) {
          return {
            translation: 'cuanto',
            alternatives: ['cuanto más...', 'entre... más'],
            translatable: true, sameLanguage: false, definition: null,
            extractedTranslation: null, contextPhrase: context || null,
            contextTranslation: null, sentenceTranslation: null, sentenceExtracted: null,
            posGroups: [{ pos: 'conj.', translations: ['cuanto', 'cuanto más...', 'entre... más'] }],
            isGermanPage: true, isGermanNoun: false,
          };
        }
        const _entry = _langWords[_wordLow];
        if (_entry) {
          // Translate context phrase so the tooltip can show it in the target language
          let _ctxTranslation = null;
          const _ctxSource = sentence || context || null;
          if (_ctxSource && targetLang && _effectiveSrc && _effectiveSrc !== targetLang) {
            try {
              const _ctxRes = await fetch(
                `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${_effectiveSrc}&tl=${targetLang}&dt=t&q=${encodeURIComponent(_ctxSource)}`
              );
              if (_ctxRes.ok) {
                const _ctxData = await _ctxRes.json();
                _ctxTranslation = (_ctxData[0] || []).map(t => t?.[0] || '').join('').trim() || null;
              }
            } catch {}
          }
          return {
            translation: _entry.t,
            alternatives: _entry.alts,
            translatable: true,
            sameLanguage: false,
            definition: null,
            extractedTranslation: null,
            contextPhrase: context || null,
            contextTranslation: _ctxTranslation,
            sentenceTranslation: _ctxTranslation,
            sentenceExtracted: null,
            posGroups: [{ pos: _entry.pos, translations: [_entry.t, ..._entry.alts] }],
            isGermanPage: _effectiveSrc === 'de',
            isGermanNoun: false,
          };
        }
      }
    }
  }

  // Multi-word capitalized phrases in Title Case ("Lionel Messi", "Donald Trump", "New York")
  // are proper nouns assembled by content.js — translating them gives wrong results.
  // Exception: ALL-CAPS phrases ("JUST NU", "BREAKING NEWS") are headline labels, not names —
  // they must be translated normally.
  const isAllCaps = word === word.toUpperCase() && /[A-ZÀ-Ö]/.test(word);

  // Hardcoded table for common non-English acronyms that Wikipedia search misidentifies.
  // Defined here (top of function) so both isSingleAcronym and isMultiWordProperNoun can use it.
  // Format: { wiki: 'English Wikipedia title', names: { de, en, fr, es, it, pt, nl, sv, pl, ro } }
  // Always fetch wiki from English Wikipedia (en) — non-English titles differ per language.
  const MULTILANG_ACRONYMS = {
    // ── European Union ──
    'UE':   { wiki: 'European Union',              names: { de: 'EU',         en: 'EU',          fr: 'UE',         es: 'UE',    it: 'UE',    pt: 'UE',    nl: 'EU',      sv: 'EU',          pl: 'UE',    ro: 'UE'  } },
    'EU':   { wiki: 'European Union',              names: { de: 'EU',         en: 'EU',          fr: 'UE',         es: 'UE',    it: 'UE',    pt: 'UE',    nl: 'EU',      sv: 'EU',          pl: 'UE',    ro: 'UE'  } },
    // ── United Nations ──
    'ONU':  { wiki: 'United Nations',              names: { de: 'UNO',        en: 'UN',          fr: 'ONU',        es: 'ONU',   it: 'ONU',   pt: 'ONU',   nl: 'VN',      sv: 'FN',          pl: 'ONZ',   ro: 'ONU' } },
    'UN':   { wiki: 'United Nations',              names: { de: 'UNO',        en: 'UN',          fr: 'ONU',        es: 'ONU',   it: 'ONU',   pt: 'ONU',   nl: 'VN',      sv: 'FN',          pl: 'ONZ',   ro: 'ONU' } },
    'UNO':  { wiki: 'United Nations',              names: { de: 'UNO',        en: 'UN',          fr: 'ONU',        es: 'ONU',   it: 'ONU',   pt: 'ONU',   nl: 'VN',      sv: 'FN',          pl: 'ONZ',   ro: 'ONU' } },
    // ── NATO ──
    'OTAN': { wiki: 'NATO',                        names: { de: 'NATO',       en: 'NATO',        fr: 'OTAN',       es: 'OTAN',  it: 'NATO',  pt: 'NATO',  nl: 'NAVO',    sv: 'NATO',        pl: 'NATO',  ro: 'NATO'} },
    'NATO': { wiki: 'NATO',                        names: { de: 'NATO',       en: 'NATO',        fr: 'OTAN',       es: 'OTAN',  it: 'NATO',  pt: 'NATO',  nl: 'NAVO',    sv: 'NATO',        pl: 'NATO',  ro: 'NATO'} },
    'NAVO': { wiki: 'NATO',                        names: { de: 'NATO',       en: 'NATO',        fr: 'OTAN',       es: 'OTAN',  it: 'NATO',  pt: 'NATO',  nl: 'NAVO',    sv: 'NATO',        pl: 'NATO',  ro: 'NATO'} },
    // ── World Health Organization ──
    'OMS':  { wiki: 'World Health Organization',   names: { de: 'WHO',        en: 'WHO',         fr: 'OMS',        es: 'OMS',   it: 'OMS',   pt: 'OMS',   nl: 'WHO',     sv: 'WHO',         pl: 'WHO',   ro: 'OMS' } },
    'WHO':  { wiki: 'World Health Organization',   names: { de: 'WHO',        en: 'WHO',         fr: 'OMS',        es: 'OMS',   it: 'OMS',   pt: 'OMS',   nl: 'WHO',     sv: 'WHO',         pl: 'WHO',   ro: 'OMS' } },
    // ── International Monetary Fund ──
    'FMI':  { wiki: 'International Monetary Fund', names: { de: 'IWF',        en: 'IMF',         fr: 'FMI',        es: 'FMI',   it: 'FMI',   pt: 'FMI',   nl: 'IMF',     sv: 'IMF',         pl: 'MFW',   ro: 'FMI' } },
    'IMF':  { wiki: 'International Monetary Fund', names: { de: 'IWF',        en: 'IMF',         fr: 'FMI',        es: 'FMI',   it: 'FMI',   pt: 'FMI',   nl: 'IMF',     sv: 'IMF',         pl: 'MFW',   ro: 'FMI' } },
    'IWF':  { wiki: 'International Monetary Fund', names: { de: 'IWF',        en: 'IMF',         fr: 'FMI',        es: 'FMI',   it: 'FMI',   pt: 'FMI',   nl: 'IMF',     sv: 'IMF',         pl: 'MFW',   ro: 'FMI' } },
    // ── European Central Bank ──
    'BCE':  { wiki: 'European Central Bank',       names: { de: 'EZB',        en: 'ECB',         fr: 'BCE',        es: 'BCE',   it: 'BCE',   pt: 'BCE',   nl: 'ECB',     sv: 'ECB',         pl: 'EBC',   ro: 'BCE' } },
    'ECB':  { wiki: 'European Central Bank',       names: { de: 'EZB',        en: 'ECB',         fr: 'BCE',        es: 'BCE',   it: 'BCE',   pt: 'BCE',   nl: 'ECB',     sv: 'ECB',         pl: 'EBC',   ro: 'BCE' } },
    'EZB':  { wiki: 'European Central Bank',       names: { de: 'EZB',        en: 'ECB',         fr: 'BCE',        es: 'BCE',   it: 'BCE',   pt: 'BCE',   nl: 'ECB',     sv: 'ECB',         pl: 'EBC',   ro: 'BCE' } },
    // ── GDP / PIB ──
    'PIB':  { wiki: 'Gross domestic product',      names: { de: 'BIP',        en: 'GDP',         fr: 'PIB',        es: 'PIB',   it: 'PIL',   pt: 'PIB',   nl: 'bbp',     sv: 'BNP',         pl: 'PKB',   ro: 'PIB' } },
    'PIL':  { wiki: 'Gross domestic product',      names: { de: 'BIP',        en: 'GDP',         fr: 'PIB',        es: 'PIB',   it: 'PIL',   pt: 'PIB',   nl: 'bbp',     sv: 'BNP',         pl: 'PKB',   ro: 'PIB' } },
    'GDP':  { wiki: 'Gross domestic product',      names: { de: 'BIP',        en: 'GDP',         fr: 'PIB',        es: 'PIB',   it: 'PIL',   pt: 'PIB',   nl: 'bbp',     sv: 'BNP',         pl: 'PKB',   ro: 'PIB' } },
    'BIP':  { wiki: 'Gross domestic product',      names: { de: 'BIP',        en: 'GDP',         fr: 'PIB',        es: 'PIB',   it: 'PIL',   pt: 'PIB',   nl: 'bbp',     sv: 'BNP',         pl: 'PKB',   ro: 'PIB' } },
    // ── GNP / PNB ──
    'PNB':  { wiki: 'Gross national product',      names: { de: 'BSP',        en: 'GNP',         fr: 'PNB',        es: 'PNB',   it: 'PNL',   pt: 'PNB',   nl: 'BNP',     sv: 'BNI',         pl: 'PNB' } },
    'GNP':  { wiki: 'Gross national product',      names: { de: 'BSP',        en: 'GNP',         fr: 'PNB',        es: 'PNB',   it: 'PNL',   pt: 'PNB',   nl: 'BNP',     sv: 'BNI',         pl: 'PNB' } },
    // ── World Bank ──
    'BM':   { wiki: 'World Bank',                  names: { de: 'Weltbank',   en: 'World Bank',  fr: 'BM',         es: 'BM',    it: 'BM',    pt: 'BM',    nl: 'Wereldbank', sv: 'Världsbanken', pl: 'Bank Światowy' } },
    // ── Eurozone ──
    'UME':  { wiki: 'Eurozone',                    names: { de: 'Eurozone',   en: 'Eurozone',    fr: 'Zone euro',  es: 'UME',   it: 'UEM',   pt: 'UME',   nl: 'Eurozone', sv: 'Euroområdet' } },
    // ── United States ──
    'EEUU': { wiki: 'United States',               names: { de: 'USA',        en: 'USA',         fr: 'États-Unis', es: 'EEUU',  it: 'USA',   pt: 'EUA',   nl: 'VS',      sv: 'USA',         pl: 'USA',   ro: 'SUA' } },
    'EUA':  { wiki: 'United States',               names: { de: 'USA',        en: 'USA',         fr: 'États-Unis', es: 'EEUU',  it: 'USA',   pt: 'EUA',   nl: 'VS',      sv: 'USA',         pl: 'USA',   ro: 'SUA' } },
    'USA':  { wiki: 'United States',               names: { de: 'USA',        en: 'USA',         fr: 'États-Unis', es: 'EEUU',  it: 'USA',   pt: 'EUA',   nl: 'VS',      sv: 'USA',         pl: 'USA',   ro: 'SUA' } },
    // ── United Kingdom ──
    'RU':   { wiki: 'United Kingdom',              names: { de: 'UK',         en: 'UK',          fr: 'RU',         es: 'RU',    it: 'UK',    pt: 'RU',    nl: 'VK',      sv: 'UK',          pl: 'UK',    ro: 'RU'  } },
    'UK':   { wiki: 'United Kingdom',              names: { de: 'UK',         en: 'UK',          fr: 'RU',         es: 'RU',    it: 'UK',    pt: 'RU',    nl: 'VK',      sv: 'UK',          pl: 'UK',    ro: 'RU'  } },
    // ── VAT / IVA ──
    'IVA':  { wiki: 'Value-added tax',             names: { de: 'MwSt.',      en: 'VAT',         fr: 'TVA',        es: 'IVA',   it: 'IVA',   pt: 'IVA',   nl: 'btw',     sv: 'moms',        pl: 'VAT',   ro: 'TVA' } },
    'TVA':  { wiki: 'Value-added tax',             names: { de: 'MwSt.',      en: 'VAT',         fr: 'TVA',        es: 'IVA',   it: 'IVA',   pt: 'IVA',   nl: 'btw',     sv: 'moms',        pl: 'VAT',   ro: 'TVA' } },
    'VAT':  { wiki: 'Value-added tax',             names: { de: 'MwSt.',      en: 'VAT',         fr: 'TVA',        es: 'IVA',   it: 'IVA',   pt: 'IVA',   nl: 'btw',     sv: 'moms',        pl: 'VAT',   ro: 'TVA' } },
    // ── DNA / ADN ──
    'ADN':  { wiki: 'DNA',                         names: { de: 'DNS',        en: 'DNA',         fr: 'ADN',        es: 'ADN',   it: 'DNA',   pt: 'ADN',   nl: 'DNA',     sv: 'DNA',         pl: 'DNA' } },
    'ARN':  { wiki: 'RNA',                         names: { de: 'RNS',        en: 'RNA',         fr: 'ARN',        es: 'ARN',   it: 'RNA',   pt: 'ARN',   nl: 'RNA',     sv: 'RNA',         pl: 'RNA' } },
    // ── HIV / AIDS ──
    'VIH':  { wiki: 'HIV',                         names: { de: 'HIV',        en: 'HIV',         fr: 'VIH',        es: 'VIH',   it: 'HIV',   pt: 'VIH',   nl: 'HIV',     sv: 'HIV',         pl: 'HIV' } },
    'SIDA': { wiki: 'HIV/AIDS',                    names: { de: 'AIDS',       en: 'AIDS',        fr: 'SIDA',       es: 'SIDA',  it: 'AIDS',  pt: 'SIDA',  nl: 'aids',    sv: 'aids',        pl: 'AIDS' } },
    // ── AI / IA ──
    'IA':   { wiki: 'Artificial intelligence',     names: { de: 'KI',         en: 'AI',          fr: 'IA',         es: 'IA',    it: 'IA',    pt: 'IA',    nl: 'AI',      sv: 'AI',          pl: 'AI',    ro: 'IA'  } },
    'AI':   { wiki: 'Artificial intelligence',     names: { de: 'KI',         en: 'AI',          fr: 'IA',         es: 'IA',    it: 'IA',    pt: 'IA',    nl: 'AI',      sv: 'AI',          pl: 'AI',    ro: 'IA'  } },
    'KI':   { wiki: 'Artificial intelligence',     names: { de: 'KI',         en: 'AI',          fr: 'IA',         es: 'IA',    it: 'IA',    pt: 'IA',    nl: 'AI',      sv: 'AI',          pl: 'AI',    ro: 'IA'  } },
    // ── Identity documents ──
    'DNI':  { wiki: 'National identity card',      names: { de: 'Personalausweis', en: 'ID card', fr: "carte d'identit\u00e9", es: 'DNI', it: 'carta d\u2019identit\u00e0', pt: 'bilhete de identidade' } },
    'NIE':  { wiki: 'Número de identificación de extranjero', names: { de: 'NIE', en: 'NIE', fr: 'NIE', es: 'NIE' } },
    // ── Media ──
    'BBC':  { wiki: 'BBC',                         names: { de: 'BBC',        en: 'BBC',         fr: 'BBC',        es: 'BBC',   it: 'BBC',   pt: 'BBC',   nl: 'BBC',     sv: 'BBC',         pl: 'BBC' } },
    'CNN':  { wiki: 'CNN',                         names: { de: 'CNN',        en: 'CNN',         fr: 'CNN',        es: 'CNN',   it: 'CNN',   pt: 'CNN',   nl: 'CNN',     sv: 'CNN',         pl: 'CNN' } },
    // ── CEO ──
    'CEO':  { wiki: 'Chief executive officer',     names: { de: 'CEO',        en: 'CEO',         fr: 'PDG',        es: 'CEO',   it: 'CEO',   pt: 'CEO',   nl: 'CEO',     sv: 'VD',          pl: 'CEO' } },
    // ── Historical currencies ──
    'FF':   { wiki: 'French franc',                names: { de: 'FF',         en: 'FF',          fr: 'FF',         es: 'FF' } },
    'DM':   { wiki: 'Deutsche Mark',               names: { de: 'DM',         en: 'DM',          fr: 'DM',         es: 'DM' } },
  };
  // All-caps multi-word (e.g. "REINO UNIDO") are also proper nouns — normalize for lookup.
  // German comparative/superlative adjectives (e.g. "Längere Frist") start with uppercase
  // in headlines but are NOT proper nouns. Detect by -ere/-eren/-erer/-esten etc. ending.
  const _firstToken = word.split(' ')[0].toLowerCase();
  const _isGermanAdjective = /(?:ere|erer|erem|eren|eres|este|esten|ester|estem|estes|liche|lichen|liches|lichem|licher|ster|sten|stem|stes)$/i.test(_firstToken) && _firstToken.length > 4;
  const isMultiWordProperNoun = word.includes(' ') &&
    word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase() &&
    !_isGermanAdjective;
  if (isMultiWordProperNoun) {
    // Strip common leading articles ("La UE" → "UE", "El Niño" → "Niño") and
    // process the core. Avoids "La UE" being looked up as a proper name.
    const articleStripMatch = word.match(/^(?:la|el|los|las|le|les|the|gli|il|lo|i|un|una|une|ein|eine|der|die|das)\s+(.+)$/i);
    if (articleStripMatch) {
      const coreWord = articleStripMatch[1];
      // If core is a known multilingual acronym, return it directly
      const coreAcronymEntry = MULTILANG_ACRONYMS[coreWord.toUpperCase()];
      if (coreAcronymEntry) {
        const wikiTitle = coreAcronymEntry.wiki || coreAcronymEntry;
        const targetName = (coreAcronymEntry.names || {})[targetLang] || (coreAcronymEntry.names || {}).en || null;
        const r = await fetchWikiSummary(wikiTitle, 'en');
        return {
          translation: targetName, alternatives: [], translatable: !!targetName, sameLanguage: false,
          definition: r ? [r] : null,
          extractedTranslation: null,
          contextPhrase: context || null, contextTranslation: null,
          sentenceTranslation: null, sentenceExtracted: null
        };
      }
      // Otherwise, look up the core word without the article
 const coreDef = await lookupDefinition(coreWord, targetLang, context);
      if (coreDef) return {
        translation: null, alternatives: [], translatable: false, sameLanguage: false,
        definition: coreDef,
        extractedTranslation: null,
        contextPhrase: context || null, contextTranslation: null,
        sentenceTranslation: null, sentenceExtracted: null
      };
    }
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
    // definition=null: geo/country name — translate the phrase directly.
    // Use lowercase + no context to bypass the isMultiWordProperNoun guard above
    // and avoid infinite recursion. MT engines handle "reino unido" → "Vereinigtes Königreich".
    const lowerPhrase = word.toLowerCase();
    const fullResult = await callProviderWithContext(lowerPhrase, null, settings, pageLang);
    if (fullResult && fullResult.translation) {
      // Only accept if the translation isn't longer than the input phrase.
      // "reino unido" (2) → "Vereinigtes Königreich" (2) ✓ keep
      // "ausländerhass südafrikas wirtschaft" (3) → "xenofobia en la economía de Sudáfrica" (6) ✗ skip
      const inputWords = lowerPhrase.trim().split(/\s+/).length;
      const transWords = fullResult.translation.trim().split(/\s+/).length;
      if (transWords <= inputWords) {
        return { ...fullResult, displayWord: word };
      }
    }
    // Last resort: translate just the first word.
    // Keep original casing for proper noun Wikipedia lookup
    const firstWord = word.split(/\s+/)[0]; // original case, e.g. "Starmers"
    // Try Wikipedia lookup for the first word BEFORE calling GT.
    // GT would wrongly translate "Starmers" → "estrellas" (star+s), but Wikipedia
    // finds "Starmer" → Keir Starmer via the genitive-strip in lookupWikipediaPersonFallback.
    const isFirstCapitalized = firstWord.length >= 2 &&
      firstWord[0] === firstWord[0].toUpperCase() && firstWord[0] !== firstWord[0].toLowerCase();
    const _firstTokenLow2 = firstWord.toLowerCase();
    const _isGermanAdjFirst = /(?:ere|erer|erem|eren|eres|este|esten|ester|estem|estes|liche|lichen|liches|lichem|licher)$/i.test(_firstTokenLow2) && _firstTokenLow2.length > 4;
    // If ALL words in the phrase are capitalized (e.g. "Tamara Flores"), it looks like a person
    // name for which Wikipedia had no direct article. Looking up just the first name ("Tamara")
    // would find a random famous person with that first name (e.g. "Tamara Živković") — skip.
    const _allCapWords = word.split(/\s+/).every(w => w.length >= 2 && w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase());
    if (isFirstCapitalized && !_isGermanAdjFirst && !_allCapWords) {
      // Pass null context so extractFullName doesn't expand "Starmers" → "Starmers Rücktritt"
      // (which causes full-text search to find wrong article like "2025 German federal election")
      const firstWordDef = await lookupDefinition(firstWord, targetLang, null);
      if (firstWordDef) {
        // Use article title as display (e.g. "Keir Starmer" for "Starmers")
        const artTitle = firstWordDef?.[0]?.title;
        const fwDisplay = artTitle
          ? artTitle.replace(/\s*\(.*\)\s*$/, '').trim().split(/\s+/).slice(0, 2).join(' ')
          : firstWord;
        return {
          translation: null, alternatives: [], translatable: false,
          definition: firstWordDef, displayWord: fwDisplay,
          contextPhrase: context || null, contextTranslation: null,
          sentenceTranslation: null, sentenceExtracted: null,
        };
      }
    }
    const fallbackResult = await callProviderWithContext(firstWord, null, settings, pageLang);
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

  // Single all-caps word = acronym (GOP, FBI, NATO, US, UK, EU, UN, etc.).
  // GT translates these phonetically or as common words, producing wrong results:
  //   "US" → "nosotros", "GOP" → "gopo", etc.
  // Try Wikipedia first; fall back to normal GT if Wikipedia has nothing.
  // Also matches dotted abbreviations: U.S., U.K., D.C. (letters alternating with dots)
  // 2-letter all-caps (US, UK, EU, UN, AI) are included — they are almost always
  // abbreviations in news/article context, not pronouns.
  const isDottedAbbrev = /^[A-Za-z](\.[A-Za-z])+\.?$/.test(word);
  const isSingleAcronym = !word.includes(' ') && (
    (isAllCaps && /^[A-ZÀ-Ö]+$/.test(word) && word.length >= 2) || isDottedAbbrev
  );
  if (isSingleAcronym) {
    const multiEntry = MULTILANG_ACRONYMS[word.toUpperCase()];
    if (multiEntry) {
      const wikiTitle = multiEntry.wiki || multiEntry;
      const targetName = (multiEntry.names || {})[targetLang] || (multiEntry.names || {}).en || null;
      const overrideResult = await fetchWikiSummary(wikiTitle, 'en');
      return {
        translation: targetName, alternatives: [], translatable: !!targetName, sameLanguage: false,
        definition: overrideResult ? [overrideResult] : null,
        extractedTranslation: null,
        contextPhrase: context || null,
        contextTranslation: null,
        sentenceTranslation: null,
        sentenceExtracted: null
      };
    }

    // Parenthetical expansion: detect "Full Name (WORD)" or "WORD (Full Name)" in sentence/context.
    // Handles cases like "Institut für Höhere Studien (IHS)" or "WIFO (Wirtschaftsforschungsinstitut)"
    // where the article itself defines the abbreviation — no Wikipedia needed.
    {
      const _esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      let _exp = null;
      for (const _txt of [sentence, context].filter(Boolean)) {
        // Pattern 1: "Some Long Name (WORD)" — expansion precedes abbreviation
        const _m1 = _txt.match(new RegExp('([A-ZÄÖÜ][\\w\\s\\-äöüÄÖÜß,\\.]{5,80})\\s*\\(' + _esc + '\\)', 'i'));
        if (_m1) { _exp = _m1[1].trim(); break; }
        // Pattern 2: "WORD (Some Long Name)" — expansion follows abbreviation
        const _m2 = _txt.match(new RegExp('(?:^|[\\s,;])' + _esc + '\\s*\\(([A-ZÄÖÜ][^)]{5,80})\\)', 'i'));
        if (_m2) { _exp = _m2[1].trim(); break; }
      }
      if (_exp) {
        return {
          translation: null, alternatives: [], translatable: false, sameLanguage: false,
          definition: [{ text: _exp, title: word }],
          extractedTranslation: null,
          contextPhrase: context || null, contextTranslation: null,
          sentenceTranslation: null, sentenceExtracted: null
        };
      }
    }

    // For 2-3 letter ALL-CAPS acronyms, run context-aware search FIRST.
    // lookupDefinition may find a wrong article (e.g. "Project Management" for "PM")
    // before the context-aware search gets a chance to find "Prime Minister".
    if (/^[A-Z]{2,3}$/.test(word)) {
      const acronymSearch = await lookupWikipediaAcronymSearch(word, context, targetLang, pageLang);
      if (acronymSearch) {
        return {
          translation: null, alternatives: [], translatable: false, sameLanguage: false,
          definition: [acronymSearch],
          extractedTranslation: null,
          contextPhrase: context || null,
          contextTranslation: null,
          sentenceTranslation: null,
          sentenceExtracted: null
        };
      }
    }
    // Longer acronyms (WIFO, NATO, FBI, etc.): search page-lang and target-lang Wikipedia only.
    // Do NOT fall back to English Wikipedia — it often returns a completely different article
    // for the same acronym (e.g. WIFO → radio station in Georgia, IHS → Christogram).
    {
      const _aLangs = [...new Set([pageLang, targetLang].filter(l => l && l !== 'en'))];
      if (targetLang === 'en') _aLangs.push('en');
      let _aResult = null;
      for (const _lang of _aLangs) {
        const _r = await fetchWikiSummary(word, _lang);
        if (_r && _wikiTitleMatchesQuery(_r.title, word) && _wikiLastWordMatch(_r.title, word)) {
          _aResult = _r; break;
        }
      }
      if (_aResult) {
        return {
          translation: null, alternatives: [], translatable: false, sameLanguage: false,
          definition: [_aResult],
          extractedTranslation: null,
          contextPhrase: context || null,
          contextTranslation: null,
          sentenceTranslation: null,
          sentenceExtracted: null
        };
      }
    }
    // No Wikipedia result — check if this is a proper noun context (adjacent ALL-CAPS word).
    // If so, return "not found" immediately rather than falling through to GT (which will
    // misidentify surnames as German words, e.g. TAMARA→"tamara", FLORES→"siesta").
    if (context) {
      const _ctxToks2 = context.trim().split(/\s+/);
      const _wi2 = _ctxToks2.findIndex(t => t.toUpperCase() === word.toUpperCase());
      const _capTok = t => t.length >= 2 && /^[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖÙÚÛÜÝÞ]{2,}$/.test(t);
      const _nbr = _wi2 !== -1 && (
        (_wi2 > 0 && _capTok(_ctxToks2[_wi2 - 1])) ||
        (_wi2 < _ctxToks2.length - 1 && _capTok(_ctxToks2[_wi2 + 1]))
      );
      if (_nbr) {
        return {
          translation: null, alternatives: [], translatable: false, sameLanguage: false,
          definition: null,
          extractedTranslation: null,
          contextPhrase: context || null,
          contextTranslation: null,
          sentenceTranslation: null,
          sentenceExtracted: null
        };
      }
    }
    // Case 2: no context at all + no Wikipedia → unreliable to fall through to GT.
    // For 5+ letter all-alpha words (likely names/proper nouns), return sin datos.
    if (!context && word.length >= 5 && /^[A-Za-zÀ-ÖØ-öø-ÿ]+$/.test(word)) {
      return {
        translation: null, alternatives: [], translatable: false, sameLanguage: false,
        definition: null, extractedTranslation: null,
        contextPhrase: null, contextTranslation: null,
        sentenceTranslation: null, sentenceExtracted: null
      };
    }
    // Fall through to normal GT translation
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
  // In German, ALL nouns are capitalized — lowercase words are verbs/adj/adv.
  // The pivot (de→en→es) gives noun readings for lowercase German words
  // (e.g. "wolle" de→en="wool"→"lana" instead of "querer"). Direct de→es
  // handles German verb forms correctly without pivot. Only skip pivot for
  // German lowercase; capitalized German nouns still benefit from the pivot.
  const _wordStartsUpper = word.length >= 3 && word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase();
  const usePivot = PIVOT_LANGS.has(sourceLang) && targetLang !== 'en' && wordForApi.length > 3
    && (sourceLang !== 'de' || _wordStartsUpper);
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
      // Skip re-pivot for German lowercase words: pivot de→en→es misreads verb forms as nouns
      // (e.g. "wolle" de→en="wool"→"lana" instead of the verb "querer"). Direct de→es is better.
      const _isGermanLowerWord = !_wordStartsUpper &&
        (_gtResult.detectedLang === 'de' || sourceLang === 'de');
      if (!usePivot && !returnChunks && _gtResult.detectedLang &&
          PIVOT_LANGS.has(_gtResult.detectedLang) && targetLang !== 'en' && text.length > 3
          && !_isGermanLowerWord) {
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
  const _dbgTokens = sentenceForTranslation ? sentenceForTranslation.split(/\s+/).map(t => t.replace(/[.,!?;:()"[\]]/g,'').toLowerCase()) : [];

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
  if (sentenceExtracted && sentenceExtracted.trim().split(/\s+/).length > 2) {
    sentenceExtracted = null;
  }
  if (!sentenceExtracted && sentenceRaw && sentMinusRaw) {
    const _fullToksAll = new Set((sentenceRaw.toLowerCase().match(/[\wáéíóúüäöñàèìòùçßÀ-ɏ]+/g) || []));
    const _minusToksAll = new Set((sentMinusRaw.toLowerCase().match(/[\wáéíóúüäöñàèìòùçßÀ-ɏ]+/g) || []));
    // Short clitic pronouns (length 2) that get filtered by the length check but are
    // critical for reconstructing reflexive verbs: "se prepara", "me llama", etc.
    const SHORT_CLITICS = ['se', 'me', 'te', 'le', 'nos', 'os'];
    const lostClitic = SHORT_CLITICS.find(r => _fullToksAll.has(r) && !_minusToksAll.has(r)) || null;
    // Content words only: length >= 4 filters noise like "que", "los", "una", "con"
    const _unique = [..._fullToksAll].filter(t => !_minusToksAll.has(t) && t.length >= 4);
    // Use diff when 1–3 content words disappeared (wider than just 1 to handle verb
    // restructuring by GT, e.g. "a medida que" → "mientras" produces 2 side-effect tokens)
    if (_unique.length >= 1 && _unique.length <= 3) {
      const wLow = word.toLowerCase();
      const wrLow = (wordRaw || '').toLowerCase();
      const fullLower = sentenceRaw.toLowerCase();
      let bestCand = null;
      if (lostClitic) {
        // A clitic ("se", "me"…) disappeared alongside content words.
        // The verb is the content word that appears CLOSEST AFTER the clitic in the translation.
        // e.g. "Francia se prepara para… a medida que…" → clitic="se" at pos 8,
        //       "prepara" at pos 11 (dist 3), "medida" at pos 40 (dist 32) → pick "prepara" ✓
        const reflexIdx = fullLower.indexOf(lostClitic);
        let bestDist = Infinity;
        for (const t of _unique) {
          if (t === wLow || t === wrLow) continue;
          const tIdx = fullLower.indexOf(t, reflexIdx);
          if (tIdx !== -1 && tIdx - reflexIdx < bestDist) {
            bestDist = tIdx - reflexIdx;
            bestCand = t;
          }
        }
        if (bestCand) {
          // Only join clitic + verb if they appear CONSECUTIVELY in the translation.
          // Prevents false joins like "se" + "vuelto" when "ha" sits between them
          // ("no se ha vuelto") — that's sentence restructuring, not a direct translation.
          // Valid cases like "se prepara" or "se transforma" do appear consecutively. ✓
          const phrase1 = `${lostClitic} ${bestCand}`;
          const phrase2 = `${bestCand} ${lostClitic}`;
          if (fullLower.includes(phrase1)) sentenceExtracted = phrase1;
          else if (fullLower.includes(phrase2)) sentenceExtracted = phrase2;
        }
      } else if (_unique.length === 1) {
        // No clitic, exactly 1 content word disappeared → safe to use directly.
        const _cand = _unique.find(t => t !== wLow && t !== wrLow);
        if (_cand) sentenceExtracted = _cand;
      } else if (_unique.length === 2) {
        // No clitic, 2 content words disappeared.
        // Safe ONLY if they appear CONSECUTIVELY in the sentence translation
        // → genuine 2-word phrase (e.g. "würdigt" → "rinde homenaje" appear together).
        // NOT safe if they're spread apart (e.g. "peak" → "alcanza...punto máximo"
        // are separated by other words → sentence restructured, not a direct translation).
        // Also reject if either candidate is a Spanish function word / reflexive clitic
        // (e.g. "se"+"vuelto" from sentence restructuring is NOT the translation of "Umgeben").
        const _spFunctionWords = new Set([
          'se','me','te','le','nos','os','les','lo','la','los','las',
          'un','una','el','de','en','a','y','o','que','con','por','para',
          'como','pero','más','no','ya','si','ni','ha','he','es','son',
          'fue','ser','estar','este','esta','su','al','del'
        ]);
        const candidates = _unique.filter(t => t !== wLow && t !== wrLow);
        if (candidates.length === 2 && candidates.every(t => !_spFunctionWords.has(t))) {
          const [cA, cB] = candidates;
          if (fullLower.includes(`${cA} ${cB}`)) sentenceExtracted = `${cA} ${cB}`;
          else if (fullLower.includes(`${cB} ${cA}`)) sentenceExtracted = `${cB} ${cA}`;
        }
        // Non-consecutive fallback: neither order was adjacent, but the earliest-appearing
        // candidate may still be the correct translation (e.g. "verteidigt" → unique tokens
        // ["defiende","conversaciones"] with "las" between them in "Merz defiende las conversaciones".
        // "defiende" is at V2 position (word 2) → safe to use it alone).
        if (!sentenceExtracted && candidates.length >= 1) {
          const _nonFnCands = candidates.filter(t => !_spFunctionWords.has(t));
          const ranked = _nonFnCands
            .map(t => ({ t, pos: fullLower.indexOf(t) }))
            .filter(({ pos }) => pos !== -1)
            .sort((a, b) => a.pos - b.pos);
          if (ranked.length > 0) {
            const { t: earliest, pos } = ranked[0];
            // Only safe when the candidate appears within the first 3 words (V2 / subject-verb position).
            // Avoids false positives from unrelated tokens that happen to be unique.
            const wordsBefore = fullLower.slice(0, pos).trim().split(/\s+/).filter(Boolean).length;
            if (wordsBefore <= 2) sentenceExtracted = earliest;
          }
        }
      } else if (_unique.length === 3) {
        // 3 unique tokens: removing the word restructured a whole clause (common for
        // German modal/auxiliary verbs in Konjunktiv I indirect speech, e.g. "wolle").
        // Side-effect: other verbs flip between infinitive and conjugated forms.
        // Strategy: for German lowercase verbs, filter out Spanish infinitives (-ar/-er/-ir)
        // — those are restructuring artefacts. The hovered verb's own translation is the
        // conjugated form that remains (e.g. "quiere" from "wolle"/wollen).
        // Only safe when exactly 1 non-infinitive candidate survives.
        const _isGermanLowerVerb = !_wordStartsUpper &&
          (sourceLang === 'de' || pageLang === 'de' || pageLang?.startsWith('de-'));
        if (_isGermanLowerVerb) {
          const candidates = _unique.filter(t => t !== wLow && t !== wrLow);
          const conjugated = candidates.filter(t => !/(?:ar|er|ir)$/i.test(t));
          if (conjugated.length === 1) sentenceExtracted = conjugated[0];
        }
      }

      // Reject sentenceExtracted that is a Spanish adverb/function word — these are false
      // positives from co-occurring words like "auch"→"también" overshadowing the verb.
      const _SPANISH_ADV_REJECT = new Set([
        // adverbs
        'también','tampoco','ya','aún','aun','solo','sólo','más','menos','muy','bien',
        'mal','así','aquí','allí','allá','acá','nunca','siempre','jamás','quizás',
        'ahora','antes','después','luego','hoy','ayer','mañana','incluso','hasta',
        'apenas','casi','justo','precisamente','exactamente','realmente','finalmente',
        'además','mientras','entonces','pues','aunque','sin embargo','no obstante',
        // determiners / quantifiers / pronouns (false-positive diff artifacts)
        'algunos','algunas','alguno','alguna','algún','varios','varias',
        'muchos','muchas','mucho','mucha','pocos','pocas','poco','poca',
        'unos','unas','todos','todas','todo','toda','ciertos','ciertas',
        'ambos','ambas','demás','otro','otra','otros','otras',
        'nadie','nada','alguien','algo','cualquier','cualquiera',
        // articles and prepositions that slip through
        'del','al','de','en','con','por','para','que','como','pero','sino',
      ]);
      const _isGermanLowerOutside = !_wordStartsUpper &&
        (sourceLang === 'de' || pageLang === 'de' || pageLang?.startsWith('de-'));
      if (sentenceExtracted && _isGermanLowerOutside &&
          _SPANISH_ADV_REJECT.has(sentenceExtracted.toLowerCase().trim())) {
        sentenceExtracted = null;
      }

      // Reject extractedTranslation / sentenceExtracted that are loanwords or proper nouns
      // already present in the source text (e.g. "besetzt"→"dubái" when "Dubai" is in context).
      // Strip accents and compare; if the translation matches a source token → false positive.
      const _normAccents = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      const _srcTokens = new Set(((context || '') + ' ' + (sentence || '')).split(/\W+/).map(_normAccents).filter(t => t.length > 1));
      if (sentenceExtracted && _srcTokens.has(_normAccents(sentenceExtracted.trim()))) {
        sentenceExtracted = null;
      }

      // Stem-based fallback: runs after ALL branches when sentenceExtracted is still null.
      // Handles cases where lostClitic consumed the branch but found nothing (e.g. "Umgeben"
      // where "se" is a clitic but "se vuelto" isn't consecutive, yet "rodeada" shares the
      // stem "rode" with the direct translation "rodear").
      // Safe when exactly 1 unique token starts with the translation's stem.
      if (!sentenceExtracted && wordRaw && wordRaw.length >= 4) {
        const _stemBase = wordRaw.toLowerCase();
        const _stem = _stemBase.length > 5
          ? _stemBase.slice(0, Math.max(3, _stemBase.length - 2))
          : _stemBase;
        const candidates = _unique.filter(t => t !== wLow && t !== wrLow);
        const byLemma = candidates.filter(t => t.startsWith(_stem));
        if (byLemma.length === 1) sentenceExtracted = byLemma[0];
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

  // Signal A: word appears unchanged in the phrase or sentence translation.
  // We check BOTH phraseRaw and sentenceRaw because:
  //   - phraseRaw (short context window) may omit the word when it's at the very start
  //     of a sentence and the context extractor only captures words that follow it.
  //   - sentenceRaw (full sentence translation) almost always preserves proper nouns.
  // e.g. "Pissos" at sentence start → phraseRaw = "en la región suroeste de las Landas..."
  //      (no "Pissos") but sentenceRaw = "Pissos, en la región suroeste..." → caught ✓
  const _properNounPattern = new RegExp(
    `(?:^|[^\\wÀ-ɏ])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^\\wÀ-ɏ]|$)`, 'i'
  );
  const wordAppearsInContext = isCapitalized && (
    (phraseRaw && _properNounPattern.test(phraseRaw)) ||
    (sentenceRaw && _properNounPattern.test(sentenceRaw))
  );

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
  let extractedTranslation = extractedFromChunks
    || (usePivot ? null : extractWordFromContext(word, context, phraseRaw)); // positional fallback only for non-pivot

  // Reject extracted translation if it's a loanword/proper noun already in the source
  // (e.g. "besetzt"→"dubái" when "Dubai" is in the German context — false positive from diff)
  if (extractedTranslation) {
    const _normAcc = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const _srcText = (context || '') + ' ' + (sentence || '');
    const _srcToks = new Set(_srcText.split(/\W+/).map(_normAcc).filter(t => t.length > 2));
    const _extNorm = _normAcc(extractedTranslation.trim());
    if (_srcToks.has(_extNorm)) {
      extractedTranslation = null;
    }
    // Reject sentence fragments (3+ words) — chunk alignment captured multiple tokens
    if (extractedTranslation && extractedTranslation.trim().split(/\s+/).length > 2) {
      extractedTranslation = null;
    }
  }

  // Pivot validation: the phrase is always translated DIRECTLY (sv→es), so phraseRaw
  // reflects the true meaning in context. If the pivot result (isolated word) doesn't
  // appear in that direct translation, the pivot likely got a wrong word sense
  // (e.g. "sköt" sv→en="sheet" instead of "shot" → en→es="hoja").
  // In that case, fall back to the phrase-derived extraction (chunk alignment first,
  // positional alignment as secondary), which comes from the correct direct translation.
  // Note: extractWordFromContext is only used here for pivot validation — NOT returned as
  // extractedTranslation (which would let content.js re-override the corrected result).
  let finalWordTranslation = wordTranslation;

  // ALL-CAPS word adjacent to another ALL-CAPS word in context → proper noun phrase.
  // e.g. "FLORES" in "TAMARA FLORES", "TAMARA" in "TAMARA FLORES ist eine..."
  // GT misidentifies surnames as German common words (FLORES→"siesta", TAMARA→"tamara").
  // Suppress GT translation so lookupDefinition (Wikipedia + fullName check) handles it.
  if (isAllCaps && !word.includes(' ') && context) {
    const _ctxToks = context.trim().split(/\s+/);
    const _wordIdx = _ctxToks.findIndex(t => t.toUpperCase() === word.toUpperCase());
    const _isAllCapsToken = t => t.length >= 2 && /^[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖÙÚÛÜÝÞ]{2,}$/.test(t);
    const _hasCapNeighbor = _wordIdx !== -1 && (
      (_wordIdx > 0 && _isAllCapsToken(_ctxToks[_wordIdx - 1])) ||
      (_wordIdx < _ctxToks.length - 1 && _isAllCapsToken(_ctxToks[_wordIdx + 1]))
    );
    if (_hasCapNeighbor) {
      finalWordTranslation = null;
      wordPosGroups = [];
      wordAlts = [];
    }
  }

  // German Präteritum lemma fallback: for German lowercase verbs ending in -te/-ten,
  // GT often mistranslates the conjugated form (e.g. "sparte"→"salvado" instead of "ahorrar").
  // Strip the past tense suffix, translate the infinitive, and use it if it looks like
  // a proper Spanish infinitive. Runs after all GT results are available.
  {
    const _isDE = pageLang === 'de' || pageLang?.startsWith('de-') || sourceLang === 'de';
    const _isLower = !_wordStartsUpper;
    if (_isDE && _isLower && targetLang === 'es') {
      const _wl = word.toLowerCase();
      let _inf = null;
      // Only -te (3rd person singular weak past: "sparte"→"sparen", "sagte"→"sagen").
      // Skip -ten: also the weak adjective ending ("verbreiteten","bekannten") → false positives.
      if (_wl.endsWith('te') && !_wl.endsWith('ste') && _wl.length > 4) {
        _inf = _wl.slice(0,-2) + 'en';
      }
      if (_inf) {
        try {
          const _ir = await fetch(
            `https://translate.googleapis.com/translate_a/single?client=gtx&sl=de&tl=es&dt=t&q=${encodeURIComponent(_inf)}`
          );
          if (_ir.ok) {
            const _id = await _ir.json();
            const _it = (_id[0]||[]).map(t=>t?.[0]||'').join('').trim().toLowerCase();
            // Accept only proper Spanish infinitives (-ar/-er/-ir) to avoid false positives
            if (_it && /(?:ar|er|ir)$/i.test(_it) && _it !== _inf) {
              finalWordTranslation = _it;
              effectiveAlts = [];
            }
          }
        } catch {}
      }
    }

    // German weak adjective -en ending: "verbreiteten"→"verbreitet"→"extendido".
    if (_isDE && _isLower && targetLang === 'es' &&
        (/(?:ar|er|ir)$/i.test(finalWordTranslation || '') || /(?:ó|aron|ieron)$/.test(finalWordTranslation || '')) &&
        word.length > 5 && word.toLowerCase().endsWith('en') &&
        !word.toLowerCase().endsWith('ieren')) {
      const _base = word.slice(0, -2);
      // Only apply if base looks like a German past participle or strong participle
      // (ends in -t, -et, -d, -gt, -cht, -ng, -en) — NOT a bare verb stem like "besitz", "erreich"
      // This prevents "besitzen"→"besitz"→"propio" false positive
      const _looksLikeParticiple = /(?:et|igt|cht|ngt|ert|iert|ssen|ffen|gen|ten|nden|hten|lten|rten|enden|enden|ten|nen|en)$/i.test(_base);
      if (_looksLikeParticiple) try {
        const _br = await fetch(
          `https://translate.googleapis.com/translate_a/single?client=gtx&sl=de&tl=es&dt=t&q=${encodeURIComponent(_base)}`
        );
        if (_br.ok) {
          const _bd = await _br.json();
          const _bt = (_bd[0]||[]).map(t=>t?.[0]||'').join('').trim().toLowerCase();
          // If base gives non-infinitive → use directly; if still infinitive → convert to past participle (adjective)
          if (_bt && _bt.length > 2 && _bt !== _base.toLowerCase()) {
            if (!/(?:ar|er|ir)$/i.test(_bt)) {
              // Not a Spanish infinitive — use directly (could be adj like "llegado", noun, etc.)
              finalWordTranslation = _bt;
              effectiveAlts = [];
            } else {
              // Still a Spanish infinitive → convert to past participle (adjective form)
              // "desparramar"→"desparramado", "difundir"→"difundido"
              const _part = /ar$/i.test(_bt) ? _bt.slice(0,-2)+'ado' : _bt.slice(0,-2)+'ido';
              finalWordTranslation = _part;
              effectiveAlts = [];
            }
          }
        }
      } catch(e) { }
    }
  }

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

  // German noun recovery: pivot validation discards correct noun translations for inflected forms.
  // Example: "Kriegen" (dative pl. of "Krieg"=war) → pivot gives "guerras" → not found in 2-word
  // context phrase → pivotInPhrase=false → wordPosGroups cleared → direct de→es reads "kriegen"
  // as verb → "Conseguir". Fix: if the word is a German noun (capitalized, not ALL-CAPS) and
  // posGroups are empty, supplement via English pivot without the anchor constraint.
  // We only accept noun POS groups and override the translation with the noun sense.
  const _probGermanNoun = isCapitalized && !isAllCaps &&
    (sourceLang === 'de' || pageLang === 'de' || pageLang?.startsWith('de-'));
  if (_probGermanNoun && word.length > 4 &&
      !wordPosGroups.some(g => /^noun|^sustantivo|^Substantiv/i.test(g.pos))) {
    // German inflected nouns often lack a bilingual dict entry (GT only has the base form).
    // Example: "Kriegen" (dative pl. of "Krieg"=war) → GT returns only verb "kriegen" with no
    // noun POS entry. Strategy: strip common German noun inflection suffixes to find the base
    // form ("Krieg"), then call GT for the base form.
    // NOTE: posGroups in callGoogleTranslate requires ≥2 POS entries to be built. Since the
    // base form often has only one POS (noun), we rely on _baseResult.text + firstPos instead.
    // Order matters: try "n" before "en" so "Krisen"→"Krise"(→crisis) beats "Kris"(→Cris/wrong).
    // Longer compound suffixes first to avoid under-stripping.
    const _nounSuffixes = ['nen','ern','ien','chen','lein','ungen','heiten','keiten',
                           'n','es','em','er','e','s','en'];
    for (const suf of _nounSuffixes) {
      const baseLen = word.length - suf.length;
      if (!word.toLowerCase().endsWith(suf) || baseLen < 3) continue;
      const _base = word.slice(0, baseLen);
      const _baseCap = _base.charAt(0).toUpperCase() + _base.slice(1);
      if (_baseCap === word) continue; // no change — skip
      let _baseResult = null;
      try { _baseResult = await callGoogleTranslate(_baseCap, 'de', targetLang, false); } catch { continue; }
      if (!_baseResult?.text) continue;
      // Accept if GT didn't echo the input back (i.e. it has an actual translation)
      const _baseLow = _baseResult.text.toLowerCase().trim();
      const _inputLow = _baseCap.toLowerCase();
      if (_baseLow === _inputLow) continue; // echo — base form also unknown
      // Reject if Spanish result starts with uppercase → likely a proper noun (e.g. "Kris"→"Cris")
      if (_baseResult.text[0] && _baseResult.text[0] === _baseResult.text[0].toUpperCase() &&
          /[A-ZÀ-Ö]/.test(_baseResult.text[0])) continue;
      // Build a synthetic noun posGroup from the base translation
      const _synthTranslations = [_baseResult.text, ...(_baseResult.alternatives || [])].slice(0, 3);
      wordPosGroups = [{ pos: 'noun', translations: _synthTranslations }];
      finalWordTranslation = _baseResult.text;
      effectiveAlts = _baseResult.alternatives?.slice(0, 2) || [];
      break;
    }
  }

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
    const _fnFull = context ? extractFullName(word, context) : word;
    const _fnDisplay = definition?.displayName
      || ((_fnFull !== word && _fnFull.includes(' ')) ? _fnFull : undefined);
    return {
      translation: null,
      alternatives: [],
      translatable: false,
      sameLanguage,
      definition,
      displayWord: _fnDisplay,
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
  if (isCapitalized && finalWordTranslation && !word.includes(' ') && wordForApi.length >= 4) {
    const normSrc3 = wordForApi.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '').substring(0, 3);
    const normTrx3 = finalWordTranslation.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '').substring(0, 3);
 if (normSrc3.length === 3 && normSrc3 === normTrx3) {
      const cogWiki = await lookupDefinition(word, targetLang, context);
      if (cogWiki && cogWiki.length > 0) {
        // Wikipedia confirmed this is a proper noun (place, person, org, etc.).
        // Suppress the false cognate GT translation — the Wikipedia definition is more accurate.
        // e.g. "Paris" → GT "par" (French cognate), Wikipedia "capital city of France" → show city.
        definition = cogWiki;
        finalWordTranslation = null;
        wordPosGroups = [];
        wordAlts = [];
        effectiveAlts = [];
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
  // For capitalized proper nouns where GT returned the word unchanged (e.g. "Merz" → "Merz"),
  // still look up Wikipedia — the name has no translation but may have a definition.
  // The cognate check above requires ≥6 chars, so short names like "Merz" (4 chars) slip through.
 if (!definition && isCapitalized && !word.includes(' ') &&
      finalWordTranslation && finalWordTranslation.toLowerCase().trim() === word.toLowerCase().trim()) {
    definition = await lookupDefinition(word, targetLang, context);
  }
  // For capitalized single words where GT returned a MULTI-WORD phrase, GT likely
  // misidentified a proper noun as a foreign common word (e.g. "Paris" → "a la par",
  // treating French "paris" = bets). Check Wikipedia; if found, suppress GT translation.
  if (!definition && isCapitalized && !word.includes(' ') && word.length >= 4 &&
      finalWordTranslation && finalWordTranslation.includes(' ')) {
    const _mwWiki = await lookupDefinition(word, targetLang, context);
    if (_mwWiki && _mwWiki.length > 0) {
      definition = _mwWiki;
      finalWordTranslation = null;
      wordPosGroups = [];
      wordAlts = [];
      effectiveAlts = [];
    }
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

  // If GT has no dict entry for the word (finalWordTranslation=null) but the sentence diff
  // extracted a clear single-word translation, use it as the primary translation.
  // e.g. "Ausländerhass" → GT has no entry → sentenceExtracted="xenofobia" → show "xenofobia"
  // Without this, translatable=false and content.js shows the full contextTranslation phrase instead.
  // German participio vs. presente: same verb form in German (e.g. "erwartet" = "espera" OR "esperado").
  // GT bilingual dict always returns the participio ("esperado") as canonical form.
  // Rule: if there's NO auxiliary verb (hat/ist/wird/etc.) near the word in the source sentence,
  // the verb is present tense → prefer sentenceExtracted (which captures the conjugated form).
  if (pageLang === 'de' && sentence && finalWordTranslation && sentenceExtracted && targetLang === 'es') {
    // sentenceExtracted may be "le espera" (Spanish clitic + verb) — extract just the verb
    const SPANISH_CLITICS = new Set(['le','la','lo','les','las','los','se','me','te','nos','os']);
    let sentExtVerb = sentenceExtracted;
    if (sentenceExtracted.includes(' ')) {
      const parts = sentenceExtracted.trim().split(/\s+/);
      sentExtVerb = (parts.length === 2 && SPANISH_CLITICS.has(parts[0].toLowerCase()))
        ? parts[1]   // "espera" from "le espera"
        : null;      // multi-word, can't resolve
    }
    if (sentExtVerb) {
      const isParticipioEs  = /(?:ado|ido|to|so|cho)$/i.test(finalWordTranslation);
      const sentIsConjugado = !/(?:ado|ido|to|so|cho)$/i.test(sentExtVerb);
      if (isParticipioEs && sentIsConjugado) {
        const GERMAN_AUX = /\b(hat|hatte|habe|haben|habt|hätte|hätten|hättest|ist|war|sei|sind|waren|wäre|wären|wärst|wird|wurde|werden|worden|würde|würden|wirst|werdet)\b/i;
        if (!GERMAN_AUX.test(sentence)) {
          // No auxiliary → present tense → use conjugated form from sentence diff
          finalWordTranslation = sentExtVerb;
          effectiveAlts = [];
        }
      }
    }
  }

  // If GT has no dict entry (finalWordTranslation=null) but sentence diff extracted a clear
  // single-word translation, use it as primary (e.g. "Ausländerhass" → "xenofobia").
  // Exception: skip for capitalized words with a Wikipedia definition — sentenceExtracted
  // can pick up nearby words in the sentence rather than the hovered word's translation
  // (e.g. "Sinkevicius als Premier nominiert" → "nominiert"→"nombrado" wrongly assigned).
  if (!finalWordTranslation && sentenceExtracted && !sentenceExtracted.includes(' ')
      && !(isCapitalized && definition)) {
    finalWordTranslation = sentenceExtracted;
    effectiveAlts = [];
  }

  const _mainFull = (definition && context) ? extractFullName(word, context) : word;
  const _mainDisplay = definition?.displayName
    || ((_mainFull !== word && _mainFull.includes(' ')) ? _mainFull : undefined);
  if (/^pablo$/i.test(word) || /^iglesias$/i.test(word)) {
  }
  // In German, every capitalized word is a noun (German capitalizes ALL nouns).
  // This flag lets content.js prefer noun POS groups and skip verb-biased logic.
  const isGermanNoun = isCapitalized && !isAllCaps &&
    (sourceLang === 'de' || pageLang === 'de' || pageLang?.startsWith('de-'));
  return {
    translation: finalWordTranslation,
    alternatives: finalWordTranslation ? effectiveAlts : [],
    posGroups: finalWordTranslation ? wordPosGroups : [],
    translatable: !!finalWordTranslation,
    sameLanguage,
    definition,
    displayWord: _mainDisplay,
    extractedTranslation: usePivot ? null : (extractedTranslation || null),
    contextPhrase: context || null,
    contextTranslation: phraseRaw || null,
    sentenceTranslation: sentenceRaw || null,
    sentMinusTranslation: sentMinusRaw || null,
    sentenceExtracted: sentenceExtracted || null,
    isGermanNoun: isGermanNoun || false,
    isGermanPage: (sourceLang === 'de' || pageLang === 'de' || pageLang?.startsWith('de-')) || false,
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
        // Trailing punctuation (comma, colon, period) marks the end of the name component.
        // e.g. "Trump," -> include "Trump" but stop -- don't grab the next "Barack".
        if (/[,.:;!?»"')\]]$/.test(rawTok)) break;
      } else {
        break;
      }
    }

    // Extend leftward for up to 2 preceding capitalized tokens (e.g. "Pablo" before "Iglesias")
    // Only when no rightward expansion was found (word looks like a standalone surname).
    if (!name.includes(' ') && idx > 0) {
      // Title/honorific words that precede a name but are NOT part of it.
      // e.g. "Kanzler Merz" → extractFullName returns "Merz", not "Kanzler Merz",
      // so Wikipedia can find "Friedrich Merz" via person-fallback search.
      const TITLE_WORDS = new Set([
        'kanzler','bundeskanzler','vizekanzler','präsident','bundespräsident','vizepräsident',
        'minister','außenminister','innenminister','finanzminister','verteidigungsminister',
        'bundesminister','staatssekretär','könig','königin','kaiser','kaiserin',
        'papst','kardinal','bischof','erzbischof','general','admiral','feldmarschall',
        'oberst','major','professor','prof','doktor','dr','sir','lord','lady',
        'herr','frau','senator','gouverneur','bürgermeister','premier',
        'chancellor','president','prime','secretary','mayor','sheikh','emir','sultan',
        'chef','director','directeur','ceo','cto','cfo',
      ]);
      const leftParts = [];
      for (let i = idx - 1; i >= 0 && i >= idx - 2; i--) {
        const rawTok = tokens[i];
        const prev = rawTok.replace(/[^a-zA-ZÀ-ɏ-]/g, '');
        // Stop at known title words — don't include them in the name
        if (TITLE_WORDS.has(prev.toLowerCase())) break;
        if (prev.length >= 2 &&
            prev[0] === prev[0].toUpperCase() && prev[0] !== prev[0].toLowerCase()) {
          // Stop if this token is a headline label (ends with : or other punctuation)
          // e.g. "Litauen: SINKEVICIUS" → "Litauen:" should not be part of the name
          if (/[,.:;!?»"'\)\]]$/.test(rawTok)) break;
          leftParts.unshift(prev);
          // Stop if the token before this one ended a sentence
          if (i > 0 && /[.!?]$/.test(tokens[i - 1])) break;
        } else {
          break;
        }
      }
      if (leftParts.length > 0) name = leftParts.join(' ') + ' ' + name;
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
// Full-text Wikipedia search for short acronyms (PM, EU, UN, etc.) that hit
// disambiguation pages on direct lookup. Returns the most relevant non-geographic,
// non-trivial article — e.g. "PM" → "Prime Minister".
async function lookupWikipediaAcronymSearch(word, context = null, targetLang = 'en', pageLang = null) {
  // Detect political/title context:
  // "as UK PM" / "as PM" pattern → word is a title (Prime Minister, etc.)
  const escaped = word.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
  const isUsedAsTitle = context &&
    new RegExp('\\bas\\s+(?:\\w+\\s+)?' + escaped + '\\b', 'i').test(context);
  const hasPoliticalKeywords = context &&
    /\b(minister|parliament|government|prime|premier|MP|cabinet|senate|congress|election|party|White\s+House|Downing|chancellor|president|official|nominee|appointed|confirmed)\b/i.test(context);
  const isPolitical = isUsedAsTitle || hasPoliticalKeywords;

  // Fetch article — prefer page-language, then target-language. NO English fallback for acronyms:
  // English Wikipedia may have a completely different meaning (e.g. IHS = Christogram, WIFO = radio station).
  const fetchBest = async (title) => {
    if (pageLang && pageLang !== 'en' && pageLang !== targetLang) {
      const r = await fetchWikiSummary(title, pageLang);
      if (r) return r;
    }
    if (targetLang && targetLang !== 'en') {
      const r = await fetchWikiSummary(title, targetLang);
      if (r) return r;
    }
    // Only use English if the user's target language IS English
    if (targetLang === 'en') return await fetchWikiSummary(title, 'en');
    return null;
  };

  const filterTitle = t => {
    if (/\bdisambiguation\b/i.test(t)) return false;
    if (/\b(county|district|village|city|town|commune|borough|municipality)\b/i.test(t)) return false;
    if (/\b(film|song|album|EP|TV\s+series|novel)\b/i.test(t)) return false;
    if (/\b(company|corporation|enterprise|energy|airline|airport|railway|fund|bank|group)\b/i.test(t)) return false;
    return true;
  };

  try {
    if (isPolitical) {
      const res = await fetch(
        'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=' +
        encodeURIComponent(word + ' politics prime minister title') +
        '&srnamespace=0&srlimit=3&srprop=&format=json&origin=*'
      );
      if (res.ok) {
        const data = await res.json();
        const hits = (data?.query?.search || []).map(h => h.title).filter(filterTitle);
        for (const title of hits.slice(0, 2)) {
          const r = await fetchBest(title);
          if (r) return r;
        }
      }
    }
    const res = await fetch(
      'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=' +
      encodeURIComponent(word) +
      '&srnamespace=0&srlimit=5&srprop=&format=json&origin=*'
    );
    if (!res.ok) return null;
    const data = await res.json();
    const hits = (data?.query?.search || []).map(h => h.title).filter(filterTitle);
    for (const title of hits.slice(0, 3)) {
      const r = await fetchBest(title);
      if (r) return r;
    }
  } catch {}
  return null;
}

async function lookupDefinition(word, targetLang = 'en', context = null) {
  // Hard-coded overrides for words that Wikipedia disambiguates incorrectly.
  // Add entries here when a word consistently returns the wrong article.
  // Format: lowercase word → English Wikipedia article title to use directly.
  const _PROPER_OVERRIDES = {
    'paris': 'Paris', // es.wiki "Paris" = Trojan prince; en.wiki "Paris" = capital of France
  };
  const _ovTitle = _PROPER_OVERRIDES[word.toLowerCase()];
  if (_ovTitle) {
    // Always use English Wikipedia for overrides — target-lang may have a different/wrong article.
    // e.g. es.wiki "Paris" = Trojan prince, en.wiki "Paris" = capital of France.
    const _ovResult = await fetchWikiSummary(_ovTitle, 'en');
    if (_ovResult) return [_ovResult];
  }
  // For capitalized words, try to build the full name from surrounding context
  // e.g. "Donald" + context "Donald Trump prend la parole" → look up "Donald Trump"
  const isCapitalized = word.length >= 2 &&
    word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase();

  let _fullNameTriedAndFailed = false;
  if (isCapitalized && context) {
    // Check for "El/La [word]" compound — handles "El Niño", "La Niña" (weather),
    // "El Chapo", "La Palma", etc. The word may appear ALL-CAPS in headlines.
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const article of ['El', 'La']) {
      if (new RegExp('(?:^|\\s)' + article + '\\s+' + escaped + '(?:\\s|$)', 'i').test(context)) {
        const titleCase = word[0].toUpperCase() + word.slice(1).toLowerCase();
        const compoundWiki = await lookupWikipedia(article + ' ' + titleCase, targetLang);
        if (compoundWiki) return [compoundWiki];
      }
    }

    // Don't expand common articles/prepositions (la, el, de, du, etc.) —
    // they cause false compounds like "La UE" (Spanish article + acronym).
    const isCommonFunctionWord = /^(la|le|les|el|los|las|de|du|des|il|lo|gli|di|da|das|die|der|ein|eine|une|un|the|a|an|al|del|dal|nel|sul)$/i.test(word);
    let fullName = isCommonFunctionWord ? word : extractFullName(word, context);
    // Strip leading articles from compound names like "Der VfGH" → "VfGH", "La UE" → "UE"
    // to avoid Wikipedia finding an article about the article word itself (e.g. "Der" = neopagan org)
    // Only do Wikipedia compound lookup when the fullName starts with uppercase (proper noun).
    // A fully-lowercase multi-word phrase like "längere frist" is NOT a proper noun.
    const _fullNameIsProper = fullName.length > 0 && fullName[0] === fullName[0].toUpperCase() && fullName[0] !== fullName[0].toLowerCase();
    if (_fullNameIsProper && fullName !== word && fullName.includes(' ')) {
      const _leadingArticleRe = /^(der|die|das|den|dem|des|ein|eine|einen|einem|einer|eines|le|la|les|l'|un|une|el|los|las|the|a|an|il|lo|i|gli|de|het|een)\s+/i;
      const _stripped = fullName.replace(_leadingArticleRe, '');
      if (_stripped !== fullName && _stripped.length > 1) fullName = _stripped;
    }
    if (fullName !== word && fullName.includes(' ')) {
      const wikiFullName = await lookupWikipedia(fullName, targetLang);
      if (wikiFullName) { const r = [wikiFullName]; r.displayName = fullName; return r; }
      _fullNameTriedAndFailed = true; // fullName lookup failed — skip single-word Wikipedia fallback
      // Full name hit a disambiguation page or was not found directly.
      // Try full-text search to find e.g. "Pablo Iglesias Turrion" or "Pablo Iglesias (politician)".
      try {
        const fnRes = await fetch(
          'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=' +
          encodeURIComponent(fullName) +
          '&srnamespace=0&srlimit=3&srprop=&format=json&origin=*'
        );
        if (fnRes.ok) {
          const fnData = await fnRes.json();
          // Require fnTitle to contain ALL significant words from fullName
          // e.g. fullName="Tamara Flores" → reject "Tamara Živković" (no "Flores")
          const _fnQueryWords = fullName.toLowerCase().split(/\s+/)
            .map(w => w.replace(/[^a-zà-ÿ]/gi, ''))
            .filter(w => w.length >= 4);
          const fnHits = (fnData?.query?.search || [])
            .map(h => h.title)
            .filter(t => !/\bdisambiguation\b/i.test(t))
            .filter(t => !/-(?:Tag|Day|Gedenktag|Memorial|Gedenkfeier)$/i.test(t))
            .filter(t => _fnQueryWords.length === 0 || _fnQueryWords.every(qw => t.toLowerCase().includes(qw)));
          for (const fnTitle of fnHits.slice(0, 2)) {
            const fnR = (targetLang && targetLang !== 'en')
              ? (await fetchWikiSummary(fnTitle, targetLang) || await fetchWikiSummary(fnTitle, 'en'))
              : await fetchWikiSummary(fnTitle, 'en');
            if (fnR) { const r = [fnR]; r.displayName = fullName; return r; }
          }
        }
      } catch {}
    }
  }

  // Wikipedia is only meaningful for proper nouns (capitalized words).
  // For lowercase common words (e.g. "defends"), OpenSearch returns unrelated
  // articles (e.g. "The Defenders" Marvel show) — skip Wikipedia entirely.
  if (isCapitalized && !_fullNameTriedAndFailed) {
    // German genitive -s: try stripped form ("Deutschlands"→"Deutschland", "Südafrikas"→"Südafrika").
    // Uses direct fetchWikiSummary only (no OpenSearch) to avoid false positives.
    // After finding in any language, converts to target language via English bridge.
    // "Haus"→"Hau", "Paris"→"Pari" → Spanish Wikipedia has "Pari (Estonia)" → wrong match.
    // Require ≥6 chars so "Paris" (5) is excluded but "Putins" (6), "Merkels" (7) etc. pass.
    if (word.endsWith('s') && !word.endsWith('ss') && word.length > 5) {
      const stripped = word.slice(0, -1);
      const tryLangs = targetLang && targetLang !== 'en' ? [targetLang, 'en', 'de'] : ['en', 'de'];
      let strippedWiki = null;
      let foundLang = null;
      for (const lang of tryLangs) {
        const r = await fetchWikiSummary(stripped, lang);
        if (r) { strippedWiki = r; foundLang = lang; break; }
      }
      if (strippedWiki) {
        const isCabinetList = /\b(shadow cabinet|cabinet|list of|members of|administration|ministry)\b/i.test(strippedWiki.title || '');
        if (!isCabinetList) {
          // Convert to target language using Wikipedia langlinks API
          // e.g. "Germany" (en) → langlinks → "Alemania" (es)
          // e.g. "Südafrika" (de) → langlinks → "Sudáfrica" (es)
          if (targetLang && targetLang !== foundLang) {
            const tlDirect = await fetchWikiSummary(strippedWiki.title, targetLang);
            if (tlDirect) {
              strippedWiki = tlDirect;
            } else {
              // Use langlinks API: get target-lang title from found article
              const tlTitle = await fetchWikiLangLink(strippedWiki.title, foundLang, targetLang);
              if (tlTitle) {
                const tlR = await fetchWikiSummary(tlTitle, targetLang);
                if (tlR) strippedWiki = tlR;
              } else if (foundLang !== 'en') {
                // Last resort: get en title via langlinks, then get target from en
                const enTitle = await fetchWikiLangLink(strippedWiki.title, foundLang, 'en');
                if (enTitle) {
                  const tlViaEn = await fetchWikiLangLink(enTitle, 'en', targetLang);
                  if (tlViaEn) {
                    const tlR = await fetchWikiSummary(tlViaEn, targetLang);
                    if (tlR) strippedWiki = tlR;
                  }
                }
              }
            }
          }
          const r = [strippedWiki];
          r.displayName = stripped;
          return r;
        }
      }
    }
    const wiki = await lookupWikipedia(word, targetLang);
    if (wiki) {
      // If the Wikipedia article title is a name/disambiguation meta-article
      // (e.g. "Reino (Vorname)", "Pablo (disambiguation)"), it describes the word
      // as a name rather than a specific entity — not useful as a definition.
      // Return null so the translation API handles the word instead.
      // Skip list/cabinet articles that OpenSearch returns for surnames
      // e.g. "Starmers" → "Starmer shadow cabinet" → wrong; try person search instead
      const isCabinetOrListArticle = /\b(shadow cabinet|cabinet|list of|members of|administration|ministry)\b/i.test(wiki.title || '');
      if (isCabinetOrListArticle && !word.includes(' ')) {
        const personWiki = await lookupWikipediaPersonFallback(word, targetLang);
        if (personWiki) return [personWiki];
        return null;
      }

      const isNameOrDisambigArticle = /\s*\((?:Vorname|given name|forename|first name|name|prénom|nome|desambiguación|disambiguation|Begriffsklärung)\)\s*$/i.test(wiki.title || '');
        if (isNameOrDisambigArticle) {
        // Disambiguation or name meta-article: try full-text person search before giving up.
        // e.g. "Merz" → "Merz (disambiguation)" → search → "Friedrich Merz" ✓
        if (!word.includes(' ')) {
          const personWiki = await lookupWikipediaPersonFallback(word, targetLang);
          if (personWiki) return [personWiki];
        }
        return null;
      }

      // Check geo/country only in the first sentence of the Wikipedia summary.
      // Geographic articles start with "Country in..." / "Municipality in..." etc.
      // Biographical articles start with "[Name] is a British politician..." but may
      // mention "United Kingdom" later — matching kingdom in full text causes false positives.
      const firstSentence = (wiki.text || '').split(/\.(?:\s|$)/)[0];
      const isGeoResult = /\b(commun[ae]|comun[ae]|municipalit[yé]|municipio|municipality|village|villaggio|pueblo|aldea|localidad|Gemeinde|gemeente|town\s+in|city\s+in|borough|hamlet|parish|census-designated|unincorporated)\b/i.test(firstSentence);
      const isCountryResult = /\b(country|sovereign state|nation-state|principality|duchy|island state|island nation|kingdom\s+in|republic\s+in|state\s+in|country\s+in)\b/i.test(firstSentence);
      if (isGeoResult || isCountryResult) {
        // Multi-word geo/country names ("Reino Unido", "New York") → skip person fallback,
        // return null so the translation API handles them directly.
        if (word.includes(' ')) return null;
        const personWiki = await lookupWikipediaPersonFallback(word, targetLang);
        if (personWiki) return [personWiki];
      }
      // Derive displayName from article title when it contains more than the searched word.
      // e.g. word="Pablo", title="Pablo Iglesias Turrion" -> displayName="Pablo Iglesias"
      const wikiTitle = wiki.title || '';
      const cleanedTitle = wikiTitle.replace(/\s*\(.*\)\s*$/, '').trim();
      const titleWords = cleanedTitle.split(/\s+/);
      if (titleWords.length >= 2 && titleWords[0].toLowerCase() === word.toLowerCase()) {
        const r = [wiki];
        r.displayName = titleWords.slice(0, 2).join(' ');
        return r;
      }
      return [wiki];
    }
  }
  // Direct Wikipedia lookup found nothing — try full-text person search as fallback.
  // Handles surnames like "Merz" where Wikipedia has "Friedrich Merz" but no standalone "Merz" article,
  // and direct lookup (fetchWikiSummary) returns null while the search API finds the person.
  if (isCapitalized && !_fullNameTriedAndFailed && !word.includes(' ') && word.length >= 3) {
    const personWiki = await lookupWikipediaPersonFallback(word, targetLang);
    if (personWiki) return [personWiki];
  }

  // FreeDictionary returns an array of {text, pos} (one per POS)
  if (targetLang === 'en') return lookupFreeDictionary(word);
  return null;
}

// Fallback when a Wikipedia direct-lookup returns a geographic article.
// Uses Wikipedia's full-text Search API (not OpenSearch) which finds "JD Vance"
// when searching "Vance", unlike OpenSearch which only matches title prefixes.
async function lookupWikipediaPersonFallback(word, targetLang) {
  // Fetch article — prefer target-language Wikipedia, fall back to English
  const fetchBest = async (title) => {
    if (targetLang && targetLang !== 'en') {
      const r = await fetchWikiSummary(title, targetLang);
      if (r) return r;
    }
    return await fetchWikiSummary(title, 'en');
  };
  // 1. Try common disambiguation suffixes first (cheap, exact)
  for (const suffix of ['(politician)', '(American politician)']) {
    const r = await fetchBest(`${word} ${suffix}`);
    if (r) return r;
  }
  // 1b. German genitive -s strip: "Starmers" → try "Starmer" directly, then via full-text search
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) {
    const stripped = word.slice(0, -1);
    // Direct lookup first
    const strippedR = await fetchBest(stripped);
    if (strippedR) {
      // Keep geo/country results (e.g. "Deutschland" → Germany is valid for "Deutschlands")
      // Only filter cabinet/list articles (e.g. "Starmer shadow cabinet" for "Starmers")
      const isCabinetList = /\b(shadow cabinet|cabinet|list of|members of|administration|ministry)\b/i.test(strippedR.title || '');
      if (!isCabinetList) return strippedR;
    }
    // Direct lookup blocked (cabinet/geo) — try full-text search for the stripped form
    try {
      const sRes = await fetch(
        `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(stripped)}&srnamespace=0&srlimit=3&srprop=&format=json&origin=*`
      );
      if (sRes.ok) {
        const sData = await sRes.json();
        const sHits = (sData?.query?.search || []).map(h => h.title)
          .filter(t => !/(disambiguation|cabinet|list of|members of)/i.test(t))
          .filter(t => !/, [A-Z]/.test(t))
          .filter(t => t.toLowerCase().includes(stripped.toLowerCase()));
        for (const sTitle of sHits.slice(0, 2)) {
          const sR = await fetchBest(sTitle);
          if (sR && !/\b(country|sovereign state|commun[ae])\b/i.test(sR.text)) return sR;
        }
      }
    } catch {}
  }
  // 2. Wikipedia full-text search — finds "JD Vance" for query "Vance"
  try {
    const res = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(word)}&srnamespace=0&srlimit=5&srprop=&format=json&origin=*`
    );
    if (!res.ok) return null;
    const data = await res.json();
    const hits = (data?.query?.search || [])
      .map(h => h.title)
      .filter(t => {
        const tl = t.toLowerCase();
        if (tl === word.toLowerCase()) return false;
        if (/, [A-Z]/.test(t)) return false;
        if (/\b(county|district|township|municipality|commune|borough|village|city|town)\b/i.test(t)) return false;
        // Skip year/event chronicle articles (e.g. "Events in the year 2026 in France",
        // "2024 European heatwaves") — these are never person articles and often appear in
        // full-text searches when the word is a place mentioned in news coverage.
        if (/\b(events?\s+in|events?\s+of|timeline\s+of|list\s+of|deaths?\s+in|births?\s+in)\b/i.test(t)) return false;
        if (/\b\d{4}\b/.test(t) && /\b(events?|heatwave|flood|fire|disaster|earthquake|hurricane|storm|crisis)\b/i.test(t)) return false;
        return true;
      });
    for (const title of hits.slice(0, 2)) {
      const r = await fetchBest(title);
      if (r) {
        // Skip if the fallback article is itself a geo/country entry — it's not a person.
        const isFallbackGeo = /\b(country|sovereign state|nation-state|republic|kingdom|empire|principality|duchy|state in|country in|commun[ae]|municipalit|village|city\s+in|town\s+in)\b/i.test(r.text);
        // Skip year/event chronicle articles — their TEXT starts with "Events in..."
        // even when the title is just "2026 in France" (no "events" keyword in title).
        const isEventChronicle = /\b(events?\s+(in|of|during)|timeline\s+of|deaths?\s+in|births?\s+in)\b/i.test(r.text) ||
          /^\d{4}\s+in\s+/i.test(r.title || '');
        // The article title must contain the searched word — otherwise it's a false positive
        // from full-text search (e.g. "European route E5" found because E5 passes through Pissos).
        // Person articles always have the person's name in the title (JD Vance, Donald Trump…).
        // Also accept genitive forms: "Starmers" → check if title contains "starmer"
        const wordLow = word.toLowerCase();
        const genitiveStripped = (wordLow.endsWith('s') && !wordLow.endsWith('ss') && wordLow.length > 3)
          ? wordLow.slice(0, -1) : null;
        const titleLow = (r.title || '').toLowerCase();
        const titleContainsWord = titleLow.includes(wordLow) ||
          (genitiveStripped && titleLow.includes(genitiveStripped));
        // Title's last word must also contain the queried word — prevents matching famous
        // people by first name only (e.g. "TAMARA" → "Tamara de Lempicka", last="Lempicka" ✗)
        // while still matching surnames: "Trump"→"Donald Trump" last="trump" ✓
        const _cleanTitle = (r.title || '').replace(/\s*\(.*\)\s*$/, '').trim();
        const _lastTitleWord = _cleanTitle.split(/\s+/).pop().toLowerCase().replace(/[^a-zà-ÿ]/gi, '');
        const titleEndsWithWord = _lastTitleWord.includes(wordLow) ||
          (genitiveStripped && _lastTitleWord.includes(genitiveStripped));
        if (!isFallbackGeo && !isEventChronicle && titleContainsWord && titleEndsWithWord) return r;
      }
    }
  } catch {}
  return null;
}

// Validates that a Wikipedia result title contains all significant words from the query.
// e.g. "Trump"→"Donald Trump" ✓ | "Tamara Flores"→"Austria in Eurovision 2026" ✗
function _wikiTitleMatchesQuery(title, query) {
  if (!title || !query) return false;
  // Normalize diacritics so "SINKEVICIUS" matches "Sinkevičius", "ZUCKER" matches "Zuckerberg" etc.
  const _nd = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const titleNorm = _nd(title);
  const words = _nd(query).split(/\s+/)
    .map(w => w.replace(/[^a-z]/gi, ''))
    .filter(w => w.length >= 4);
  return words.length === 0 || words.every(w => titleNorm.includes(w));
}

// For single-word queries: the article title's LAST word must contain the query.
// Prevents "TAMARA" matching "Tamara de Lempicka" (last="Lempicka" ≠ "tamara")
// while allowing "Trump"→"Donald Trump" (last="Trump" ✓) and "Merz"→"Friedrich Merz" ✓
// Diacritics normalized: "SINKEVICIUS" matches "Sinkevičius" (č→c).
function _wikiLastWordMatch(title, word) {
  if (!title || !word || word.includes(' ')) return true; // only for single-word queries
  const _nd = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const _cleanT = title.replace(/\s*\(.*\)\s*$/, '').trim();
  // Apply _nd FIRST (strips diacritics like č→c), then strip non-ascii letters.
  // [^a-zà-ÿ] would incorrectly drop chars above U+00FF (e.g. č=U+010D) before NFD.
  const _lastW = _nd(_cleanT.split(/\s+/).pop()).replace(/[^a-z]/g, '');
  const _wl = _nd(word).replace(/[^a-z]/g, '');
  return _lastW.includes(_wl);
}

async function lookupWikipedia(word, targetLang = 'en') {
  try {
    // 1. Try target-language Wikipedia (skipped when target is already English)
    if (targetLang !== 'en') {
      const targetResult = await fetchWikiSummary(word, targetLang);
      if (targetResult) {
        // For multi-word queries, validate the result title contains the significant words.
        // e.g. "Tamara Flores" → es.wikipedia returns "Tamara Živković" (redirect/wrong) → reject.
        if (word.includes(' ')) {
          const _qWords = word.toLowerCase().split(/\s+/)
            .map(w => w.replace(/[^a-zà-ÿ]/gi, '').toLowerCase())
            .filter(w => w.length >= 4);
          const _rTitle = (targetResult.title || '').toLowerCase();
          if (_qWords.length > 0 && !_qWords.every(qw => _rTitle.includes(qw))) {
            // Result title doesn't match query — skip this result
          } else {
            // If target-lang returned a biographical entry (person born in a year), also check
            // English Wikipedia before returning. Some target-lang Wikis have the same title
            // pointing to a person while the more notable entry is the concept/disease/etc.
            // e.g. "Ebola" → es.wikipedia = Icelandic musician, en.wikipedia = viral disease.
            const isBiographical = /\b(born|nacido|nació|né|geboren)\b.{0,30}\d{4}|\(\d{4}[–\-]/.test(targetResult.text);
            if (!isBiographical) return targetResult;
            const engResult = await fetchWikiSummary(word, 'en');
            if (engResult && _wikiTitleMatchesQuery(engResult.title, word)) {
              const engIsBio = /\bborn\b.{0,30}\d{4}|\(\d{4}[–\-]/.test(engResult.text);
              if (!engIsBio) return engResult; // English has a non-biographical result — prefer it
            }
            return targetResult; // Both biographical or no English result — keep target-lang
          }
        } else {
          // Single-word query: validate title matches query word
          if (!_wikiTitleMatchesQuery(targetResult.title, word) || !_wikiLastWordMatch(targetResult.title, word)) {
            // Title doesn't contain/end with the queried word — skip
          } else {
            // Also treat mythological/fictional character articles like biographical ones:
            // e.g. "Paris" → es.wiki = "príncipe troyano" (Paris de Troya), but en.wiki = Paris, France.
            const isBiographical = /\b(born|nacido|nació|né|geboren)\b.{0,30}\d{4}|\(\d{4}[–\-]/.test(targetResult.text);
            const isMythOrFiction = /\b(mitolog[ií]a|mythology|mythological|mitológico|leyenda|legend|personaje|fictional|ficticio|greek mythology|roman mythology|norse mythology|ancient greek)\b/i.test(targetResult.text);
            if (!isBiographical && !isMythOrFiction) return targetResult;
            const engResult = await fetchWikiSummary(word, 'en');
            if (engResult && _wikiTitleMatchesQuery(engResult.title, word) && _wikiLastWordMatch(engResult.title, word)) return engResult;
            return targetResult;
          }
        }
      }
    }

    // 2. Try English Wikipedia direct lookup
    const direct = await fetchWikiSummary(word, 'en');
    if (direct && _wikiTitleMatchesQuery(direct.title, word) && _wikiLastWordMatch(direct.title, word)) return direct;

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
    // If OpenSearch returns the exact same word as the title, it may be a redirect page.
    // Instead of rejecting, still fetch it — the REST API follows redirects and may resolve
    // to a proper article (e.g. "Sinkevicius" → redirect → "Virginijus Sinkevičius").
    // Only reject if no title returned at all.
    if (!articleTitle) return null;
    // Validate title contains all significant query words + last word match for single-word queries
    if (!_wikiTitleMatchesQuery(articleTitle, word)) return null;
    if (!_wikiLastWordMatch(articleTitle, word)) return null;

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
    if (title && (title.toLowerCase().includes('pablo') || title.toLowerCase().includes('iglesias'))) {
    }
    return { text: short, pos: '', title: data.title || '' };
  } catch {
    return null;
  }
}

// Free Dictionary API — English only, used only when target language is English
// https://dictionaryapi.dev  (free, no key)
// Given a Wikipedia article title in fromLang, returns the title of the same article
// in toLang using the Wikipedia langlinks API (e.g., "Germany"→"en"→"es"→"Alemania").
async function fetchWikiLangLink(title, fromLang, toLang) {
  try {
    const res = await fetch(
      `https://${fromLang}.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=langlinks&lllang=${toLang}&format=json&origin=*`
    );
    if (!res.ok) return null;
    const data = await res.json();
    const pages = Object.values(data?.query?.pages || {});
    if (!pages.length) return null;
    const ll = (pages[0].langlinks || []).find(l => l.lang === toLang);
    return ll ? ll['*'] : null;
  } catch { return null; }
}


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
  catch (e) { return null; }
  const enPosGroups = enResult.posGroups ?? [];

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
  const data = await chrome.storage.sync.get(['daily_date', 'daily_count', 'premium']);
  const isPremium = !!data.premium;
  let count = 0;
  if (data.daily_date === today) {
    count = data.daily_count || 0;
  } else {
    await chrome.storage.sync.set({ daily_date: today, daily_count: 0 });
  }
  return { count, limit: FREE_DAILY_LIMIT, isPremium };
}

async function incrementDailyCount() {
  const today = getToday();
  const data = await chrome.storage.sync.get(['daily_date', 'daily_count']);
  const newCount = (data.daily_date === today ? (data.daily_count || 0) : 0) + 1;
  await chrome.storage.sync.set({ daily_date: today, daily_count: newCount });
  return newCount;
}

function getToday() {
  return new Date().toISOString().split('T')[0];
}

// ---------------------------------------------------------------------------
// Premium key validation & activation
// ---------------------------------------------------------------------------

// Step 1: fast local HMAC check (catches typos without hitting the network).
async function validatePremiumKeyLocal(key) {
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

// Step 2: call the Cloudflare Worker to burn the key (one-time use).
// Returns { success, error } where error can be:
//   'INVALID_KEY'      — bad format or wrong HMAC
//   'KEY_ALREADY_USED' — key was already activated on another browser
//   'NETWORK_ERROR'    — could not reach the worker (offline, etc.)
async function activateKeyOnWorker(key) {
  try {
    const res = await fetch(`${LICENSE_WORKER_URL}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    if (!res.ok) return { success: false, error: 'NETWORK_ERROR' };
    return await res.json();
  } catch {
    return { success: false, error: 'NETWORK_ERROR' };
  }
}

async function activatePremium(key) {
  if (!key || typeof key !== 'string') return { success: false, error: 'INVALID_KEY' };
  const cleanKey = key.trim().toUpperCase();

  // 1. Quick local check before hitting the network
  const localValid = await validatePremiumKeyLocal(cleanKey);
  if (!localValid) return { success: false, error: 'INVALID_KEY' };

  // 2. Call the Worker to burn the key (prevents reuse on other browsers)
  const workerResult = await activateKeyOnWorker(cleanKey);
  if (!workerResult.success) return workerResult;

  // 3. Store premium status locally
  await chrome.storage.sync.set({ premium: true, premium_key: cleanKey });
  return { success: true };
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
  const data = await chrome.storage.sync.get('settings');
  return { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
}

async function saveSettings(newSettings) {
  const current = await getSettings();
  const merged = { ...current, ...newSettings };
  await chrome.storage.sync.set({ settings: merged });
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