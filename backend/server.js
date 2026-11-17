import express from "express";
import cors from "cors";
import { KokoroTTS } from "kokoro-js";

const app = express();

// ==========================================
// SERVER CONFIGURATION
// ==========================================

const PORT = Number(process.env.PORT || 5000);

const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(
  /\/$/,
  "",
);

const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2:3b";

const TTS_VOICE = process.env.TTS_VOICE || "af_heart";

const MAX_TTS_CHARS = Number(process.env.MAX_TTS_CHARS || 500);

// ==========================================
// CORS CONFIGURATION
// ==========================================

const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (
        !origin ||
        allowedOrigins.includes("*") ||
        allowedOrigins.includes(origin)
      ) {
        callback(null, true);
      } else {
        callback(new Error("Origin is not allowed by CORS."));
      }
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json({ limit: "1mb" }));

// ==========================================
// MODEL STATE
// ==========================================

let kokoro = null;
let kokoroReady = false;

// Keep Kokoro inference sequential to avoid
// excessive CPU contention.
let ttsQueue = Promise.resolve();

// ==========================================
// AI SYSTEM PROMPT
// ==========================================

const systemPrompt = `You are VoxAI, a friendly real-time voice assistant.

Speak naturally, like a helpful person on a phone call.

Keep answers concise and direct, usually 1 to 3 short sentences.

Avoid markdown, bullet points, headings, emojis, and unnecessary introductions.

Answer the user's actual question first.
Ask one brief follow-up only when needed.

Use simple spoken language.`;

// ==========================================
// SSE HELPER
// ==========================================

function sendSse(res, payload) {
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

// ==========================================
// CLEAN CONVERSATION HISTORY
// ==========================================

function cleanMessages(input) {
  if (!Array.isArray(input)) return [];

  return input
    .filter(
      (message) =>
        message &&
        ["user", "assistant"].includes(message.role) &&
        typeof message.content === "string" &&
        message.content.trim(),
    )
    .slice(-12)
    .map((message) => ({
      role: message.role,
      content: message.content.trim().slice(0, 6000),
    }));
}

// ==========================================
// HEALTH ROUTES
// ==========================================

app.get("/", (_req, res) => {
  res.json({
    name: "VoxAI API",
    status: "online",
    model: OLLAMA_MODEL,
    kokoroReady,
  });
});

app.get("/api/health", async (_req, res) => {
  let ollama = false;

  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(2500),
    });

    ollama = response.ok;
  } catch (error) {
    console.error("[VoxAI] Ollama health check failed:", error.message);
  }

  res.json({
    success: true,
    ollama,
    kokoro: kokoroReady,
    model: OLLAMA_MODEL,
  });
});

app.get("/api/tts/status", (_req, res) => {
  res.json({
    ready: kokoroReady,
    voice: TTS_VOICE,
  });
});

// ==========================================
// AI CHAT - OLLAMA STREAMING
// ==========================================

