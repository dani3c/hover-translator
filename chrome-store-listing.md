# Chrome Web Store — Hover Translator Listing

---

## Extension name
Hover Translator

---

## Short description (132 chars max)
Instant word translations on hover — no clicking, no copying. Free for 100 words/day. Unlimited* with Premium.

_(129 chars)_

---

## Detailed description

Hover Translator lets you read any webpage in any language without interrupting your flow. Just hover over a word and a small tooltip appears instantly with the translation — no clicking, no right-clicking, no copy-pasting.

**How it works**
Move your cursor over any word on any webpage. A compact tooltip appears in under a second with:
- The translation in your chosen language
- A phonetic context phrase so you understand it in use
- A Wikipedia summary for proper nouns (people, places, brands)

**Supports 20+ languages**
Spanish, English, French, German, Italian, Portuguese, Dutch, Polish, Russian, Ukrainian, Chinese, Japanese, Korean, Arabic, Turkish, Swedish, Danish, Finnish, Czech, Greek, Hindi, Indonesian, and more.

**Smart word detection**
Works correctly with CJK languages (Chinese, Japanese, Korean), Arabic, and all European languages including special characters and diacritics.

**Always getting better**
We release updates every month — improving translation accuracy, fixing edge cases, and adding new language support. Every bug report and piece of feedback shapes the next release.

**Freemium — free to try, fair to use**
- ✅ Free: 100 word translations per day
- ⭐ Premium: Unlimited* translations for a one-time payment of €14.99 — choose your preferred translation engine

_*Up to 10,000 translations/day — more than you could ever use in a day of normal browsing._

If Hover Translator saves you time every day, consider going Premium. It's a one-time payment that directly funds continued development and keeps the updates coming. Thank you for your support 🙏

**Found a bug? We want to hear from you**
Spotted something that doesn't translate correctly? Write to us at info@promeseo.com and we'll do our best to fix it in the next release.

**Privacy first**
No account required. No data collected. Translations are processed via external APIs but your browsing history is never stored or shared. See our full privacy policy for details.

---

## Category
Productivity

_(Alternative: Education)_

---

## Language
English

---

## Privacy policy URL
https://danmarina.github.io/hover-translator/privacy-policy.html

---

## Single purpose description
_(Required for extensions with broad host permissions)_

This extension translates individual words on webpages when the user hovers over them. The broad host permission (`https://*/*`) is required so the content script can run on any webpage the user visits, which is the core functionality of the extension.

---

## Store icon
Use icon128.png (already in the ZIP)

---

## Screenshots
- screenshot_1_translation.png — word translation tooltip
- screenshot_2_definition.png — proper noun Wikipedia definition

---

## Promo tile (optional, 440×280)
Use gumroad_thumbnail.png if available, or leave blank for MVP submission.

---

## What's new — v1.0.3
_(Paste this in the "What's new in this version" field when submitting the update)_

**v1.0.3 — Smarter translations & stability fixes**

🔧 **Critical fix:** The extension now installs and works correctly from the Chrome Web Store. Previous versions (1.0.1, 1.0.2) had a packaging issue that caused hover translations to not appear after installation.

🇩🇪 **Better German support**
- Function words like *man*, *es*, *sich*, *doch*, *weil* and 40+ more now show accurate translations instead of being confused with English words
- Dates and ordinals (*19. Februar*, *3. Kapitel*) are no longer split mid-sentence
- Verb forms like *Umgeben* now correctly show *rodeada* (past participle in context)
- Adjectives like *kulturelle* and verb forms like *wolle* now translate correctly

🌍 **More languages improved**
- French: *on*, *y*, *en*, *donc* and 20+ function words fixed
- Italian: *si*, *ci*, *ne*, *già*, *però* and more
- Portuguese and Dutch: common pronouns and conjunctions corrected

🏛️ **Proper nouns & acronyms**
- *UE*, *OTAN*, *OMS* and 30+ acronyms now show the correct name in your language (not just English)
- *Deutschlands*, *Südafrikas* now link to Wikipedia in your target language
- Ambiguous names like *PARIS* resolve to the city, not the mythological figure
- Parenthetical expansions (*"IHS (Institut für Höhere Studien)"*) detected automatically

---

## Version history

| Version | Date | Summary |
|---------|------|---------|
| 1.0.3 | 2026-06 | Critical ZIP fix, German function words, proper noun improvements |
| 1.0.2 | 2026-06 | German noun/verb logic, sentence diff improvements |
| 1.0.1 | 2026-05 | Initial public release |
