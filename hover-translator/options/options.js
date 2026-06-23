// =============================================================================
// Hover Translator — Options Script
// =============================================================================

document.addEventListener('DOMContentLoaded', async () => {

  // Elements
  const sourceLang      = document.getElementById('source-lang');
  const targetLang      = document.getElementById('target-lang');
  const hoverDelay      = document.getElementById('hover-delay');
  const hoverDelayVal   = document.getElementById('hover-delay-value');
  const providerRadios  = document.querySelectorAll('input[name="provider"]');
  const mmOptions       = document.getElementById('mymemory-options');
  const ltOptions       = document.getElementById('lt-options');
  const mmEmail         = document.getElementById('mm-email');
  const apiUrl          = document.getElementById('api-url');
  const apiKey          = document.getElementById('api-key');
  const blacklist       = document.getElementById('blacklist');
  const btnSave         = document.getElementById('btn-save');
  const btnTest         = document.getElementById('btn-test');
  const testResult      = document.getElementById('test-result');
  const saveStatus      = document.getElementById('save-status');
  const usageDisplay    = document.getElementById('usage-display');
  const btnActivate     = document.getElementById('btn-activate');
  const premiumKeyEl    = document.getElementById('premium-key');
  const keyError        = document.getElementById('key-error');
  const freeStatus      = document.getElementById('premium-status-free');
  const activeStatus    = document.getElementById('premium-status-active');

  // -------------------------------------------------------------------------
  // Load current settings
  // -------------------------------------------------------------------------
  let settings = {};
  let usage = {};

  try {
    [settings, usage] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }),
      chrome.runtime.sendMessage({ type: 'GET_USAGE' })
    ]);
  } catch { /* background not ready */ }

  // Apply to form
  sourceLang.value = settings.sourceLang || 'auto';
  targetLang.value = settings.targetLang || 'es';
  hoverDelay.value = settings.hoverDelay || 400;
  hoverDelayVal.textContent = `${hoverDelay.value}ms`;
  mmEmail.value = settings.email || '';
  apiUrl.value = settings.apiUrl || '';
  apiKey.value = settings.apiKey || '';
  blacklist.value = (settings.blacklist || []).join('\n');

  // Set provider radio
  const savedProvider = settings.provider || 'mymemory';
  providerRadios.forEach(r => { r.checked = (r.value === savedProvider); });
  updateProviderUI(savedProvider);

  // Usage display + show engine section only for premium
  const engineSection = document.getElementById('engine-section');
  if (usage.isPremium) {
    freeStatus.style.display = 'none';
    activeStatus.style.display = 'block';
    if (engineSection) engineSection.style.display = 'block';
  } else {
    usageDisplay.textContent = `${usage.count || 0} / ${usage.limit || 100} words`;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  hoverDelay.addEventListener('input', () => {
    hoverDelayVal.textContent = `${hoverDelay.value}ms`;
  });

  providerRadios.forEach(r => {
    r.addEventListener('change', () => updateProviderUI(r.value));
  });

  btnSave.addEventListener('click', saveSettings);
  btnTest.addEventListener('click', testConnection);

  btnActivate.addEventListener('click', activatePremium);
  premiumKeyEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') activatePremium();
  });

  // -------------------------------------------------------------------------
  // Provider UI toggle
  // -------------------------------------------------------------------------
  function updateProviderUI(provider) {
    mmOptions.style.display = provider === 'mymemory' ? 'block' : 'none';
    ltOptions.style.display = provider === 'libretranslate' ? 'block' : 'none';
  }

  function getSelectedProvider() {
    for (const r of providerRadios) { if (r.checked) return r.value; }
    return 'mymemory';
  }

  // -------------------------------------------------------------------------
  // Save settings
  // -------------------------------------------------------------------------
  async function saveSettings() {
    const blacklistLines = blacklist.value
      .split('\n')
      .map(l => l.trim().toLowerCase())
      .filter(Boolean);

    const newSettings = {
      provider: getSelectedProvider(),
      sourceLang: sourceLang.value,
      targetLang: targetLang.value,
      hoverDelay: parseInt(hoverDelay.value),
      email: mmEmail.value.trim(),
      apiUrl: apiUrl.value.trim(),
      apiKey: apiKey.value.trim(),
      blacklist: blacklistLines
    };

    try {
      await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: newSettings });
      settings = { ...settings, ...newSettings };
      showSaveStatus();
    } catch (err) {
      alert('Error saving: ' + err.message);
    }
  }

  function showSaveStatus() {
    saveStatus.style.display = 'block';
    setTimeout(() => { saveStatus.style.display = 'none'; }, 2500);
  }

  // -------------------------------------------------------------------------
  // Test API connection (routed through background.js to avoid CORS issues)
  // -------------------------------------------------------------------------
  async function testConnection() {
    testResult.textContent = 'Testing...';
    testResult.className = 'test-result loading';

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'TEST_CONNECTION',
        provider: getSelectedProvider(),
        apiUrl: apiUrl.value.trim(),
        apiKey: apiKey.value.trim(),
        email: mmEmail.value.trim()
      });

      if (result && result.ok) {
        testResult.textContent = `✓ Connection OK — "hello" → "${result.sample}"`;
        testResult.className = 'test-result ok';
      } else {
        testResult.textContent = `✗ ${result?.error || 'Unknown error'}`;
        testResult.className = 'test-result err';
      }
    } catch (err) {
      testResult.textContent = `✗ Internal error: ${err.message}`;
      testResult.className = 'test-result err';
    }
  }

  // -------------------------------------------------------------------------
  // Premium key activation
  // -------------------------------------------------------------------------
  async function activatePremium() {
    const key = premiumKeyEl.value.trim();
    if (!key) return;

    btnActivate.disabled = true;
    btnActivate.textContent = '...';
    keyError.style.display = 'none';

    try {
      const result = await chrome.runtime.sendMessage({ type: 'ACTIVATE_PREMIUM', key });
      if (result && result.success) {
        freeStatus.style.display = 'none';
        activeStatus.style.display = 'block';
        if (engineSection) engineSection.style.display = 'block';
        showSaveStatus();
      } else {
        keyError.style.display = 'block';
      }
    } catch {
      keyError.style.display = 'block';
    } finally {
      btnActivate.disabled = false;
      btnActivate.textContent = 'Activate';
    }
  }
});
