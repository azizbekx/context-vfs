"""LLM provider abstraction.

The resolver builds a provider-neutral list of `{role, content}` chat
messages (system + few-shot + final user). Each provider translates that
into its native chat API and returns the raw response text. Decision
parsing happens upstream in `decisions.py`.

Two providers ship in-tree:
  - `OllamaProvider`  — local Ollama (`/api/chat`, `format=json`)
  - `GeminiProvider`  — Google Gemini (`google-genai` SDK,
                        `response_mime_type='application/json'`)

Both expose the same surface: `name` (used for risk modifiers — small models
penalised) and `chat(messages, *, timeout) -> raw_text_str`.
"""

from __future__ import annotations

import os
from typing import Any, Protocol


class LLMProvider(Protocol):
    name: str

    def chat(self, messages: list[dict[str, str]], *, timeout: int = 300) -> str:
        """Send a chat-style message list and return raw response text.

        `messages` follow the OpenAI shape: each item is `{"role": "system"
        | "user" | "assistant", "content": "..."}`. The provider is
        responsible for translating this into its native API and for
        requesting JSON-mode output."""
        ...


# ---------------------------------------------------------------------------
# Ollama (local) — no API key, slower on CPU
# ---------------------------------------------------------------------------

class OllamaProvider:
    """Talks to a local Ollama instance via `/api/chat`.

    Pulled in as a dev/offline option. On CPU expect 30–150 s per cluster
    with a 3B model; not suitable for production batch.
    """

    def __init__(
        self,
        model: str = "llama3.2:3b",
        ollama_url: str = "http://localhost:11434",
        temperature: float = 0.1,
        num_ctx: int = 4096,
    ) -> None:
        self.name = model
        self._url = ollama_url.rstrip("/")
        self._temperature = temperature
        self._num_ctx = num_ctx

    def chat(self, messages: list[dict[str, str]], *, timeout: int = 300) -> str:
        import requests  # local import; only needed if this provider is used

        payload: dict[str, Any] = {
            "model": self.name,
            "messages": messages,
            "stream": False,
            "format": "json",
            "options": {
                "temperature": self._temperature,
                "num_ctx": self._num_ctx,
            },
        }
        r = requests.post(f"{self._url}/api/chat", json=payload, timeout=timeout)
        r.raise_for_status()
        body = r.json()
        return body.get("message", {}).get("content", "")


# ---------------------------------------------------------------------------
# Gemini — managed API, fast, sub-second per cluster typically
# ---------------------------------------------------------------------------

class GeminiProvider:
    """Talks to Google Gemini via the `google-genai` SDK.

    Reads the API key from the env var named in `api_key_env` (defaults to
    `GEMINI_API_KEY` to match the rest of this repo). Sends the chat in
    JSON mode (`response_mime_type='application/json'`).

    The OpenAI-style `system` role is mapped onto Gemini's separate
    `system_instruction` field; if multiple system messages are present
    they are concatenated.
    """

    def __init__(
        self,
        model: str = "gemini-3.1-flash-lite-preview",
        api_key_env: str = "GEMINI_API_KEY",
        temperature: float = 0.1,
    ) -> None:
        self.name = model
        self._api_key_env = api_key_env
        self._temperature = temperature

    def _client(self) -> Any:
        from google import genai  # local import; SDK is optional

        key = os.environ.get(self._api_key_env)
        if not key:
            raise RuntimeError(f"{self._api_key_env} is not set")
        return genai.Client(api_key=key)

    @staticmethod
    def _split_system(messages: list[dict[str, str]]) -> tuple[str, list[dict[str, str]]]:
        system_parts = [m["content"] for m in messages if m.get("role") == "system"]
        rest = [m for m in messages if m.get("role") != "system"]
        return ("\n\n".join(system_parts).strip(), rest)

    @staticmethod
    def _to_contents(messages: list[dict[str, str]]) -> list[Any]:
        from google.genai import types

        contents: list[Any] = []
        for m in messages:
            role = "user" if m["role"] == "user" else "model"
            contents.append(
                types.Content(role=role, parts=[types.Part.from_text(text=m["content"])])
            )
        return contents

    def chat(self, messages: list[dict[str, str]], *, timeout: int = 300) -> str:
        # `timeout` is accepted for protocol parity; the genai SDK does not
        # currently surface a per-call timeout in a stable API. Wrap with
        # your own deadline (e.g. `concurrent.futures`) if you need one.
        from google.genai import types

        client = self._client()
        system_instruction, chat_history = self._split_system(messages)
        config = types.GenerateContentConfig(
            temperature=self._temperature,
            response_mime_type="application/json",
            system_instruction=system_instruction or None,
        )
        response = client.models.generate_content(
            model=self.name,
            contents=self._to_contents(chat_history),
            config=config,
        )
        return response.text or ""
