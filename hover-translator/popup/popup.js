// =============================================================================
// Hover Translator — Popup Script
// =============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const toggleEnabled  = document.getElementById('toggle-enabled');
  const toggleState    = document.getElementById('toggle-state');
  const targetLang     = document.getElementById('target-lang');
  const usageCount     = document.getElementById('usage-count');
  const usageBarFill   = document.getElementById('usage-bar-fill');
  const usageRemaining = document.getElementById('usage-remaining');
  const usageSection   = document.getElementById('usage-section');
  const premiumActive  = document.getElementById('premium-active');
  const premiumSection = document.getElementById('premium-section');
  const limitSection   = document.getElementById('limit-section');
  const keySection     = document.getElementById('key-section');
  const btnActivate    = document.getElementById('btn-activate');
  const btnActivateLimit = document.getElementById('btn-activate-limit');
  const btnValidate    = document.getElementById('btn-validate');
  const btnOptions     = document.getElementById('btn-options');
  const premiumKeyInput = document.getElementById('premium-key');
  const keyError       = document.getElementById('key-error');

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
  const isEnabled = settings.enabled !== false;
  toggleEnabled.checked = isEnabled;
  updateToggleLabel(isEnabled);
  targetLang.value = settings.targetLang || 'es';

  // Apply usage
  renderUsage(usage);

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  // Toggle extension on/off
  toggleEnabled.addEventListener('change', async () => {
    const enabled = toggleEnabled.checked;
    updateToggleLabel(enabled);
    await chrome.runtime.sendMessage({
      type: 'SAVE_SETTINGS',
      settings: { enabled }
    });
  });

  // Change target language — save immediately, no confirm needed
  targetLang.addEventListener('change', async () => {
    await chrome.runtime.sendMessage({
      type: 'SAVE_SETTINGS',
      settings: { targetLang: targetLang.value }
    });
  });

  // Show premium key input (from standard CTA)
  btnActivate.addEventListener('click', showKeyInput);
  // Show premium key input (from limit-reached CTA)
  btnActivateLimit.addEventListener('click', showKeyInput);

  function showKeyInput() {
    premiumSection.style.display = 'none';
    limitSection.style.display   = 'none';
    keySection.style.display     = 'block';
    premiumKeyInput.focus();
  }

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

  function updateToggleLabel(enabled) {
    toggleState.textContent = enabled ? 'On' : 'Off';
    toggleState.classList.toggle('off', !enabled);
  }

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
      usageSection.style.display  = 'none';
      premiumActive.style.display = 'flex';
      premiumSection.style.display = 'none';
      limitSection.style.display  = 'none';
      return;
    }

    // Usage bar
    const pct       = Math.min((count / limit) * 100, 100);
    const remaining = limit - count;
    usageCount.textContent     = `${count} / ${limit}`;
    usageBarFill.style.width   = `${pct}%`;

    // Color thresholds: normal → warning (≥70%) → danger (≥90% or at limit)
    const isAtLimit  = count >= limit;
    const isDanger   = count >= limit * 0.9;
    const isWarning  = count >= limit * 0.7;

    usageBarFill.classList.toggle('warning', isWarning && !isDanger);
    usageBarFill.classList.toggle('danger',  isDanger);

    // Remaining words hint
    if (isAtLimit) {
      usageRemaining.textContent = 'Limit reached';
      usageRemaining.className   = 'usage-remaining danger';
      usageRemaining.style.display = 'block';
    } else if (isWarning) {
      usageRemaining.textContent   = `${remaining} word${remaining !== 1 ? 's' : ''} left today`;
      usageRemaining.className     = `usage-remaining ${isDanger ? 'danger' : 'warning'}`;
      usageRemaining.style.display = 'block';
    } else {
      usageRemaining.style.display = 'none';
    }

    // CTA: limit-reached variant vs standard upsell
    if (isAtLimit) {
      premiumSection.style.display = 'none';
      limitSection.style.display   = 'block';
    } else {
      premiumSection.style.display = 'block';
      limitSection.style.display   = 'none';
    }
  }
});
