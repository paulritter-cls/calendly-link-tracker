/**
 * Calendly webhook receiver.
 * Calendly POSTs here when an invitee books a one-time link.
 *
 * 1. Verifies the request signature using WEBHOOK_SIGNING_KEY
 * 2. Extracts the scheduling_link URI from the event payload
 * 3. Stores the "used" status in Vercel KV (key-value store)
 *
 * Vercel KV setup:
 *   - Go to your Vercel project → Storage → Create KV database
 *   - It auto-adds KV_REST_API_URL and KV_REST_API_TOKEN to your env vars
 */
import crypto from "crypto";
import { kv } from "@vercel/kv";

// Verify Calendly's HMAC-SHA256 signature
function verifySignature(rawBody, signature, secret) {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export const config = {
  api: { bodyParser: false }, // Need raw body for signature check
};

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const rawBody = await getRawBody(req);
  const signature = req.headers["calendly-webhook-signature"];
  const signingKey = process.env.WEBHOOK_SIGNING_KEY;

  // Verify signature if signing key is configured
  if (signingKey) {
    if (!signature) return res.status(401).json({ error: "Missing signature" });
    try {
      // Calendly signature format: "t=<timestamp>,v1=<hash>"
      const v1Hash = signature.split(",").find(p => p.startsWith("v1="))?.slice(3);
      const timestamp = signature.split(",").find(p => p.startsWith("t="))?.slice(2);
      const toSign = `${timestamp}.${rawBody}`;
      if (!verifySignature(toSign, v1Hash, signingKey)) {
        return res.status(401).json({ error: "Invalid signature" });
      }
    } catch {
      return res.status(401).json({ error: "Signature verification failed" });
    }
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const event = payload.event;

  // We care about bookings and cancellations
  if (event === "invitee.created" || event === "invitee.canceled") {
    const schedulingLink = payload.payload?.scheduling_url;
    const linkUri = payload.payload?.event?.scheduling_link?.uri;

    if (linkUri) {
      const linkId = linkUri.split("/").pop();
      const status = event === "invitee.created" ? "used" : "active";
      const usedAt = event === "invitee.created" ? new Date().toISOString() : null;

      // Store in Vercel KV so frontend can poll for updates
      await kv.hset(`link:${linkId}`, { status, usedAt });
      console.log(`Webhook: link ${linkId} → ${status}`);
    }
  }

  return res.status(200).json({ received: true });
}