import { KokoroTTS } from "kokoro-js";

async function testKokoro() {
  try {
    console.log("Loading Kokoro model...");

    const tts = await KokoroTTS.from_pretrained(
      "onnx-community/Kokoro-82M-v1.0-ONNX",
      {
        dtype: "q8",
        device: "cpu",
      },
    );

    console.log("Kokoro model loaded!");

    const audio = await tts.generate(
      "Hello! I am your AI voice assistant. How can I help you today?",
      {
        voice: "af_heart",
      },
    );

    await audio.save("kokoro-test.wav");

    console.log("Speech generated successfully!");
    console.log("Check kokoro-test.wav in your backend folder.");
  } catch (error) {
    console.error("Kokoro error:", error);
  }
}

testKokoro();
