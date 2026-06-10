const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const fetch = require("node-fetch");
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CX = process.env.GOOGLE_CX;

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// ── LinkedIn URL fallback via Google ──────────────────────────────
async function findLinkedInUrl(firstName, lastName, company) {
  if (!GOOGLE_API_KEY || !GOOGLE_CX) return null;
  const q = encodeURIComponent(`${firstName} ${lastName} ${company} site:linkedin.com/in`);
  try {
    const r = await fetch(`https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${q}&num=1`);
    const data = await r.json();
    const item = data.items && data.items[0];
    return (item && item.link) || null;
  } catch { return null; }
}

// ── Apollo enrichment ──────────────────────────────────────────────
app.post("/enrich", async (req, res) => {
  const apolloKey = process.env.APOLLO_API_KEY;
  const { apolloKey: _ignored, ...params } = req.body;
  if (!apolloKey) return res.status(500).json({ error: "Apollo API key not configured on server" });

  try {
    const r = await fetch("https://api.apollo.io/v1/people/match", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": apolloKey },
      body: JSON.stringify({ ...params, reveal_personal_emails: true }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.message || "Apollo error" });

    // Fallback: find LinkedIn URL via Google if Apollo didn't return one
    const person = data.person || {};
    if (!person.linkedin_url && req.body.first_name) {
      person.linkedin_url = await findLinkedInUrl(
        req.body.first_name, req.body.last_name || "", req.body.organization_name || ""
      );
      data.person = person;
    }

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Send email ─────────────────────────────────────────────────────
app.post("/send-email", async (req, res) => {
  const { smtpHost, smtpPort, fromEmail, emailPass, fromName, to, subject, body } = req.body;
  if (!fromEmail || !emailPass || !to) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost || "smtp.gmail.com",
    port: parseInt(smtpPort) || 587,
    secure: false,
    auth: { user: fromEmail, pass: emailPass },
  });

  try {
    await transporter.sendMail({
      from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
      to,
      subject,
      text: body,
    });
    res.json({ status: "sent", to });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
