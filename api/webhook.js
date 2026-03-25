/**
 * Link storage API using Neon Postgres.
 * Vercel auto-injects DATABASE_URL when you connect Neon via the Marketplace.
 *
 * GET    /api/links              → get all links
 * POST   /api/links              → create a link  { action:"create", ...linkFields }
 * PATCH  /api/links?id=xxx       → update status  { status, usedAt }
 * DELETE /api/links?id=xxx       → delete a link
 */
import { neon } from "@neondatabase/serverless";

function getDb() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  return neon(process.env.DATABASE_URL);
}

// Ensure table exists — runs on every cold start (idempotent)
async function ensureTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS links (
      id           TEXT PRIMARY KEY,
      uri          TEXT,
      url          TEXT NOT NULL,
      label        TEXT NOT NULL,
      event_name   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      status       TEXT NOT NULL DEFAULT 'active',
      used_at      TIMESTAMPTZ
    )
  `;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  let sql;
  try {
    sql = getDb();
    await ensureTable(sql);
  } catch (err) {
    return res.status(500).json({ error: "DB init failed: " + err.message });
  }

  try {
    // GET — return all links ordered newest first
    if (req.method === "GET") {
      const rows = await sql`
        SELECT id, uri, url, label, event_name, created_at, status, used_at
        FROM links
        ORDER BY created_at DESC
      `;
      const links = rows.map(r => ({
        id: r.id,
        uri: r.uri,
        url: r.url,
        label: r.label,
        eventName: r.event_name,
        createdAt: r.created_at,
        status: r.status,
        usedAt: r.used_at,
      }));
      return res.status(200).json({ links });
    }

    // POST — create a new link
    if (req.method === "POST") {
      const { id, uri, url, label, eventName, createdAt, status } = req.body;
      if (!id || !url || !label) return res.status(400).json({ error: "Missing required fields" });
      await sql`
        INSERT INTO links (id, uri, url, label, event_name, created_at, status)
        VALUES (${id}, ${uri || null}, ${url}, ${label}, ${eventName || null}, ${createdAt || new Date().toISOString()}, ${status || "active"})
        ON CONFLICT (id) DO NOTHING
      `;
      return res.status(201).json({ ok: true });
    }

    // PATCH — update status/usedAt, or backfill event_name for all null rows
    if (req.method === "PATCH") {
      const { id } = req.query;

      // Bulk backfill: PATCH /api/links?backfill=1 { eventName }
      if (req.query.backfill) {
        const { eventName } = req.body;
        if (!eventName) return res.status(400).json({ error: "Missing eventName" });
        await sql`UPDATE links SET event_name = ${eventName} WHERE event_name IS NULL`;
        return res.status(200).json({ ok: true });
      }

      if (!id) return res.status(400).json({ error: "Missing ?id=" });
      const { status, usedAt } = req.body;
      await sql`UPDATE links SET status = ${status}, used_at = ${usedAt || null} WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    // DELETE — remove a link
    if (req.method === "DELETE") {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: "Missing ?id=" });
      await sql`DELETE FROM links WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).end();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
