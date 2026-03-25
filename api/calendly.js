/**
 * Serverless proxy for Calendly API calls.
 * Accepts the API key from the request header (set by the frontend).
 * This keeps requests server-side (no CORS), without needing
 * an env variable — the user provides their token via the UI.
 */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-calendly-token");

  if (req.method === "OPTIONS") return res.status(200).end();

  const { path } = req.query;
  if (!path) return res.status(400).json({ error: "Missing ?path= parameter" });

  // Token comes from the UI via a custom header — never hardcoded
  const apiKey = req.headers["x-calendly-token"];
  if (!apiKey) return res.status(401).json({ error: "Missing x-calendly-token header" });

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
