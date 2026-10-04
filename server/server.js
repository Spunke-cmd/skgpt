import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../.env') });

const app = express();
const port = Number(process.env.PORT) || 3001;
const requestTimeoutMs = Math.max(1_000, Number(process.env.GEMINI_REQUEST_TIMEOUT_MS) || 110_000);
const defaultOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const allowedOrigins = new Set([
  ...defaultOrigins,
  ...(process.env.CLIENT_ORIGIN || '').split(',').map(origin => origin.trim().replace(/\/$/, '')).filter(Boolean)
]);

app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || allowedOrigins.has(origin));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'X-SKGPT-Retry'],
  maxAge: 600
}));
app.use(express.json({ limit: '256kb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

function classifyGeminiError(error) {
  const rawMessage = String(error?.message || '');
  const normalized = rawMessage.toLowerCase();
  const numericStatus = Number(error?.status) || Number(error?.code) || Number(error?.response?.status) || 0;

  if (error?.name === 'TimeoutError') return { status: 504, code: 'TIMEOUT', message: 'The request took too long. Please try again.', retryable: false };
  if (numericStatus === 401 || numericStatus === 403 || /api[_ -]?key.{0,30}(invalid|not valid)|unauthenticated|permission denied/.test(normalized)) {
    return { status: 401, code: 'AUTHENTICATION', message: 'Gemini authentication failed. Check the server API configuration.', retryable: false };
  }
  if (numericStatus === 429 || /resource_exhausted|quota exceeded|rate limit/.test(normalized)) {
    return { status: 429, code: 'RATE_LIMIT', message: 'Gemini usage limit reached. Please try again later.', retryable: false };
  }
  if (numericStatus === 404 || /model.{0,40}(not found|unavailable)|not found.{0,40}model/.test(normalized)) {
    return { status: 404, code: 'MODEL_UNAVAILABLE', message: 'The selected Gemini model is currently unavailable.', retryable: false };
  }
  if (numericStatus === 400) return { status: 400, code: 'INVALID_REQUEST', message: 'Invalid request. Please try again.', retryable: false };
  if ([502, 503, 504].includes(numericStatus) || /econnreset|econnrefused|enotfound|fetch failed|socket hang up|network error/.test(normalized)) {
    return { status: 503, code: 'TEMPORARY_UNAVAILABLE', message: 'Gemini is temporarily busy. Retrying automatically...', retryable: true };
  }
  return { status: 500, code: 'GENERATION_ERROR', message: 'Something went wrong while generating the response. Please try again.', retryable: false };
}

app.post('/api/chat', async (req, res) => {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const retryIndex = Math.max(0, Number.parseInt(req.get('X-SKGPT-Retry') || '0', 10) || 0);
  console.info(`[${requestId}] chat request received (attempt ${retryIndex + 1})`);

  const { messages } = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const validMessages = Array.isArray(messages)
    && messages.length > 0
    && messages.length <= 100
    && messages.every(message => message && ['user', 'model'].includes(message.role)
      && typeof message.text === 'string'
      && message.text.trim().length > 0
      && message.text.length <= 20_000);
  if (!validMessages) {
    return res.status(400).json({ code: 'INVALID_REQUEST', error: 'Invalid request. Please try again.', retryable: false });
  }
  if (messages.reduce((total, message) => total + message.text.length, 0) > 100_000) {
    return res.status(413).json({ code: 'MESSAGE_TOO_LARGE', error: 'This message is too large. Please shorten it and try again.', retryable: false });
  }
  if (!process.env.GEMINI_API_KEY?.trim()) {
    return res.status(500).json({ code: 'CONFIGURATION', error: 'Gemini server API configuration is missing its API key.', retryable: false });
  }
  if (!process.env.GEMINI_MODEL?.trim()) {
    return res.status(500).json({ code: 'CONFIGURATION', error: 'Gemini model configuration is missing. Check GEMINI_MODEL on the server.', retryable: false });
  }

  const abortController = new AbortController();
  let disconnected = false;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    abortController.abort(new DOMException('Gemini request timed out', 'TimeoutError'));
  }, requestTimeoutMs);
  timeout.unref?.();

  const abortRequest = () => {
    if (!res.writableEnded && !disconnected) {
      disconnected = true;
      abortController.abort(new DOMException('Client disconnected', 'AbortError'));
      console.info(`[${requestId}] chat request aborted by client`);
    }
  };
  req.once('aborted', abortRequest);
  res.once('close', abortRequest);

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const contents = messages.map(message => ({ role: message.role, parts: [{ text: message.text }] }));
    const stream = await ai.models.generateContentStream({
      model: process.env.GEMINI_MODEL,
      contents,
      config: {
        abortSignal: abortController.signal,
        systemInstruction: 'Match the language of the user naturally. For English, reply in English. For Hindi, reply in Roman Hindi using Latin letters unless the user specifically asks for Devanagari. For Hinglish, use natural Roman Hinglish.'
      }
    });

    if (disconnected) return;
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Request-ID': requestId,
      'Connection': 'keep-alive'
    });
    for await (const chunk of stream) {
      if (disconnected || res.destroyed || timedOut) break;
      if (typeof chunk.text === 'string' && chunk.text) {
        res.write(`event: token\ndata: ${JSON.stringify(chunk.text)}\n\n`);
      }
    }

    if (timedOut && !res.destroyed) {
      const timeoutError = { status: 504, code: 'TIMEOUT', error: 'The request took too long. Please try again.', retryable: false };
      if (res.headersSent) res.write(`event: error\ndata: ${JSON.stringify(timeoutError)}\n\n`);
      else res.status(504).json(timeoutError);
    } else if (!disconnected && !res.destroyed) {
      res.write('event: end\ndata: {}\n\n');
      console.info(`[${requestId}] chat request completed in ${Date.now() - startedAt}ms`);
    }
    if (!res.destroyed) res.end();
  } catch (error) {
    if (disconnected || res.destroyed) return;
    const failure = timedOut
      ? { status: 504, code: 'TIMEOUT', message: 'The request took too long. Please try again.', retryable: false }
      : classifyGeminiError(error);
    const detail = String(error?.message || 'Gemini request failed')
      .replaceAll(process.env.GEMINI_API_KEY, '[redacted]')
      .slice(0, 500);
    console.error(`[${requestId}] Gemini request failed`, { status: failure.status, code: failure.code, attempt: retryIndex + 1, detail });
    const payload = { code: failure.code, error: failure.message, retryable: failure.retryable };
    if (!res.headersSent) res.status(failure.status).json(payload);
    else { res.write(`event: error\ndata: ${JSON.stringify({ status: failure.status, ...payload })}\n\n`); res.end(); }
  } finally {
    clearTimeout(timeout);
    req.off('aborted', abortRequest);
    res.off('close', abortRequest);
  }
});

app.use((error, _req, res, _next) => {
  if (res.headersSent) return res.destroy();
  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({ code: 'INVALID_JSON', error: 'Invalid request. Please try again.', retryable: false });
  }
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ code: 'MESSAGE_TOO_LARGE', error: 'This request is too large. Please shorten it and try again.', retryable: false });
  }
  console.error('Express request error:', String(error?.message || 'Unknown server error').slice(0, 300));
  return res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong while generating the response. Please try again.', retryable: false });
});

const server = app.listen(port, () => console.log(`SKGPT API listening on http://localhost:${port}`));
server.requestTimeout = requestTimeoutMs + 10_000;
server.headersTimeout = 15_000;
server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Stop the existing SKGPT server before starting another one.`);
  } else {
    console.error('Could not start the SKGPT API server:', error.message);
  }
  process.exit(1);
});
