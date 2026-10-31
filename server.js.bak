import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import { readFile, writeFile } from "node:fs/promises";

const app = express();
const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1"
});
const HISTORY_FILE = "./history.json";

app.use(express.json());
app.use(express.static("public"));

async function getHistory() {
  try {
    return JSON.parse(await readFile(HISTORY_FILE, "utf8"));
  } catch {
    return [];
  }
}

app.get("/api/history", async (req, res) => {
  res.json(await getHistory());
});

app.delete("/api/history", async (req, res) => {
  await writeFile(HISTORY_FILE, "[]");
  res.json({ message: "Chat history deleted" });
});

app.post("/api/chat", async (req, res) => {
  try {
    const message = String(req.body.message || "").trim();
    if (!message) {
      return res.status(400).json({ error: "Message is empty" });
    }

    const history = await getHistory();
    const completion = await client.chat.completions.create({
      tools: [{ type: "browser_search" }],
      model: "openai/gpt-oss-20b",
      messages: [
        { role: "system", content: "Your name is August AI. You were created by Prateek Agrahari. In Hindi, write the creator name exactly as प्रतीक अग्रहरी. In Hindi, write the creator name exactly as प्रतीक अग्रहरी. When asked who you are, introduce yourself as Hello! I am August AI, an AI chatbot created by Prateek Agrahari. Never claim your name is ChatGPT. Be honest about being an AI chatbot powered by an AI model." },
        ...history,
        { role: "user", content: message }
      ]
    });

    const answer = completion.choices[0].message.content || "";
    history.push(
      { role: "user", content: message },
      { role: "assistant", content: answer }
    );
    await writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));
    res.json({ answer });
  } catch (error) {
    console.error("Groq error:", error.status || "", error.message);
    res.status(500).json({
      error: "Groq connection failed. Check Termux for the error details."
    });
  }
});

app.listen(3000, "127.0.0.1", () => {
  console.log("Chatbot server running at http://127.0.0.1:3000");
});
