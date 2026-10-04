# SKGPT

A lightweight streaming AI chat app. The React client talks only to the Express API; Gemini credentials stay on the server.

## Setup

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` in the project root and set `GEMINI_API_KEY`. Set `GEMINI_MODEL` to a model enabled for your Google AI Studio key (the current example is `gemini-3.8-flash`).
3. From the project root run `npm install`, `npm --prefix client install`, and `npm --prefix server install`.
4. Run `npm.cmd run dev` and open http://localhost:5173.

The server uses the official `@google/genai` SDK and streams text from a single `generateContentStream` call for each submitted message. The client aborts the fetch when Stop is pressed. Conversation history stays in browser localStorage.
