// Meta Conversions API relay — receives browser beacons and forwards to Graph API
// with server-side signals (IP / User-Agent / fbp / fbc) for better match quality.
// Requires env var META_CAPI_TOKEN (Vercel → Settings → Environment Variables).
// Browser pixel sends the same event_id, so Meta dedupes the two channels.

const PIXEL_ID = '1665016335272219';
const GRAPH = 'https://graph.facebook.com/v21.0';

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const token = process.env.META_CAPI_TOKEN;
  if (!token) { res.status(200).json({ skipped: 'META_CAPI_TOKEN not set' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || !body.event_name || !body.event_id) {
    res.status(400).json({ error: 'event_name and event_id required' }); return;
  }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const payload = {
    data: [{
      event_name: body.event_name,
      event_time: Math.floor(Date.now() / 1000),
      event_id: body.event_id,
      action_source: 'website',
      event_source_url: body.event_source_url || 'https://joinknct.com/',
      user_data: {
        client_ip_address: ip || undefined,
        client_user_agent: req.headers['user-agent'] || undefined,
        fbp: body.fbp || undefined,
        fbc: body.fbc || undefined,
      },
      custom_data: body.custom_data || undefined,
    }],
  };
  if (body.test_event_code) payload.test_event_code = body.test_event_code;

  try {
    const r = await fetch(`${GRAPH}/${PIXEL_ID}/events?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    res.status(r.ok ? 200 : 502).json(r.ok ? { ok: true, events_received: j.events_received } : { error: j.error && j.error.message });
  } catch (e) {
    res.status(502).json({ error: 'relay failed' });
  }
};
