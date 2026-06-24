# Plan Técnico: Hover Translator — Estado actual
> Última actualización: 2026-06-24 (sesión 3)

---

## Estado general

**✅ Publicada en Chrome Web Store**
https://chromewebstore.google.com/detail/hover-translator/pjbgkafflfgaaknaaekbnpjjohpeihoa

**Versión en store:** 1.0.2 · **En desarrollo (pendiente de subir):** 1.0.3
**Modelo:** Freemium — 100 palabras/día gratis · €14.99 pago único para Premium

---

## Arquitectura actual

```
hover-translator/
├── manifest.json               # MV3, v1.0.2 (store) / 1.0.3 en desarrollo
├── background.js               # Service worker (~2200 líneas): traducción, Wikipedia, caché
├── content.js                  # Content script: hover, tooltip, extracción de palabra
├── content.css                 # Estilos del tooltip
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── options/
│   ├── options.html            # Config: idioma, motor, email MyMemory, lista negra...
│   ├── options.js
│   └── options.css
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png

license-worker/                 # Cloudflare Worker para validación de licencias
├── worker.js
└── wrangler.toml

keygen.js                       # Script para generar claves premium
```

---

## Lo que está implementado ✅

### Motor de traducción
- **Google Translate** (gratuito, sin API key) como motor principal — endpoint gtx
- **MyMemory** como fallback (1.000 palabras/día anónimo, 10.000/día con email)
- **LibreTranslate** como opción avanzada (requiere servidor propio)
- Selección de motor desde la página de opciones

### Traducción inteligente
- **Chunk alignment**: usa la alineación fuente→destino de Google Translate para extraer la traducción exacta de la palabra en su contexto
- **Pivot para idiomas nórdicos/bálticos** (sv, da, no, fi, de, ru, etc.): word → English → target para mayor calidad
- **Suplemento de posGroups vía inglés**: cuando la par idioma directo tiene menos de 2 grupos POS, pivota para enriquecer las alternativas
- **Extracción por diff de frase**: traduce la frase con y sin la palabra, compara para encontrar la traducción contextual
- **Alineación posicional** como fallback cuando no hay chunks

### Casos especiales
- **Nombres propios**: detección por señales A (aparece igual en contexto) y B (divergencia de longitud >25%)
- **Wikipedia**: búsqueda automática para nombres propios, siglas y acrónimos
- **Acrónimos multiidioma**: diccionario `MULTILANG_ACRONYMS` con formato `{ wiki, names }` — devuelve el nombre en el idioma destino (ej. "UE" → "EU" en alemán) + definición Wikipedia en inglés. Cubre 30+ siglas en 10 idiomas (UE/EU, ONU/UN, OTAN/NATO, OMS/WHO, FMI/IMF, BCE/ECB, PIB/GDP, IVA/VAT, EEUU/USA, RU/UK, IA/AI, ADN/DNA, VIH/HIV, SIDA/AIDS, CEO, BBC, CNN...)
- **Verbo separable alemán (Trennbare Verben)**: detecta "bereitet...vor" → vorbereiten, con tabla de ~100 verbos conocidos
- **Francés l'/d'/j'**: strip del prefijo antes de enviar a la API
- **Mismo idioma**: detecta si la página ya está en el idioma destino y muestra definición en vez de traducción
- **Frases en Title Case**: multiword proper nouns → lookup Wikipedia directo

