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

// ── Groq proxy ────────────────────────────────────────────────────
app.post("/claude", async (req, res) => {
  try {
    // Convert Anthropic-format messages to OpenAI/Groq format
    const { messages, system, tools, max_tokens } = req.body;
    const groqMessages = [];
    if (system) groqMessages.push({ role: "system", content: system });
    for (const m of messages) {
      if (typeof m.content === "string") {
        groqMessages.push({ role: m.role, content: m.content });
      } else if (Array.isArray(m.content)) {
        // tool results from user turn
        for (const block of m.content) {
          if (block.type === "tool_result") {
            groqMessages.push({ role: "tool", tool_call_id: block.tool_use_id, content: block.content });
          } else if (block.type === "text") {
            groqMessages.push({ role: m.role, content: block.text });
          } else if (block.type === "tool_use") {
            // assistant tool call already handled below
          }
        }
        // assistant messages with tool_use blocks
        const toolUses = m.content.filter(b => b.type === "tool_use");
        const textBlocks = m.content.filter(b => b.type === "text");
        if (toolUses.length && m.role === "assistant") {
          groqMessages.push({
            role: "assistant",
            content: textBlocks.map(b => b.text).join("\n") || null,
            tool_calls: toolUses.map(t => ({
              id: t.id, type: "function",
              function: { name: t.name, arguments: JSON.stringify(t.input) }
            }))
          });
        }
      }
    }

    // Convert Anthropic tools to OpenAI format
    const groqTools = tools ? tools.map(t => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema }
    })) : undefined;

    const body = {
      model: "llama3-70b-8192",
      max_tokens: max_tokens || 1000,
      messages: groqMessages,
      ...(groqTools ? { tools: groqTools, tool_choice: "auto" } : {})
    };

    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || "Groq error" });

    // Convert Groq response back to Anthropic format
    const choice = data.choices[0];
    const msg = choice.message;
    const content = [];
    if (msg.content) content.push({ type: "text", text: msg.content });
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments) });
      }
    }
    res.json({ content, stop_reason: msg.tool_calls ? "tool_use" : "end_turn" });
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
