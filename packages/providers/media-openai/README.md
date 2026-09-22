# OpenAI media provider

This package implements bounded server-side adapters for OpenAI image
generation, speech-to-text, and text-to-speech. It uses the provider HTTP
boundary for timeouts, abort propagation, response limits, and normalized
errors. API keys are resolved from an opaque secret reference and are never
returned by the client contract.

The request shapes are based on the pinned OpenAI OpenAPI document at commit
[`7de0436e058814c8fab9bf18b60208e5f79762d3`](https://raw.githubusercontent.com/openai/openai-openapi/7de0436e058814c8fab9bf18b60208e5f79762d3/openapi.yaml):

- `POST /v1/images/generations` sends `n: 1`; the adapter requires
  `b64_json` and never follows an untrusted provider URL.
- `POST /v1/audio/transcriptions` sends multipart `file`, `model`, and
  `response_format`; verbose, diarized, text, and SSE responses are normalized
  to the shared transcript contract.
- `POST /v1/audio/speech` sends JSON and accepts only the requested binary
  `mp3`, `wav`, or `pcm` format.

Tests inspect the actual outbound JSON and multipart fields. They use fake
responses only; no provider credentials or billable calls are made.