### Lógica alemán (v1.0.3)
- **Regla de mayúsculas**: en alemán, todos los sustantivos se escriben en mayúscula. Las palabras en minúscula NUNCA son sustantivos.
- **`_wordStartsUpper`**: si la palabra comienza en mayúscula → pivot habilitado (tratado como sustantivo/nombre propio). Si es minúscula → pivot deshabilitado (evita que "wolle" → "Wolle"=lana por el pivot).
- **`isGermanNoun`**: flag que indica que la palabra es un sustantivo alemán confirmado (capitalizada). Activa noun recovery y muestra grupos de sustantivo en posGroups.
- **`isGermanPage`**: flag devuelto por background.js para que content.js sepa si está en una página alemana sin acceso a `sourceLang`.
- **`_isGermanLower`** (content.js): `!isGermanNoun && isGermanPage && word[0] === lowercase`. Cuando true: filtra posGroups de sustantivo, suprime alternativas de sustantivo, activa `_sentenceOverride` solo para tokens únicos.
- **Noun recovery (lemma stripping)**: para sustantivos alemanes sin posGroups (ej. "Kriegen"), prueba suffixes ['nen','ern',...,'en','n','e','s'] para encontrar la forma base (ej. "Kriegen"→"Krieg"→"guerra"). Rechaza resultados que sean nombres propios (mayúscula en resultado) o ecos.
- **Re-pivot fallback bloqueado** para palabras alemanas en minúscula: evita que el re-pivot las trate como sustantivos.

### Diff de frase — lógica completa (v1.0.3)
El diff compara los tokens de la traducción de la frase CON la palabra vs SIN la palabra:
1. **`lostClitic`**: si un clítico reflexivo (se/me/te...) desaparece al quitar la palabra → busca el verbo de contenido más cercano después del clítico. Solo une clítico+verbo si aparecen **consecutivamente** en la frase (ej. "se prepara" ✓, "se...ha...vuelto" ✗).
2. **`_unique.length === 1`**: 1 token único → traducción directa.
3. **`_unique.length === 2`**: 2 tokens únicos → solo si aparecen consecutivos Y ninguno es palabra funcional española (se/de/la/el/ha…).
4. **`_unique.length === 3`, `_isGermanLowerVerb`**: para verbos alemanes en minúscula en Konjunktiv I, filtra infinitivos españoles (-ar/-er/-ir) como artefactos; usa el verbo conjugado restante si es único.
5. **Stem fallback** (nuevo en v1.0.3): si ninguno de los casos anteriores encontró nada, busca entre todos los tokens únicos aquel que comience con el stem de la traducción directa (ej. "rodear"→stem "rode"→encuentra "rodeada" para "Umgeben"). Seguro cuando exactamente 1 candidato coincide.

### Display de posGroups (v1.0.3)
- **`isGermanNoun=true`**: muestra solo grupos de sustantivo.
- **`_isGermanLower=true`**: muestra solo grupos de verbo (las palabras en minúscula alemanas nunca son sustantivos).
- **Todos los demás**: muestra TODOS los grupos POS disponibles (para que el usuario vea todas las acepciones posibles).
- **`_sentenceOverride`**: cuando `displayTranslation === sentenceExtracted` (el diff extrajo una traducción mejor), se fuerza el formato plano ignorando los posGroups (que pueden ser sesgados hacia sustantivos).
- **Multi-word `sentenceExtracted` para `_isGermanLower`**: se ignora (los verbos/adj alemanes siempre se traducen como una sola palabra; un resultado de 2+ palabras es un artefacto de reestructuración).

### Extracción de frase de contexto (v1.0.3+)
- `extractSentenceForNode(textNode, word)` ahora extrae la frase acotada por signos de puntuación (. ! ?) alrededor de la palabra, en vez de todo el bloque de texto. Aplica a todos los idiomas.
- **Excepción alemán (sesión 2)**: un punto tras dígito NO es fin de frase — cubre ordinales (`19. Februar`, `3. Kapitel`) y fechas/decimales (`19.02`, `3.14`). Implementado con helper `isSentenceBoundary(text, i)` que devuelve false cuando el `.` está precedido o seguido de un dígito.

