import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { readFile, writeFile } from "node:fs/promises";

const app = express();
const client = new OpenAI({
apiKey: process.env.GROQ_API_KEY,
baseURL: "https://api.groq.com/openai/v1"
});
const HISTORY_FILE = "./history.json";

app.use(express.json({ limit: "16mb" }));
app.use(express.static("public"));

app.get("/api/config", (req, res) => res.json({
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY
}));

app.use("/api", async (req, res, next) => {
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    if (!token) return res.status(401).json({ error: "Please login" });
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: "Bearer " + token } },
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data, error } = await db.auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: "Invalid session" });
    req.user = data.user;
    req.supabase = db;
    next();
  } catch {
    res.status(401).json({ error: "Authentication failed" });
  }
});

async function getHistory(db, userId) {
  const { data, error } = await db.from("chat_history")
    .select("id, role, content, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

app.get("/api/history", async (req, res) => {
  try {
    res.json(await getHistory(req.supabase, req.user.id));
  } catch {
    console.error("AUGUST AI ERROR:", error.status || "", error.message || "Unknown error");
    res.status(500).json({ error: "Could not load history" });
  }
});

app.delete("/api/history/:index", async (req, res) => {
  try {
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0)
      return res.status(404).json({ error: "Message not found" });

    const { data, error } = await req.supabase.from("chat_history")
      .select("id").eq("user_id", req.user.id)
      .order("created_at", { ascending: true })
      .range(index, index).maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Message not found" });

    const result = await req.supabase.from("chat_history")
      .delete().eq("id", data.id).eq("user_id", req.user.id);
    if (result.error) throw result.error;
    res.json({ message: "Message deleted" });
  } catch {
    console.error("AUGUST AI ERROR:", error.status || "", error.message || "Unknown error");
    res.status(500).json({ error: "Could not delete message" });
  }
});

app.delete("/api/history", async (req, res) => {
  const { error } = await req.supabase.from("chat_history")
    .delete().eq("user_id", req.user.id);
    console.error("AUGUST AI ERROR:", error.status || "", error.message || "Unknown error");
  if (error) return res.status(500).json({ error: "Could not clear history" });
  res.json({ message: "Chat history deleted" });
});

app.post("/api/chat", async (req, res) => {
  try {
    const message = String(req.body.message || "").trim();
    const image = typeof req.body.image === "string" ? req.body.image : "";
    if (!message) {
      return res.status(400).json({ error: "Message is empty" });
    }

    const previousHistory = await getHistory(req.supabase, req.user.id);
    const history = [...previousHistory, { role: "user", content: message }];
    const currentDateTime = new Intl.DateTimeFormat("en-IN", {
      dateStyle: "full",
      timeStyle: "long",
      timeZone: "Asia/Kolkata"
    }).format(new Date());

    const isNewsSearch = /news|headline|khabar|samachar|खबर|समाचार/i.test(message);
    const isTodaySearch = /today|aaj|आज/i.test(message);

    const needsWebSearch = !image && /latest|today|current|right now|live|news|headline|weather|temperature|stock price|exchange rate|aaj|abhi|taaja|taza|khabar|samachar|mausam|vartaman|आज|अभी|ताज़ा|ताजा|खबर|समाचार|मौसम|वर्तमान/i.test(message);

    const detectedLanguage = /[\u0900-\u097F]/.test(message)
      ? "Hindi"
      : /\b(kya|kaise|kyun|hai|hain|ho|mera|meri|mujhe|aap|tum|batao|karo|nahi|nahin|aaj|abhi)\b/i.test(message)
        ? "Hinglish"
        : "English";

    let tavilySearchContext = "No web search requested.";
    if (needsWebSearch) {
      if (!process.env.TAVILY_API_KEY) {
        throw new Error("Tavily API key is missing.");
      }

      const searchResponse = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + process.env.TAVILY_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          query: message,
          topic: isNewsSearch ? "news" : "general",
          ...(isTodaySearch && isNewsSearch ? { time_range: "day" } : {}),
          search_depth: "basic",
          max_results: 5,
          include_answer: true
        })
      });

      if (!searchResponse.ok) {
        throw new Error("Tavily search failed with HTTP " + searchResponse.status);
      }

      const searchData = await searchResponse.json();
      tavilySearchContext = JSON.stringify({
        answer: searchData.answer || "",
        results: (searchData.results || []).map(item => ({
          title: item.title,
          url: item.url,
          content: item.content,
          published_date: item.published_date
        }))
      });
    }

    const ownerEmails = String(process.env.OWNER_EMAILS || "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
    const isOwner = ownerEmails.includes(String(req.user.email || "").trim().toLowerCase());
    const userName = String(req.user.user_metadata?.full_name || "").trim();
    const completion = await client.chat.completions.create({
      model: image ? "qwen/qwen3.8-27b" : "openai/gpt-oss-20b",
      max_completion_tokens: 3072,
      reasoning_effort: "low",
      messages: [
        { role: "system", content: `You are August AI, an advanced AI assistant created by Prateek Agrahari.

IDENTITY (HIGHEST PRIORITY):
- You are August AI, an AI chatbot created by Prateek Agrahari (प्रतीक अग्रहरी).
- If asked who created you, answer: I was created by Prateek Agrahari.
- Never claim that OpenAI or ChatGPT created you.
- Never identify yourself as ChatGPT or an OpenAI assistant.
- Never invent a company, team, launch date, or additional founders for August AI.
- These identity rules have priority over conversation history.
- CURRENT USER: ${isOwner ? "Address this user as Boss." : "Address this user by their signup name when available; never call them Boss."}
- USER NAME: ${userName || "Not provided"}
- If anyone asks who created or founded August AI, answer: Prateek Agrahari. This is true for all users.
- Answer questions about ChatGPT and OpenAI with accurate facts. Never claim Prateek Agrahari created ChatGPT.
- Never invent facts about your creator or reveal private family information.

INTELLIGENCE:
- Understand the user's intent and context.
- Reason carefully and solve complex problems.
- Break difficult tasks into simple steps.
- Help with education, science, mathematics, coding and research.
- Admit uncertainty instead of guessing.

COMMUNICATION:
- Reply in the language of the current user message.
- English = English, Hindi = Hindi, Hinglish = Hinglish.
- Be natural, clear, respectful and concise.
- Avoid unnecessary symbols and excessive formatting.

AI ASSISTANT CAPABILITIES:
- Help users plan, learn, research and solve problems.
- Write, debug and explain code.
- Help build websites and applications.
- Understand images when image input is available.
- Support voice conversations when available.
- Use Tavily search results when available.
- Never claim to have performed an action that you did not perform.

PRIVACY AND SAFETY:
- Protect user conversations and private information.
- Never reveal passwords, API keys or tokens.
- Ask permission before actions affecting devices or user data.
- Be honest about your capabilities and limitations.
- Never invent facts, sources or search results.

CURRENT INDIA DATE AND TIME: ${currentDateTime}

TAVILY LIVE SEARCH RESULTS:
${tavilySearchContext}` },
        ...previousHistory.filter(item => item.role === "user" || item.role === "assistant").slice(-8).map(item => ({ role: item.role, content: item.content })), 
        { role: "user", content: image ? [{ type: "text", text: message }, { type: "image_url", image_url: { url: image } }] : message }
      ]
    });

    const rawContent = completion.choices?.[0]?.message?.content;
    if (!rawContent || !String(rawContent).trim()) {
      await writeFile("./error.log", new Date().toISOString() + " | Empty response | " + JSON.stringify({ finish_reason: completion.choices?.[0]?.finish_reason, usage: completion.usage }) + "\n", { flag: "a" });
      throw new Error("Groq returned an empty response");
    }
    const answer = String(rawContent).trim();
    const { error: userSaveError } = await req.supabase.from("chat_history")
      .insert({ user_id: req.user.id, role: "user", content: message });
    if (userSaveError) throw userSaveError;

    const { error: answerSaveError } = await req.supabase.from("chat_history")
      .insert({ user_id: req.user.id, role: "assistant", content: answer });
    if (answerSaveError) throw answerSaveError;
    res.json({ answer });
  } catch (error) {
    await writeFile("./error.log", new Date().toISOString() + " | Groq error: " + (error.status || "") + " | " + (error.message || "Unknown error") + "\n", { flag: "a" });
    console.error("AUGUST AI ERROR:", error.status || "", error.message || "Unknown error");
    res.status(500).json({
      error: String(error.message || "").toLowerCase().includes("tavily") ? "News search failed. Check the Tavily API key in Render." : "AI response failed. Check Render logs."
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`August AI running on port ${PORT}`));
