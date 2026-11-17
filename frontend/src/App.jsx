import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";

// ==========================================
// CONFIGURATION
// ==========================================

const API_BASE_URL = (
  import.meta.env.VITE_API_URL || "http://localhost:5000"
).replace(/\/$/, "");

const TTS_VOICE = import.meta.env.VITE_TTS_VOICE || "af_heart";

const FIRST_CHUNK_WORDS = 9;
const MAX_CHUNK_WORDS = 16;

// ==========================================
// MAIN APP
// ==========================================

function App() {
  const [callActive, setCallActive] = useState(false);
  const [status, setStatus] = useState("Ready to connect");
  const [activity, setActivity] = useState("idle");

  // ==========================================
  // REFERENCES
  // ==========================================

  const callActiveRef = useRef(false);

  const recognitionRef = useRef(null);
  const recognitionActiveRef = useRef(false);
  const restartTimerRef = useRef(null);

  const historyRef = useRef([]);

  const generatingRef = useRef(false);
  const abortRef = useRef(null);
  const requestIdRef = useRef(0);

  // Audio queue
  const speechQueueRef = useRef([]);
  const speechWorkerActiveRef = useRef(false);
  const responseFinishedRef = useRef(false);
  const pendingTextRef = useRef("");

  const ttsControllersRef = useRef(new Set());

  const audioRef = useRef(null);
  const audioUrlRef = useRef(null);
  const audioResolveRef = useRef(null);

  const utteranceActiveRef = useRef(false);
  const currentSpeakingTextRef = useRef("");

  const lastSubmittedAtRef = useRef(0);
  const lastFinalTranscriptRef = useRef("");

  // ==========================================
  // TIMING LOGS
  // ==========================================

  const logTiming = (label, startedAt, extra = "") => {
    const elapsed = startedAt ? `${Date.now() - startedAt}ms` : "";

    console.info(`[VoxAI] ${label} ${elapsed} ${extra}`.trim());
  };

  // ==========================================
  // END CALL COMMANDS
  // ==========================================

  const isEndCallCommand = (text) => {
    const command = text
      .toLowerCase()
      .replace(/[.,!?]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const phrases = [
      "cut the call",
      "cut call",
      "end the call",
      "end call",
      "finish the call",
      "finish call",
      "hang up",
      "hangup",
      "disconnect",
      "goodbye",
      "good bye",
      "bye",
      "that's all",
      "thats all",
      "i'm done",
      "im done",
      "i am done",
    ];

    return phrases.some((phrase) => ` ${command} `.includes(` ${phrase} `));
  };

  // ==========================================
  // ASSISTANT ECHO DETECTION
  // ==========================================

  const isLikelyAssistantEcho = (transcript) => {
    const currentSpeech = currentSpeakingTextRef.current;

    if (!currentSpeech.trim()) return false;

    const words = (value) =>
      value
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(/\s+/)
        .filter(Boolean);

    const heardWords = words(transcript);

    const spokenWords = new Set(words(currentSpeech));

    if (heardWords.length < 2) return false;

    const matchingWords = heardWords.filter((word) =>
      spokenWords.has(word),
    ).length;

    return matchingWords / heardWords.length >= 0.7;
  };

  // ==========================================
  // STOP AUDIO AND CANCEL TTS
  // ==========================================

  const stopAudio = useCallback(() => {
    for (const controller of ttsControllersRef.current) {
      controller.abort();
    }

    ttsControllersRef.current.clear();

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();

      audioRef.current = null;
    }

    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }

    if (audioResolveRef.current) {
      audioResolveRef.current();
      audioResolveRef.current = null;
    }

    utteranceActiveRef.current = false;
    currentSpeakingTextRef.current = "";
  }, []);

  // ==========================================
  // FINISH RESPONSE
  // ==========================================

  const finishResponseIfReady = (requestId) => {
    if (requestId !== requestIdRef.current) return;

    if (!responseFinishedRef.current) return;

    if (speechQueueRef.current.length > 0) return;

    if (speechWorkerActiveRef.current) return;

    generatingRef.current = false;
    responseFinishedRef.current = false;

    utteranceActiveRef.current = false;
    currentSpeakingTextRef.current = "";

    setActivity("listening");
    setStatus("Listening to you");
  };

  // ==========================================
  // INTERRUPT AI
  // ==========================================

  const interruptAI = () => {
    requestIdRef.current++;

    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }

    generatingRef.current = false;
    responseFinishedRef.current = false;

    pendingTextRef.current = "";
    speechQueueRef.current = [];

    stopAudio();

    setActivity("listening");
    setStatus("Listening to you");
  };

  // ==========================================
  // PLAY GENERATED AUDIO
  // ==========================================

  const playTask = async (task, requestId) => {
    const blob = await task.audioPromise;

    if (requestId !== requestIdRef.current || !callActiveRef.current) {
      return;
    }

    const url = URL.createObjectURL(blob);

    const audio = new Audio(url);

    audioRef.current = audio;
    audioUrlRef.current = url;

    currentSpeakingTextRef.current = task.text;

    utteranceActiveRef.current = true;

    await new Promise((resolve, reject) => {
      let settled = false;

      const finish = (error) => {
        if (settled) return;

        settled = true;

        audio.onended = null;
        audio.onerror = null;

        if (audioRef.current === audio) {
          audioRef.current = null;
        }

        if (audioUrlRef.current === url) {
          URL.revokeObjectURL(url);
          audioUrlRef.current = null;
        }

        audioResolveRef.current = null;

        utteranceActiveRef.current = false;
        currentSpeakingTextRef.current = "";

        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      audioResolveRef.current = () => finish();

      audio.onplay = () => {
        if (requestId !== requestIdRef.current) return;

        setActivity("speaking");
        setStatus("AI is speaking");

        if (!task.playStartedAt) {
          logTiming("first audio playback started", task.createdAt);

          task.playStartedAt = Date.now();
        }
      };

      audio.onended = () => finish();

      audio.onerror = () => finish(new Error("Audio playback failed."));

      audio.play().catch(finish);
    });
  };

  // ==========================================
  // PROCESS AUDIO QUEUE
  // ==========================================

  const processSpeechQueue = async (requestId) => {
    if (speechWorkerActiveRef.current) return;

    speechWorkerActiveRef.current = true;

    try {
      while (
        speechQueueRef.current.length > 0 &&
        callActiveRef.current &&
        requestId === requestIdRef.current
      ) {
        const task = speechQueueRef.current.shift();

        try {
          await playTask(task, requestId);
        } catch (error) {
          if (
            error.name !== "AbortError" &&
            requestId === requestIdRef.current
          ) {
            console.error("[VoxAI] TTS/playback error:", error);

            setStatus("Voice generation failed");
          }
        }
      }
    } finally {
      speechWorkerActiveRef.current = false;

      if (requestId === requestIdRef.current) {
        finishResponseIfReady(requestId);
      }

      // Handle chunks added as the queue was finishing.
      if (
        speechQueueRef.current.length > 0 &&
        callActiveRef.current &&
        requestId === requestIdRef.current
      ) {
        processSpeechQueue(requestId);
      }
    }
  };

  // ==========================================
  // GENERATE TTS IN BACKGROUND
  // ==========================================

  const enqueueSpeech = (text, requestId) => {
    const cleanText = text.trim();

    if (!cleanText || requestId !== requestIdRef.current) {
      return;
    }

    const controller = new AbortController();

    ttsControllersRef.current.add(controller);

    const task = {
      text: cleanText,
      createdAt: Date.now(),
      audioPromise: null,
    };

    // Begin generating the next audio while
    // the previous audio is playing.

    task.audioPromise = fetch(`${API_BASE_URL}/api/tts`, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      signal: controller.signal,

      body: JSON.stringify({
        text: cleanText,
        voice: TTS_VOICE,
      }),
    })
      .then(async (response) => {
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));

          throw new Error(error.message || "Kokoro audio generation failed.");
        }

        return response.blob();
      })
      .finally(() => {
        ttsControllersRef.current.delete(controller);
      });

    speechQueueRef.current.push(task);

    if (!speechWorkerActiveRef.current) {
      processSpeechQueue(requestId);
    }
  };

  // ==========================================
  // EXTRACT SMALL SPEECH CHUNKS
  // ==========================================

  const extractSpeechChunks = (requestId, flush = false) => {
    let pending = pendingTextRef.current;

    while (pending.trim()) {
      pending = pending.trimStart();

      let punctuationIndex = -1;

      // Prefer a natural sentence boundary when available.
      for (let i = 0; i < pending.length; i++) {
        if (".!?".includes(pending[i])) {
          const next = pending[i + 1];

          if (!next || /\s/.test(next) || next === '"' || next === "'") {
            punctuationIndex = i + 1;
            break;
          }
        }
      }

      const words = pending.trim().split(/\s+/);

      const targetWords =
        words.length >= MAX_CHUNK_WORDS ? MAX_CHUNK_WORDS : FIRST_CHUNK_WORDS;

      let wordSplitIndex = -1;

      if (words.length >= targetWords) {
        let count = 0;

        for (let i = 0; i < pending.length; i++) {
          if (/\s/.test(pending[i]) && i > 0 && !/\s/.test(pending[i - 1])) {
            count++;

            if (count >= targetWords) {
              wordSplitIndex = i;
              break;
            }
          }
        }
      }

      let splitIndex = -1;

      if (
        punctuationIndex > 0 &&
        (wordSplitIndex < 0 || punctuationIndex <= wordSplitIndex)
      ) {
        splitIndex = punctuationIndex;
      } else if (wordSplitIndex > 0) {
        splitIndex = wordSplitIndex;
      } else if (flush) {
        splitIndex = pending.length;
      }

      if (splitIndex < 0) break;

      const chunk = pending.slice(0, splitIndex).trim();

      pending = pending.slice(splitIndex).trimStart();

      if (chunk) {
        enqueueSpeech(chunk, requestId);
      }
    }

    pendingTextRef.current = pending;
  };

  // ==========================================
  // SEND MESSAGE TO OLLAMA
  // ==========================================

  const sendMessage = async (text) => {
    const userMessage = text.trim();

    if (!userMessage || !callActiveRef.current) return;

    if (generatingRef.current || utteranceActiveRef.current) {
      interruptAI();
    }

    const requestId = ++requestIdRef.current;

    const controller = new AbortController();

    abortRef.current = controller;

    generatingRef.current = true;
    responseFinishedRef.current = false;

    pendingTextRef.current = "";
    speechQueueRef.current = [];

    historyRef.current.push({
      role: "user",
      content: userMessage,
    });

    setActivity("thinking");
    setStatus("Thinking...");

    const requestStartedAt = Date.now();

    let firstTokenLogged = false;
    let fullResponse = "";
    let buffer = "";

    try {
      const response = await fetch(`${API_BASE_URL}/api/chat`, {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
        },

        signal: controller.signal,

        body: JSON.stringify({
          messages: historyRef.current.slice(-10),
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));

        throw new Error(error.message || "Backend chat request failed.");
      }

      if (!response.body) {
        throw new Error("Streaming is not supported by this browser.");
      }

      const reader = response.body.getReader();

      const decoder = new TextDecoder();

      const processLine = (line) => {
        if (!line.startsWith("data:")) return;

        const raw = line.slice(5).trim();

        if (!raw) return;

        const data = JSON.parse(raw);

        if (data.error) {
          throw new Error(data.error);
        }

        if (data.token) {
          if (!firstTokenLogged) {
            firstTokenLogged = true;

            logTiming("first Ollama token", requestStartedAt);
          }

          fullResponse += data.token;

          pendingTextRef.current += data.token;

          extractSpeechChunks(requestId);
        }
      };

      while (true) {
        const { done, value } = await reader.read();

        if (requestId !== requestIdRef.current) return;

        if (done) break;

        buffer += decoder.decode(value, {
          stream: true,
        });

        const lines = buffer.split("\n");

        buffer = lines.pop() || "";

        for (const line of lines) {
          processLine(line);
        }
      }

      buffer += decoder.decode();

      if (buffer.trim()) {
        for (const line of buffer.split("\n")) {
          processLine(line.trim());
        }
      }

      if (requestId !== requestIdRef.current) return;

      const answer = fullResponse.trim();

      if (!answer) {
        throw new Error("The AI returned an empty response.");
      }

      historyRef.current.push({
        role: "assistant",
        content: answer,
      });

      extractSpeechChunks(requestId, true);

      responseFinishedRef.current = true;

      logTiming("Ollama response completed", requestStartedAt);

      if (!speechWorkerActiveRef.current && !speechQueueRef.current.length) {
        finishResponseIfReady(requestId);
      } else if (!speechWorkerActiveRef.current) {
        processSpeechQueue(requestId);
      }
    } catch (error) {
      if (error.name === "AbortError") return;

      console.error("[VoxAI] Chat error:", error);

      if (requestId === requestIdRef.current) {
        generatingRef.current = false;
        responseFinishedRef.current = false;

        setActivity("listening");

        setStatus(error.message || "Something went wrong");
      }
    } finally {
      if (requestId === requestIdRef.current) {
        abortRef.current = null;
      }
    }
  };

  // ==========================================
  // END CALL
  // ==========================================

  const endCall = () => {
    callActiveRef.current = false;

    requestIdRef.current++;

    generatingRef.current = false;
    responseFinishedRef.current = false;

    speechQueueRef.current = [];
    pendingTextRef.current = "";

    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }

    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }

    if (recognitionRef.current) {
      recognitionRef.current.onend = null;

      try {
        recognitionRef.current.stop();
      } catch (error) {
        console.debug(error);
      }

      recognitionRef.current = null;
    }

    recognitionActiveRef.current = false;

    stopAudio();

    setCallActive(false);
    setActivity("idle");
    setStatus("Call ended");
  };

  // ==========================================
  // MICROPHONE / SPEECH RECOGNITION
  // ==========================================

  const startListening = () => {
    if (!callActiveRef.current || recognitionActiveRef.current) {
      return;
    }

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert("Please use Google Chrome for voice recognition.");
      endCall();
      return;
    }

    if (!recognitionRef.current) {
      const recognition = new SpeechRecognition();

      recognition.lang = "en-US";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        recognitionActiveRef.current = true;

        if (!generatingRef.current && !utteranceActiveRef.current) {
          setActivity("listening");
          setStatus("Listening to you");
        }
      };

      recognition.onresult = (event) => {
        let finalText = "";
        let interimText = "";

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];

          if (result.isFinal) {
            finalText += `${result[0].transcript} `;
          } else {
            interimText += result[0].transcript;
          }
        }

        const heard = (finalText || interimText).trim();

        if (!heard) return;

        const aiBusy = generatingRef.current || utteranceActiveRef.current;

        // Basic protection against the microphone
        // recognizing the assistant's own voice.
        if (aiBusy && isLikelyAssistantEcho(heard)) {
          return;
        }

        // Interrupt after at least two interim words.
        if (aiBusy && interimText.trim().split(/\s+/).length >= 2) {
          interruptAI();
        }

        if (finalText.trim()) {
          const question = finalText.trim();

          if (isEndCallCommand(question)) {
            endCall();
            return;
          }

          if (
            question === lastFinalTranscriptRef.current &&
            Date.now() - lastSubmittedAtRef.current < 2500
          ) {
            return;
          }

          if (Date.now() - lastSubmittedAtRef.current < 450) {
            return;
          }

          lastFinalTranscriptRef.current = question;

          lastSubmittedAtRef.current = Date.now();

          sendMessage(question);
        }
      };

      recognition.onerror = (event) => {
        if (event.error !== "no-speech" && event.error !== "aborted") {
          console.error("[VoxAI] Speech recognition:", event.error);
        }

        if (event.error === "not-allowed") {
          alert("Please allow microphone access.");
          endCall();
        }
      };

      recognition.onend = () => {
        recognitionActiveRef.current = false;

        if (restartTimerRef.current) {
          clearTimeout(restartTimerRef.current);
        }

        if (callActiveRef.current) {
          restartTimerRef.current = setTimeout(startListening, 250);
        }
      };

      recognitionRef.current = recognition;
    }

    try {
      recognitionRef.current.start();
    } catch (error) {
      console.debug("[VoxAI] Recognition start:", error.message);
    }
  };

  // ==========================================
  // START CALL
  // ==========================================

  const startCall = async () => {
    if (callActiveRef.current) return;

    setStatus("Checking microphone...");

    try {
      // Check browser support
      const SpeechRecognition =
        window.SpeechRecognition || window.webkitSpeechRecognition;

      if (!SpeechRecognition) {
        throw new Error(
          "Speech recognition is not supported. Please use Google Chrome.",
        );
      }

      // Request microphone permission
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });

      // Release the temporary microphone stream.
      // SpeechRecognition will use the microphone itself.
      stream.getTracks().forEach((track) => track.stop());

      historyRef.current = [];

      requestIdRef.current++;

      generatingRef.current = false;
      responseFinishedRef.current = false;

      speechQueueRef.current = [];
      pendingTextRef.current = "";

      stopAudio();

      callActiveRef.current = true;

      setCallActive(true);
      setActivity("listening");
      setStatus("Starting microphone...");

      startListening();
    } catch (error) {
      console.error("[VoxAI] Start call error:", error);

      callActiveRef.current = false;

      setCallActive(false);
      setActivity("idle");

      if (error.name === "NotAllowedError") {
        setStatus("Microphone permission denied");
        alert("Please allow microphone access in Chrome site settings.");
      } else {
        setStatus(error.message || "Unable to start conversation");
      }
    }
  };

  // ==========================================
  // CLEANUP
  // ==========================================

  useEffect(() => {
    return () => {
      callActiveRef.current = false;

      abortRef.current?.abort();

      stopAudio();

      if (restartTimerRef.current) {
        clearTimeout(restartTimerRef.current);
      }

      try {
        recognitionRef.current?.stop();
      } catch (error) {
        console.debug(error);
      }
    };
  }, [stopAudio]);

  // ==========================================
  // USER INTERFACE
  // ==========================================

  return (
    <main className="app-shell">
      {/* HEADER */}
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-mark">V</span>

          <span>
            VoxAI<span className="brand-dot">.</span>
          </span>
        </a>

        <div className="topbar-right">
          <span className="system-indicator">
            <span className="online-dot" />
            Local AI system
          </span>

          <span className="version-label">VOICE AGENT · 01</span>
        </div>
      </header>

      {/* MAIN CONTENT */}
      <section className="main-content">
        <div className="eyebrow">
          <span className="eyebrow-line" />
          REAL-TIME CONVERSATION
        </div>

        <h1 className="hero-title">
          A better way to
          <span> have a conversation.</span>
        </h1>

        <p className="hero-description">
          Your personal AI voice assistant. Natural conversations, instant
          responses, and complete control.
        </p>

        {/* VOICE CARD */}
        <section className={`voice-card ${callActive ? "is-active" : ""}`}>
          <div className="card-top">
            <span className="card-label">VOICE SESSION</span>

            <span className={`session-status ${callActive ? "connected" : ""}`}>
              <span />
              {callActive ? "CONNECTED" : "STANDBY"}
            </span>
          </div>

          {/* ORB */}
          <div className={`orb-stage ${activity}`}>
            <div className="orb-ring ring-one" />
            <div className="orb-ring ring-two" />
            <div className="orb-ring ring-three" />

            <div className="voice-orb">
              <div className="orb-inner">
                <span className="orb-logo">V</span>
                <span className="orb-light" />
              </div>
            </div>

            <div className="orb-spark spark-one" />
            <div className="orb-spark spark-two" />
          </div>

          {/* STATUS */}
          <div className="voice-info">
            <span className="voice-name">Your AI Assistant</span>

            <h2>{status}</h2>

            <p>
              {!callActive
                ? "Ready when you are. Start a call to begin."
                : activity === "speaking"
                  ? "Your assistant is speaking. You can interrupt at any time."
                  : activity === "thinking"
                    ? "Preparing your answer."
                    : "I'm listening. Go ahead and speak naturally."}
            </p>
          </div>

          {/* VISUALIZER */}
          <div className="voice-visualizer" aria-hidden="true">
            {Array.from({ length: 31 }, (_, index) => (
              <span key={index} style={{ "--i": index }} />
            ))}
          </div>

          {/* CALL BUTTON */}
          <div className="call-action">
            {!callActive ? (
              <button className="call-button start-button" onClick={startCall}>
                <span className="button-icon">☎</span>
                Start conversation
              </button>
            ) : (
              <button className="call-button end-button" onClick={endCall}>
                <span className="button-icon">✕</span>
                End conversation
              </button>
            )}
          </div>

          {/* FOOTER */}
          <div className="card-footer">
            <span>
              <i />
              Microphone {callActive ? "active" : "standby"}
            </span>

            <span>Powered by Ollama + Kokoro</span>
          </div>
        </section>

        {/* FEATURES */}
        <div className="features">
          <div className="feature">
            <span className="feature-icon">◉</span>

            <div>
              <strong>Natural voice</strong>
              <span>Speak freely</span>
            </div>
          </div>

          <div className="feature">
            <span className="feature-icon">↗</span>

            <div>
              <strong>Streaming response</strong>
              <span>Early audio playback</span>
            </div>
          </div>

          <div className="feature">
            <span className="feature-icon">⌁</span>

            <div>
              <strong>Interrupt anytime</strong>
              <span>You stay in control</span>
            </div>
          </div>
        </div>

        <p className="bottom-note">
          PRIVATE BY DESIGN
          <span>·</span>
          POWERED BY YOUR LOCAL AI
        </p>
      </section>
    </main>
  );
}

export default App;
