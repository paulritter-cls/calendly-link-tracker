/**
 * Serverless proxy for Calendly API calls.
 * Keeps the API key server-side and handles CORS for the frontend.
 *
 * Usage:
 *   GET  /api/calendly?path=/users/me
 *   GET  /api/calendly?path=/event_types%3Fuser%3D...
 *   POST /api/calendly?path=/scheduling_links   body: { ... }
 */
export default async function handler(req, res) {
  // Allow requests from your own frontend only
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const { path } = req.query;
  if (!path) return res.status(400).json({ error: "Missing ?path= parameter" });

  const apiKey = process.env.CALENDLY_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "CALENDLY_API_KEY not configured" });

  const url = `https://api.calendly.com${path}`;

  try {
    const upstream = await fetch(url, {
      method: req.method === "POST" ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      ...(req.method === "POST" && { body: JSON.stringify(req.body) }),
    });

    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: "Upstream request failed", detail: err.message });
  }
}