### Tabla de palabras funcionales (sesión 2)
Palabras cuya eliminación de la frase reestructura la oración, haciendo el diff inútil. Se bypasea todo el pipeline y se devuelve una traducción hardcodeada.
- **Activa cuando**: target = español (`es`), source = uno de los 5 idiomas soportados.
- **Idiomas cubiertos**: alemán (40 palabras), francés (20), italiano (20), portugués (18), neerlandés (18).
- **Categorías mostradas**: `pron.` / `adv.` / `conj.` / `part.` (partículas modales alemanas: halt, mal, eben, wohl).
- **Alemán**: man, es, sich, einem, einen, etwas, jemand, nichts, auch, noch, schon, nur, sehr, viel, wenig, immer, nie, niemals, jetzt, hier, da, dann, so, wie, wo, wann, warum, halt, mal, eben, wohl, doch, aber, oder, denn, weil, wenn, ob, dass, obwohl, damit, trotzdem, deshalb, deswegen, außerdem.
- **Francés**: on, y, en, se, dont, rien, aussi, même, encore, déjà, jamais, toujours, très, trop, peu, beaucoup, bien, ne, si, donc, car, pourtant, cependant, or.
- **Italiano**: si, ci, vi, ne, niente, nulla, qualcosa, qualcuno, già, ancora, sempre, mai, anche, molto, poco, troppo, però, dunque, quindi, poiché, tuttavia, eppure.
- **Portugués**: se, lhe, lhes, nada, algo, alguém, ninguém, já, ainda, sempre, nunca, também, muito, pouco, mas, pois, porém, contudo, portanto, embora.
- **Neerlandés**: men, er, zich, iets, iemand, niets, ook, nog, al, heel, erg, weinig, veel, nooit, altijd, maar, dus, want, hoewel, toch.

### Freemium y licencias
- **Límite diario**: 100 palabras/día para free, guardado en `chrome.storage.sync` (persiste aunque el usuario desinstale y reinstale Chrome, mientras mantenga su cuenta de Google)
- **Sistema de clave premium**: validación HMAC local como pre-check rápido + llamada al Worker para quemar la clave
- **Cloudflare Worker** desplegado en `https://hover-translator-licenses.daniel-marina.workers.dev`
  - `POST /webhook?token=...` — Gumroad llama aquí en cada venta → genera clave → envía email via Resend
  - `POST /activate` — la extensión llama aquí al activar una clave → valida HMAC → comprueba KV → quema la clave
  - `GET /` — health check
- **Cloudflare KV** (`ACTIVATED_KEYS`, id: `9d39a739a87c4137a2122be36901758b`): registra qué claves ya han sido activadas — una clave solo puede activarse en un navegador
- **Keygen** (`keygen.js`): script para generar claves manualmente si es necesario
- **Gumroad**: webhook configurado con la URL del Worker
- **Resend**: envío de emails desde `licenses@promeseo.com`
- **Secrets**: guardados en `license-worker/SECRETS.md` (no subir a GitHub)

### Contenido de la tienda y marketing
- Chrome Store listing redactado (`chrome-store-listing.md`)
- Descripción Gumroad (`gumroad-description.md`)
- Screenshots de la tienda (`screenshot_*.png`)
- Imágenes de marketing (`marketing_*.png`, `gumroad_thumbnail.png`)
- Política de privacidad (`privacy-policy.html`)

### Scripts de deploy/fix
Hay varios scripts Python (`push_*.py`, `fix_*.py`) para aplicar correcciones puntuales al código y hacer deploy a GitHub. Documentan el historial de bugs resueltos.

---

## Bugs resueltos (historial de fix_*.py)

