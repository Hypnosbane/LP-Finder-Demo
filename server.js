const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const fetch = require("node-fetch");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// ── Apollo enrichment ──────────────────────────────────────────────
app.post("/enrich", async (req, res) => {
  const { apolloKey, ...params } = req.body;
  if (!apolloKey) return res.status(400).json({ error: "Missing Apollo API key" });

  try {
    const r = await fetch("https://api.apollo.io/v1/people/match", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": apolloKey },
      body: JSON.stringify({ ...params, reveal_personal_emails: true }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.message || "Apollo error" });
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

app.listen(3001, () => console.log("Server running on http://localhost:3001"));
