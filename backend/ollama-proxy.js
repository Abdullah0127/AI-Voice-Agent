import express from "express";
import cors from "cors";

const app = express();

const PORT = 8787;
const PROXY_SECRET = process.env.PROXY_SECRET;

if (!PROXY_SECRET) {
  console.error("Missing PROXY_SECRET environment variable.");
  process.exit(1);
}

app.use(
  cors({
    origin: [
      "https://ai-voice-agent-nu-three.vercel.app",
      "http://localhost:5173",
    ],
  }),
);

app.use(express.json({ limit: "2mb" }));

// Protect every endpoint with a secret token.
app.use((req, res, next) => {
  const token = req.headers.authorization;

  if (token !== `Bearer ${PROXY_SECRET}`) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
  }

  next();
});

// Check connection
app.get("/health", (req, res) => {
  res.json({ success: true, message: "Protected Ollama proxy is running" });
});

// Forward chat requests to local Ollama
app.post("/api/chat", async (req, res) => {
  try {
    const response = await fetch("http://127.0.0.1:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });

    res.status(response.status);
    res.setHeader(
      "Content-Type",
      response.headers.get("content-type") || "application/json",
    );

    if (!response.body) {
      return res.end();
    }

    for await (const chunk of response.body) {
      if (res.destroyed) break;
      res.write(chunk);
    }

    res.end();
  } catch (error) {
    console.error("Ollama proxy error:", error.message);
    res.status(500).json({
      success: false,
      message: "Could not connect to local Ollama",
    });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Protected proxy running at http://127.0.0.1:${PORT}`);
});