app.post("/api/chat", async (req, res) => {
  const messages = cleanMessages(req.body?.messages);

  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return res.status(400).json({
      message: "A user message is required.",
    });
  }

  const controller = new AbortController();

  let clientDisconnected = false;

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");

  res.setHeader("Cache-Control", "no-cache, no-transform");

  res.setHeader("Connection", "keep-alive");

  res.setHeader("X-Accel-Buffering", "no");

  res.flushHeaders?.();

  res.on("close", () => {
    if (!res.writableEnded) {
      clientDisconnected = true;
      controller.abort();
    }
  });

  const startedAt = Date.now();

  let firstToken = false;

  try {
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      signal: controller.signal,

      body: JSON.stringify({
        model: OLLAMA_MODEL,

        stream: true,

        keep_alive: "30m",

        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          ...messages,
        ],

        options: {
          temperature: 0.55,
          num_predict: 120,
          num_ctx: 2048,
        },
      }),
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");

      throw new Error(
        `Ollama request failed (${response.status}): ${detail.slice(0, 300)}`,
      );
    }

    const reader = response.body.getReader();

    const decoder = new TextDecoder();

    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, {
        stream: true,
      });

      const lines = buffer.split("\n");

      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;

        const chunk = JSON.parse(line);

        if (chunk.error) {
          throw new Error(chunk.error);
        }

        const token = chunk.message?.content;

        if (token) {
          if (!firstToken) {
            firstToken = true;

            console.info(
              `[VoxAI] Ollama first token: ${Date.now() - startedAt}ms`,
            );
          }

          sendSse(res, {
            token,
          });
        }

        if (chunk.done) {
          console.info(`[VoxAI] Ollama completed: ${Date.now() - startedAt}ms`);

          sendSse(res, {
            done: true,
          });
        }
      }
    }

    // Process remaining buffered data
    if (buffer.trim()) {
      const chunk = JSON.parse(buffer);

      const token = chunk.message?.content;

      if (token) {
        sendSse(res, {
          token,
        });
      }

      if (chunk.done) {
        sendSse(res, {
          done: true,
        });
      }
    }

    if (!clientDisconnected && !res.writableEnded) {
      res.end();
    }
  } catch (error) {
    if (error.name !== "AbortError" && !clientDisconnected) {
      console.error("[VoxAI] Chat error:", error);

      sendSse(res, {
        error: error.message || "Chat generation failed.",
      });

      if (!res.writableEnded) {
        res.end();
      }
    }
  }
});

// ==========================================
// TEXT TO SPEECH - KOKORO
// ==========================================

app.post("/api/tts", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";

  const voice =
    typeof req.body?.voice === "string" ? req.body.voice : TTS_VOICE;

  if (!text) {
    return res.status(400).json({
      message: "Text is required.",
    });
  }

  if (text.length > MAX_TTS_CHARS) {
    return res.status(413).json({
      message: `Text must be ${MAX_TTS_CHARS} characters or fewer.`,
    });
  }

  if (!kokoroReady || !kokoro) {
    return res.status(503).json({
      message: "Kokoro is still loading. Please try again.",
    });
  }

  const startedAt = Date.now();

  // Serialize Kokoro generation jobs.
  const job = ttsQueue.then(async () => {
    const audio = await kokoro.generate(text, {
      voice,
    });

    const blob = audio.toBlob();

    const buffer = Buffer.from(await blob.arrayBuffer());

    return buffer;
  });

  ttsQueue = job.then(() => undefined).catch(() => undefined);

  try {
    const audioBuffer = await job;

    console.info(
      `[VoxAI] Kokoro generated ${text.length} chars in ${Date.now() - startedAt}ms`,
    );

    res.setHeader("Content-Type", "audio/wav");

    res.setHeader("Content-Length", audioBuffer.length);

    res.setHeader("Cache-Control", "no-store");

    res.send(audioBuffer);
  } catch (error) {
    console.error("[VoxAI] TTS error:", error);

    if (!res.headersSent) {
      res.status(500).json({
        message: error.message || "Kokoro generation failed.",
      });
    }
  }
});

// ==========================================
// OLLAMA WARMUP
// ==========================================

app.post("/api/warmup", async (_req, res) => {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        model: OLLAMA_MODEL,

        stream: false,

        keep_alive: "30m",

        messages: [
          {
            role: "user",
            content: "Reply with OK.",
          },
        ],

        options: {
          num_predict: 2,
        },
      }),

      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      throw new Error(`Ollama warmup failed: ${response.status}`);
    }

    res.json({
      success: true,
      message: "Ollama warmup completed.",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ==========================================
// LOAD KOKORO MODEL
// ==========================================

async function loadKokoro() {
  console.info("[VoxAI] Loading Kokoro TTS model...");

  try {
    kokoro = await KokoroTTS.from_pretrained(
      "onnx-community/Kokoro-82M-v1.0-ONNX",
      {
        dtype: "q8",
        device: "cpu",
      },
    );

    kokoroReady = true;

    console.info("[VoxAI] Kokoro is ready.");
  } catch (error) {
    kokoroReady = false;

    console.error("[VoxAI] Kokoro failed to load:", error);
  }
}

// ==========================================
// START SERVER
// ==========================================

app.listen(PORT, () => {
  console.info(`[VoxAI] Backend listening on http://localhost:${PORT}`);

  loadKokoro();
});
