// =============================================================================
// Hover Translator — License Worker (Cloudflare Workers)
// =============================================================================
//
// Endpoints:
//   POST /webhook?token=XXX   — Gumroad sale → generate key → send email
//   POST /activate            — Extension activation → burn key in KV (one-time)
//   GET  /                    — Health check
//
// Environment variables (set in Cloudflare dashboard or via wrangler secret put):
//   HMAC_SECRET       — must match background.js exactly
//   RESEND_API_KEY    — from resend.com
//   WEBHOOK_TOKEN     — random secret to protect the webhook URL
//   FROM_EMAIL        — e.g. "Hover Translator <licenses@yourdomain.com>"
//
// KV namespace binding (wrangler.toml):
//   ACTIVATED_KEYS    — stores activated license keys
// =============================================================================

// ---------------------------------------------------------------------------
// Key generation (called on Gumroad sale)
// ---------------------------------------------------------------------------
async function generateKey(secret) {
  const randomBytes = new Uint8Array(6);
  crypto.getRandomValues(randomBytes);
  const data = Array.from(randomBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .substring(0, 8)
    .toUpperCase();

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', keyMaterial, encoder.encode(data));
  const hmac = Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .substring(0, 8)
    .toUpperCase();

  return `HVTR-${data}-${hmac}`;
}

// ---------------------------------------------------------------------------
// HMAC validation (same logic as background.js — single source of truth here)
// ---------------------------------------------------------------------------
async function validateKeyHmac(key, secret) {
  const parts = key.trim().toUpperCase().split('-');
  if (parts.length !== 3 || parts[0] !== 'HVTR') return false;
  const data = parts[1];
  const providedHash = parts[2];
  if (data.length !== 8 || providedHash.length !== 8) return false;
  try {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', encoder.encode(secret),
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
// Email delivery (Resend)
// ---------------------------------------------------------------------------
async function sendEmail(to, key, env) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.RESEND_API_KEY}`
    },
    body: JSON.stringify({
      from: env.FROM_EMAIL || 'Hover Translator <noreply@resend.dev>',
      to: [to],
      subject: 'Your Hover Translator Premium License Key',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
          <h2 style="color:#1e1e2e">Thank you for your purchase! 🎉</h2>
          <p>Here is your Hover Translator Premium license key:</p>
          <div style="background:#f5f5f5;border-radius:8px;padding:16px;text-align:center;
                      font-size:22px;font-weight:bold;letter-spacing:3px;
                      font-family:monospace;color:#1e1e2e;margin:20px 0">
            ${key}
          </div>
          <p><strong>How to activate:</strong></p>
          <ol>
            <li>Click the Hover Translator icon in your Chrome toolbar</li>
            <li>Scroll down to the <em>Premium</em> section</li>
            <li>Paste the key and click <strong>Activate</strong></li>
          </ol>
          <p style="color:#666;font-size:13px">
            This key can only be activated once. If you need to transfer it to a new
            device, reply to this email and we'll reissue it.
          </p>
        </div>
      `
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error ${res.status}: ${err}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// CORS headers (extension origin)
// ---------------------------------------------------------------------------
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Health check
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('Hover Translator License Worker OK', { status: 200 });
    }

    // ── POST /activate ───────────────────────────────────────────────────────
    // Called by the extension when the user enters a license key.
    // Validates HMAC, then checks KV to ensure the key hasn't been used before.
    // On first use: burns the key in KV and returns { success: true }.
    // On reuse: returns { success: false, error: 'KEY_ALREADY_USED' }.
    if (request.method === 'POST' && url.pathname === '/activate') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ success: false, error: 'INVALID_REQUEST' }, 400);
      }

      const key = (body.key || '').trim().toUpperCase();
      if (!key) return json({ success: false, error: 'MISSING_KEY' }, 400);

      // 1. Validate HMAC (catches typos and fake keys without hitting KV)
      const hmacValid = await validateKeyHmac(key, env.HMAC_SECRET);
      if (!hmacValid) {
        return json({ success: false, error: 'INVALID_KEY' });
      }

      // 2. Check if already activated in KV
      const existing = await env.ACTIVATED_KEYS.get(key);
      if (existing !== null) {
        // Key already burned — reject
        return json({ success: false, error: 'KEY_ALREADY_USED' });
      }

      // 3. Burn the key: store activation record in KV (no expiry = permanent)
      const record = JSON.stringify({
        activated_at: new Date().toISOString(),
        user_agent: request.headers.get('User-Agent') || ''
      });
      await env.ACTIVATED_KEYS.put(key, record);

      return json({ success: true });
    }

    // ── POST /webhook ────────────────────────────────────────────────────────
    // Called by Gumroad on each sale. Generates a key and emails it to the buyer.
    if (request.method === 'POST' && url.pathname === '/webhook') {
      // Verify secret token
      if (url.searchParams.get('token') !== env.WEBHOOK_TOKEN) {
        return new Response('Unauthorized', { status: 401 });
      }

      let payload;
      try {
        const contentType = request.headers.get('content-type') || '';
        if (contentType.includes('application/x-www-form-urlencoded')) {
          const text = await request.text();
          payload = Object.fromEntries(new URLSearchParams(text));
        } else {
          payload = await request.json();
        }
      } catch {
        return new Response('Invalid payload', { status: 400 });
      }

      // Ignore test purchases
      if (payload.test === 'true' || payload.test === true) {
        return new Response('Test purchase — ignored', { status: 200 });
      }

      const email = payload.email || payload.purchaser_email;
      if (!email) return new Response('No buyer email', { status: 400 });

      try {
        const key = await generateKey(env.HMAC_SECRET);
        await sendEmail(email, key, env);
        console.log(`Key sent to ${email}: ${key}`);
        return json({ success: true });
      } catch (err) {
        console.error('Error:', err.message);
        return new Response(`Error: ${err.message}`, { status: 500 });
      }
    }

    return new Response('Not found', { status: 404 });
  }
};
