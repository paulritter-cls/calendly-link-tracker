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

  // In the Calendly webhook payload:
  // payload.payload.event  = URI string e.g. "https://api.calendly.com/scheduled_events/UUID"
  // payload.payload.scheduling_link.booking_url = the one-time link URL
  const eventUri      = payload.payload?.event || null;
  const bookingUrl    = payload.payload?.scheduling_link?.booking_url || null;
  const schedulingUrl = bookingUrl || payload.payload?.scheduled_event?.scheduling_url || null;

  // Log the full payload structure for debugging (first 500 chars)
  console.log("Webhook payload keys:", JSON.stringify(Object.keys(payload.payload || {})));
  console.log("event field:", eventUri);
  console.log("scheduling_link:", JSON.stringify(payload.payload?.scheduling_link));
  console.log("booking_url:", bookingUrl);

  if (!schedulingUrl && !eventUri) {
    return res.status(200).json({ ok: true, skipped: "no scheduling info found", payloadKeys: Object.keys(payload.payload || {}) });
  }

  // Extract link ID from booking URL slug, or fall back to event URI slug
  const linkId = schedulingUrl
    ? schedulingUrl.split("/").pop()
    : null;

  if (!linkId) {
    console.log("Could not determine linkId from payload");
    return res.status(200).json({ ok: true, skipped: "no linkId", eventUri });
  }

  const status = event === "invitee.created" ? "used" : "active";
  const usedAt = event === "invitee.created" ? new Date().toISOString() : null;
  // eventUri is already the full URI string from payload.payload.event
  const storedEventUri = event === "invitee.created" ? eventUri : null;

  try {
    const sql = neon(process.env.DATABASE_URL);
    await sql`
      UPDATE links
      SET status = ${status}, used_at = ${usedAt},
          event_uri = COALESCE(${storedEventUri}, event_uri)
      WHERE id = ${linkId}
    `;
    console.log(`Webhook: ${event} -> link ${linkId} -> ${status}, eventUri: ${storedEventUri}`);
  } catch (err) {
    console.error("Webhook DB error:", err.message);
    return res.status(500).json({ error: err.message });
  }

  return res.status(200).json({ ok: true });
}