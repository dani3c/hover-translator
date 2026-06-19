// =============================================================================
// Hover Translator — Popup Script
// =============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const toggleEnabled = document.getElementById('toggle-enabled');
  const targetLang = document.getElementById('target-lang');
  const usageCount = document.getElementById('usage-count');
  const usageBarFill = document.getElementById('usage-bar-fill');
  const usageSection = document.getElementById('usage-section');
  const premiumActive = document.getElementById('premium-active');
  const premiumSection = document.getElementById('premium-section');
  const keySection = document.getElementById('key-section');
  const btnActivate = document.getElementById('btn-activate');
  const btnValidate = document.getElementById('btn-validate');
  const btnOptions = document.getElementById('btn-options');
  const premiumKeyInput = document.getElementById('premium-key');
  const keyError = document.getElementById('key-error');

  // Load settings and usage
  let settings = {};
  let usage = {};

  try {
    [settings, usage] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }),
      chrome.runtime.sendMessage({ type: 'GET_USAGE' })
    ]);
  } catch {
    // Background not ready
  }

  // Apply settings
  toggleEnabled.checked = settings.enabled !== false;
  targetLang.value = settings.targetLang || 'es';

  // Apply usage
  renderUsage(usage);

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  // Toggle extension on/off
  toggleEnabled.addEventListener('change', async () => {
    await chrome.runtime.sendMessage({
      type: 'SAVE_SETTINGS',
      settings: { enabled: toggleEnabled.checked }
    });
  });

  // Change target language
  targetLang.addEventListener('change', async () => {
    await chrome.runtime.sendMessage({
      type: 'SAVE_SETTINGS',
      settings: { targetLang: targetLang.value }
    });
  });

  // Show premium key input
  btnActivate.addEventListener('click', () => {
    premiumSection.style.display = 'none';
    keySection.style.display = 'block';
    premiumKeyInput.focus();
  });

  // Validate premium key
  btnValidate.addEventListener('click', validateKey);
  premiumKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') validateKey();
  });

  // Open options page
  btnOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // -------------------------------------------------------------------------
  // Functions
  // -------------------------------------------------------------------------

  async function validateKey() {
    const key = premiumKeyInput.value.trim();
    if (!key) return;

    btnValidate.disabled = true;
    btnValidate.textContent = '...';
    keyError.style.display = 'none';

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'ACTIVATE_PREMIUM',
        key
      });

      if (result && result.success) {
        // Reload usage to show premium state
        usage = await chrome.runtime.sendMessage({ type: 'GET_USAGE' });
        renderUsage(usage);
        keySection.style.display = 'none';
      } else {
        keyError.style.display = 'block';
        premiumKeyInput.select();
      }
    } catch {
      keyError.style.display = 'block';
    } finally {
      btnValidate.disabled = false;
      btnValidate.textContent = 'OK';
    }
  }

  function renderUsage(u) {
    if (!u) return;
    const { count = 0, limit = 100, isPremium = false } = u;

    if (isPremium) {
      usageSection.style.display = 'none';
      premiumActive.style.display = 'flex';
      premiumSection.style.display = 'none';
    } else {
      const pct = Math.min((count / limit) * 100, 100);
      usageCount.textContent = `${count} / ${limit}`;
      usageBarFill.style.width = `${pct}%`;
      usageBarFill.classList.toggle('danger', count >= limit * 0.8);
    }
  }
});