| Script | Fix |
|--------|-----|
| fix_allcaps_samelang.py | Palabras en MAYÚSCULAS en mismo idioma no se trataban como mismo idioma |
| fix_debug_pablo.py | Debug de nombres propios ("Pablo Iglesias") |
| fix_definition_displayname.py | displayName en definiciones de Wikipedia |
| fix_displayword_and_tag_filter.py | Filtrado de tags HTML en displayWord |
| fix_displayword_main_return.py | displayWord en el return principal |
| fix_extractfullname_leftward.py | extractFullName expandiendo hacia la izquierda (apellidos) |
| fix_fullname_disambiguation.py | Desambiguación de nombres completos en Wikipedia |
| fix_geo_*.py | Varios fixes para nombres geográficos y países |
| fix_person_fallback.py | Fallback para personas sin artículo Wikipedia |
| fix_pm_acronym.py | Acrónimo PM (Prime Minister vs Project Management) |
| fix_samelang_*.py | Varios fixes para detección de mismo idioma |
| fix_wiki_title_displayname.py | Título Wikipedia como displayName |

---

## Pendiente / Próximos pasos

### Bugs conocidos / mejoras en curso
- [x] Verbos reflexivos mal traducidos como sustantivos — "braces" → "tirantes" en vez de "se prepara" ✅
- [x] "Kriegen" → "guerras" (sustantivo alemán, recuperación por lemma stripping) ✅
- [x] "Krisen" → "crisis" (orden de suffixes corregido, rechazo de nombres propios) ✅
- [x] "wolle" → "quiere" (pivot deshabilitado para alemán minúscula, diff de 3 tokens) ✅
- [x] "kulturelle" → "cultural" (multi-word sentenceExtracted ignorado para alemán minúscula) ✅
- [x] "Umgeben" → "rodeada" (stem fallback en diff, lostClitic con check de consecutividad) ✅
- [x] Frase de contexto ahora acotada por puntuación real (. ! ?) ✅
- [x] posGroups: muestra TODAS las acepciones para palabras que no sean alemán especial ✅
- [x] Punto tras dígito en alemán no corta frase ("19. Februar", "19.02") ✅
- [x] "man", "es" y ~100 palabras funcionales más (de/fr/it/pt/nl) → tabla hardcodeada que bypasea el diff ✅
- [x] MULTILANG_ACRONYMS migrado a formato `{ wiki, names }` completo — "UE" ahora devuelve `translation: "EU"` (alemán) en vez de null ✅ (sesión 3)
- [ ] Revisar comportamiento con páginas sin atributo `lang` (pageLang = null)
- [ ] Mejorar detección de mismo idioma para páginas multilingüe
- [ ] Afinar chunk alignment para idiomas CJK (chino, japonés, coreano)
- [ ] Lista negra de dominios (ya hay UI en options, falta lógica)

### Monetización
- [x] Flujo Gumroad → webhook → Worker → email con clave ✅
- [x] Sistema anti-reutilización de claves (KV one-time burn) ✅
- [ ] Evaluar si €14.99 pago único es el precio óptimo o conviene suscripción
- [ ] Probar el flujo completo con una compra real de prueba en Gumroad

### Distribución
- [ ] Subir a Firefox Add-ons (el código MV3 es compatible con Firefox moderno)
- [ ] Preparar versión para Edge Add-ons (misma base de código)

### Funcionalidades futuras (opcionales)
- [ ] Lista negra de dominios (ya hay UI en options, falta lógica)
- [ ] Shortcut de teclado para activar/desactivar
- [ ] Modo "siempre visible" (tooltip fijo al hacer clic en la palabra)
- [ ] Historial de palabras traducidas

---

## Cómo trabajar en este proyecto

**Flujo de trabajo entre ordenadores:**
- Los archivos están en OneDrive (promeSeo) — siempre sincronizados
- Al abrir Claude Cowork, conectar la carpeta `Hover translator` de OneDrive
- Claude actualizará este archivo al final de cada sesión de trabajo

**Para publicar una nueva versión:**
1. Incrementar `version` en `manifest.json`
2. Probar en Chrome (`chrome://extensions` → Cargar descomprimida)
3. Hacer zip de la carpeta `hover-translator/`
4. Subir en Chrome Web Store Developer Dashboard
5. Actualizar este archivo con los cambios realizados
