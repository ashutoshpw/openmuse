# Meta media provider

This package implements bounded server-side adapters for Meta Model API image
generation and one-shot speech transcription. It uses the shared provider
HTTP boundary for timeouts, cancellation, response limits, and normalized
errors. API keys are resolved from opaque secret references and are never
included in provider configuration or results.

The request shapes follow the Meta Model API references:

- `POST /v1/images/generations` sends one image request and requires a
  base64 response. URL-only image responses are rejected without fetching the
  returned URL.
- `POST /v1/asr/transcribe` sends JSON `request` and WAV `audio` multipart
  parts and asks for a buffered JSON transcript. Input is restricted to mono,
  16-bit PCM WAV at 16 kHz or 24 kHz and at most ten minutes.

Tests use injected transports and synthetic responses only; they do not make
live or billable provider requests.
