/**
 * Receives Calendly webhook events and updates link status in Neon Postgres.
 * Calendly POSTs here instantly when someone books or cancels via a one-time link.
 *
 * Setup (one time):
 *   1. Deploy this file
 *   2. Run the curl command in the deploy guide to register the webhook with Calendly
 *   3. Add CALENDLY_WEBHOOK_SECRET to Vercel env vars (any string you choose)
 */
import crypto from "crypto";
import { neon } from "@neondatabase/serverless";

export const config = {
  api: { bodyParser: false }, // need raw body to verify signature
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function verifySignature(rawBody, signatureHeader, secret) {
  // Calendly signature header format: "t=<timestamp>,v1=<hmac>"
  const parts = Object.fromEntries(
    signatureHeader.split(",").map(p => p.split("=", 2))
  );
  if (!parts.t || !parts.v1) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${parts.t}.${rawBody}`)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const rawBody = await getRawBody(req);
  const secret = process.env.CALENDLY_WEBHOOK_SECRET;

  // Verify signature if secret is configured
  if (secret) {
    const sig = req.headers["calendly-webhook-signature"];
    if (!sig || !verifySignature(rawBody, sig, secret)) {
      return res.status(401).json({ error: "Invalid signature" });
    }
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const { event } = payload;
  if (event !== "invitee.created" && event !== "invitee.canceled") {
    return res.status(200).json({ ok: true, skipped: true });
  }

  // Extract the booking URL from the event payload
  // The scheduling_url on the event tells us which one-time link was used
  const schedulingUrl = payload.payload?.event?.scheduling_url ||
                        payload.payload?.scheduling_url;

  if (!schedulingUrl) {
    console.log("Webhook: no scheduling_url in payload", JSON.stringify(payload).slice(0, 300));
    return res.status(200).json({ ok: true, skipped: "no scheduling_url" });
  }

  const linkId = schedulingUrl.split("/").pop();
  const status = event === "invitee.created" ? "used" : "active";
  const usedAt = event === "invitee.created" ? new Date().toISOString() : null;

  try {
    const sql = neon(process.env.DATABASE_URL);
    await sql`
      UPDATE links SET status = ${status}, used_at = ${usedAt}
      WHERE id = ${linkId}
    `;
    console.log(`Webhook: ${event} → link ${linkId} set to ${status}`);
  } catch (err) {
    console.error("Webhook DB error:", err.message);
    return res.status(500).json({ error: err.message });
  }

  return res.status(200).json({ ok: true });
}
