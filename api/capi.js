// Meta Conversions API relay — receives browser beacons and forwards to Graph API
// with server-side signals (IP / User-Agent / fbp / fbc) for better match quality.
// Requires env var META_CAPI_TOKEN (Vercel → Settings → Environment Variables).
// Browser pixel sends the same event_id, so Meta dedupes the two channels.
//
// Hardening (2026-09-19 security audit):
//  - only requests originating from this site (Origin / Referer) are relayed
//  - event_name is restricted to the events index.html actually emits
//  - custom_data is reduced to known keys with bounded string values
//  - event_source_url is only accepted when it points at this site
//  - test_event_code is not accepted from the client
//  - upstream error text is never echoed to the caller

const PIXEL_ID = '1665016335272219';
const GRAPH = 'https://graph.facebook.com/v21.0';
const SITE_URL = 'https://joinknct.com/';

const ALLOWED_EVENTS = new Set(['PageView', 'VideoPlay', 'Lead']);
const CUSTOM_KEYS = ['video_id', 'area', 'content_name', 'content_category'];
const MAX_ID_LEN = 64;
const MAX_STR_LEN = 100;
const MAX_URL_LEN = 2048;

// joinknct.com, any subdomain of it, and this project's Vercel preview/production hosts
const ORIGIN_RE = /^https:\/\/([a-z0-9-]+\.)*joinknct\.com$/i;
const VERCEL_RE = /^https:\/\/knctuniversity(-[a-z0-9-]+)?\.vercel\.app$/i;

function isAllowedOrigin(origin) {
  return ORIGIN_RE.test(origin) || VERCEL_RE.test(origin);
}

function originOfReferer(referer) {
  try { return new URL(referer).origin; } catch (e) { return ''; }
}

function shortString(v, max) {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;
}

function pickCustomData(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out = {};
  for (const k of CUSTOM_KEYS) {
    const v = shortString(raw[k], MAX_STR_LEN);
    if (v !== undefined) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function pickSourceUrl(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_URL_LEN) return SITE_URL;
  try {
    const u = new URL(raw);
    return isAllowedOrigin(u.origin) ? u.href : SITE_URL;
  } catch (e) { return SITE_URL; }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  // Same-site gate: browsers always send Origin on POST; Referer is the fallback.
  const origin = String(req.headers.origin || '') || originOfReferer(String(req.headers.referer || ''));
  if (!isAllowedOrigin(origin)) { res.status(403).json({ error: 'forbidden' }); return; }

  const token = process.env.META_CAPI_TOKEN;
  if (!token) { res.status(200).json({ skipped: 'META_CAPI_TOKEN not set' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== 'object') { res.status(400).json({ error: 'invalid body' }); return; }

  const eventName = typeof body.event_name === 'string' && ALLOWED_EVENTS.has(body.event_name) ? body.event_name : null;
  const eventId = shortString(body.event_id, MAX_ID_LEN);
  if (!eventName || !eventId) { res.status(400).json({ error: 'invalid event' }); return; }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const payload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      action_source: 'website',
      event_source_url: pickSourceUrl(body.event_source_url),
      user_data: {
        client_ip_address: ip || undefined,
        client_user_agent: shortString(req.headers['user-agent'], 512),
        fbp: shortString(body.fbp, MAX_STR_LEN),
        fbc: shortString(body.fbc, 512),
      },
      custom_data: pickCustomData(body.custom_data),
    }],
  };

  try {
    const r = await fetch(`${GRAPH}/${PIXEL_ID}/events?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      // Log server-side for the owner; never expose Meta's error text to the caller.
      const j = await r.json().catch(() => ({}));
      console.error('capi relay upstream error', r.status, j && j.error && j.error.message);
      res.status(502).json({ error: 'relay failed' }); return;
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('capi relay failed', e && e.message);
    res.status(502).json({ error: 'relay failed' });
  }
};
