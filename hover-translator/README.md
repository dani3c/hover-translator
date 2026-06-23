# Hover Translator — Chrome Extension

Instant word translations on hover. No clicking, no copying — just move your cursor over any word and a tooltip appears with the translation.

[Install from Chrome Web Store](https://chromewebstore.google.com/detail/hover-translator/pjbgkafflfgaaknaaekbnpjjohpeihoa) · [Privacy Policy](https://danmarina.github.io/hover-translator/privacy-policy.html)

---

## How it works

Move your cursor over any word on any webpage. A compact tooltip appears in under a second with:

- The translation in your chosen language
- A context phrase so you understand the word in use
- A Wikipedia summary for proper nouns (people, places, brands, acronyms)

## Supported languages

Spanish, English, French, German, Italian, Portuguese, Dutch, Polish, Russian, Ukrainian, Chinese, Japanese, Korean, Arabic, Turkish, Swedish, Danish, Finnish, Czech, Greek, Hindi, Indonesian, and more.

## Freemium model

| Plan | Words/day | Price |
|------|-----------|-------|
| Free | 100 | Free |
| Premium | Up to 10,000* | €14.99 one-time |

\*With email registration in the Translation Engine settings (see below).

## Translation engines (Premium)

Premium users can choose their translation engine in the extension settings:

### MyMemory (default)
[MyMemory](https://mymemory.translated.net/) is a free translation API backed by a large translation memory database.

- **Anonymous**: 1,000 words/day
- **With email**: 10,000 words/day — add your email in Settings → Translation Engine → MyMemory. MyMemory only uses it to identify your quota — no password, no account creation needed.
- No server setup required

### LibreTranslate (advanced)
[LibreTranslate](https://libretranslate.com/) is an open-source, self-hostable translation engine.

- Requires your own server instance (e.g. a €5/month VPS)
- Full control over your data — nothing leaves your server
- Some public instances exist but are unstable; self-hosting is recommended
- [How to install LibreTranslate](https://github.com/LibreTranslate/LibreTranslate#install-and-run)

To use it: Settings → Translation Engine → LibreTranslate → enter your server URL (and API key if required).

## Privacy

No account required. No browsing history stored or shared. Translations are sent to the selected API (MyMemory or your LibreTranslate instance) and nothing else. See the [full privacy policy](https://danmarina.github.io/hover-translator/privacy-policy.html).

## Development

The extension uses Chrome Manifest V3 with a service worker (`background.js`) handling all translation and Wikipedia lookups. The content script (`content.js`) handles hover detection and tooltip rendering.

```
hover-translator/
├── manifest.json
├── background.js       # Service worker: translation logic, Wikipedia API, caching
├── content.js          # Content script: hover detection, tooltip UI
├── icons/
└── options/
    ├── options.html
    ├── options.css
    └── options.js
```

## License

© Daniel Marina. All rights reserved.
