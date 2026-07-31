#!/usr/bin/env python3
"""
model_providers.py — shared pluggable LLM backend for this agent registry.

Used by both run_vision_architect.py and run_llm_council.py so the
four-provider dispatch logic exists in exactly one place (per
code_reuse_and_execution_logging.md — scripts get patched and reused,
not rewritten per agent).

Providers, selected via env var (either the global default
VISION_MODEL_PROVIDER, or an explicit `provider=` argument passed by the
caller for cases like LLM Council where different personas are meant to
be answered by genuinely different models):

    anthropic  -> ANTHROPIC_API_KEY   (default model: claude-sonnet-4-6)
    gemini     -> GEMINI_API_KEY / GOOGLE_API_KEY (default: gemini-2.5-flash)
    openai     -> OPENAI_API_KEY      (default model: gpt-4.1)
    moonshot   -> MOONSHOT_API_KEY    (default model: kimi-k3)

Endpoints/models were verified against provider docs as of this writing;
these APIs move fast, so if a call starts failing, check the provider's
current docs before assuming the dispatch logic is broken.
"""

import os
import json
import urllib.request
import urllib.error

from cli_providers import is_cli_provider, call_cli, _extract_json_object

DEFAULT_MODELS = {
    # по API-ключу
    "anthropic": "claude-sonnet-4-6",
    "gemini": "gemini-2.5-flash",
    "openai": "gpt-4.1",
    "moonshot": "kimi-k3",
    # по подписке, через официальные CLI (модель по умолчанию — та, что в CLI)
    "claude-cli": None,
    "codex-cli": None,
    "antigravity-cli": None,  # замена Gemini CLI с июня 2026 (agy), нативный бинарник
    "browser": None,          # без CLI вообще, копипаст через сайт в браузере
}


def _http_post_json(url, headers, body, timeout=60):
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code} from {url}: {e.read().decode('utf-8', 'ignore')[:500]}")


def _call_anthropic(system_prompt, user_message, model):
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY не задан")
    body = {
        "model": model,
        "max_tokens": 1000,
        "system": system_prompt,
        "messages": [{"role": "user", "content": user_message}],
    }
    headers = {
        "Content-Type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
    }
    data = _http_post_json("https://api.anthropic.com/v1/messages", headers, body)
    parts = [b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"]
    return "\n".join(parts)


def _call_gemini(system_prompt, user_message, model):
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY / GOOGLE_API_KEY не задан")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    body = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"parts": [{"text": user_message}]}],
    }
    headers = {"Content-Type": "application/json", "x-goog-api-key": api_key}
    data = _http_post_json(url, headers, body)
    try:
        return data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError):
        raise RuntimeError(f"Неожиданный формат ответа Gemini: {json.dumps(data)[:400]}")


def _call_openai_compatible(system_prompt, user_message, base_url, api_key, model, key_env_name):
    if not api_key:
        raise RuntimeError(f"{key_env_name} не задан")
    url = base_url.rstrip("/") + "/chat/completions"
    body = {
        "model": model,
        "max_tokens": 1000,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
    }
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
    data = _http_post_json(url, headers, body)
    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError):
        raise RuntimeError(f"Неожиданный формат ответа: {json.dumps(data)[:400]}")


def call_model(system_prompt, user_message, provider=None, model_name=None):
    """
    provider/model_name let a caller (e.g. LLM Council) pin a specific
    persona to a specific real model. If omitted, falls back to the
    VISION_MODEL_PROVIDER / VISION_MODEL_NAME env vars — this keeps
    existing callers (run_vision_architect.py) working unchanged.
    """
    provider = (provider or os.environ.get("VISION_MODEL_PROVIDER", "anthropic")).lower()
    model = model_name or os.environ.get("VISION_MODEL_NAME") or DEFAULT_MODELS.get(provider)

    # Режим подписки: вызываем официальный CLI как обычную программу.
    if is_cli_provider(provider):
        return call_cli(provider, system_prompt, user_message, model)

    if provider == "anthropic":
        return _call_anthropic(system_prompt, user_message, model)
    if provider == "gemini":
        return _call_gemini(system_prompt, user_message, model)
    if provider in ("openai", "chatgpt"):
        return _call_openai_compatible(
            system_prompt, user_message,
            base_url=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
            api_key=os.environ.get("OPENAI_API_KEY"),
            model=model, key_env_name="OPENAI_API_KEY",
        )
    if provider in ("moonshot", "kimi"):
        return _call_openai_compatible(
            system_prompt, user_message,
            base_url=os.environ.get("MOONSHOT_BASE_URL", "https://api.moonshot.ai/v1"),
            api_key=os.environ.get("MOONSHOT_API_KEY"),
            model=model, key_env_name="MOONSHOT_API_KEY",
        )
    raise RuntimeError(f"Неизвестный провайдер: {provider}")


def parse_model_json(raw_text):
    """
    Разбор JSON из ответа модели. CLI-режим особенно шумный (приветствия,
    подсказки, markdown), поэтому при неудаче прямого разбора вытаскиваем
    первый сбалансированный JSON-объект из текста.
    """
    clean = raw_text.strip()
    if clean.startswith("```"):
        clean = clean.split("\n", 1)[1] if "\n" in clean else clean
        if clean.endswith("```"):
            clean = clean[:-3]
        clean = clean.strip()
        if clean.lower().startswith("json"):
            clean = clean[4:].strip()
    try:
        return json.loads(clean)
    except json.JSONDecodeError:
        return json.loads(_extract_json_object(raw_text))
