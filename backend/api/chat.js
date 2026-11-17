export default async function handler(req, res) {
  const allowedOrigins = [
    "https://ai-voice-agent-nu-three.vercel.app",
    "http://localhost:5173",
  ];

  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed",
    });
  }

  const baseUrl = process.env.OLLAMA_BASE_URL;
  const apiKey = process.env.OLLAMA_API_KEY;

  if (!baseUrl || !apiKey) {
    return res.status(500).json({
      success: false,
      message: "Ollama configuration is missing",
    });
  }

  try {
    const { messages } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Messages are required",
      });
    }

    const ollamaResponse = await fetch(
      `${baseUrl.replace(/\/+$/, "")}/api/chat`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "llama3.2:3b",
          messages,
          stream: true,
          keep_alive: "30m",
          options: {
            temperature: 0.55,
            num_predict: 120,
            num_ctx: 2048,
          },
        }),
      },
    );

    if (!ollamaResponse.ok) {
      const errorText = await ollamaResponse.text();

      console.error("Ollama error:", errorText);

      return res.status(502).json({
        success: false,
        message: "Ollama request failed",
      });
    }

    if (!ollamaResponse.body) {
      return res.status(502).json({
        success: false,
        message: "Ollama returned no response stream",
      });
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const reader = ollamaResponse.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;
        if (res.destroyed) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;

          const data = JSON.parse(line);

          if (data.error) {
            throw new Error(data.error);
          }

          const token = data.message?.content;

          if (token) {
            res.write(`data: ${JSON.stringify({ token })}\n\n`);
          }
        }
      }

      buffer += decoder.decode();

      if (buffer.trim() && !res.destroyed) {
        const data = JSON.parse(buffer);

        if (data.error) {
          throw new Error(data.error);
        }

        const token = data.message?.content;

        if (token) {
          res.write(`data: ${JSON.stringify({ token })}\n\n`);
        }
      }

      if (!res.destroyed) {
        res.end();
      }
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    console.error("Chat API error:", error);

    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: "Unable to connect to AI service",
      });
    }

    if (!res.destroyed) {
      res.write(
        `data: ${JSON.stringify({
          error: "AI streaming failed",
        })}\n\n`,
      );
      res.end();
    }
  }
}
