import crypto from "crypto";
import { neon } from "@neondatabase/serverless";

export const config = {
  api: { bodyParser: false },
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

  const schedulingUrl = payload.payload?.event?.scheduling_url ||
                        payload.payload?.scheduling_url;

  if (!schedulingUrl) {
    return res.status(200).json({ ok: true, skipped: "no scheduling_url" });
  }

  const linkId = schedulingUrl.split("/").pop();
  const status = event === "invitee.created" ? "used" : "active";
  const usedAt = event === "invitee.created" ? new Date().toISOString() : null;
  // Store the event URI so we can look up invitee details later
  const eventUri = event === "invitee.created"
    ? (payload.payload?.event?.uri || null)
    : null;

  try {
    const sql = neon(process.env.DATABASE_URL);
    await sql`
      UPDATE links
      SET status = ${status}, used_at = ${usedAt},
          event_uri = COALESCE(${eventUri}, event_uri)
      WHERE id = ${linkId}
    `;
    console.log(`Webhook: ${event} -> link ${linkId} -> ${status}`);
  } catch (err) {
    console.error("Webhook DB error:", err.message);
    return res.status(500).json({ error: err.message });
  }

  return res.status(200).json({ ok: true });
}