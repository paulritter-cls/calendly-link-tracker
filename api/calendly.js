/**
 * Serverless proxy for Calendly API calls.
 * Token passed via x-calendly-token header — never hardcoded.
 *
 * Special handling for POST /webhook_subscriptions:
 * If signing_key is "auto", replaces it with CALENDLY_WEBHOOK_SECRET env var
 * so the secret never has to be in the browser.
 */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-calendly-token");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { path } = req.query;
  if (!path) return res.status(400).json({ error: "Missing ?path= parameter" });

  const apiKey = req.headers["x-calendly-token"];
  if (!apiKey) return res.status(401).json({ error: "Missing x-calendly-token header" });

  let body = req.method === "POST" ? req.body : undefined;

  // Replace "auto" signing_key with the real secret from env
  if (path === "/webhook_subscriptions" && body?.signing_key === "auto") {
    const secret = process.env.CALENDLY_WEBHOOK_SECRET;
    if (!secret) return res.status(500).json({ error: "CALENDLY_WEBHOOK_SECRET not set in Vercel env vars" });
    body = { ...body, signing_key: secret };
  }

  try {
    const upstream = await fetch(`https://api.calendly.com${path}`, {
      method: req.method === "POST" ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: "Upstream request failed", detail: err.message });
  }
}
