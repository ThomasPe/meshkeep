//! AI assistance (ADR-0003, Epic 9): metadata suggestions from a hosted model behind a
//! user-supplied API key.
//!
//! Rules this module enforces:
//! - Nothing is sent without a key; the key never reaches `settings.json` (the shell keeps
//!   it in the OS credential store and hands it in per call).
//! - Only the thumbnail PNG, file names and sizes, README/license text and the current
//!   sidecar leave the machine. Model geometry never does.
//! - The model answers JSON against a fixed schema; the engine validates it before the UI
//!   sees it (tags trimmed and lower-cased, licenses from a known list, lengths capped).
//! - Responses are a cache keyed by a hash of the inputs (`<data dir>/ai-cache/`), never
//!   library content. The result is a suggestion; writing it is the sidecar save's job.

use crate::error::{io_err, EngineError, Result};
use crate::model::{FileKind, Project, TagCount};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// The first provider's endpoint and model; every provider has its own pair, see
/// `AiProviderKind::default_base_url` and `default_model`.
pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
/// Haiku-class: the schema is small and the inputs are a picture and a few names (ADR-0003
/// "use the smallest model that fills the schema").
pub const DEFAULT_MODEL: &str = "claude-haiku-5-5";
const ANTHROPIC_VERSION: &str = "2026-10-21";
/// Room for the model's own reasoning plus the JSON; the schema itself is small. Current
/// models think by default and the thinking counts against this cap, so it is generous.
const MAX_TOKENS: u32 = 4096;
const SCHEMA_VERSION: u32 = 1;
/// Largest thumbnail that goes into a request; ours are 512 px PNGs, far below this.
const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_DOC_CHARS: usize = 6000;
const MAX_DOCS: usize = 2;
const MAX_FILES: usize = 80;
const MAX_VOCAB: usize = 150;
const MAX_TAGS: usize = 12;

/// SPDX identifiers (plus the app's own "Personal use") a suggestion may carry; anything
/// else the model proposes is dropped rather than written into the sidecar.
pub const KNOWN_LICENSES: &[&str] = &[
    "CC-BY-4.0",
    "CC-BY-SA-4.0",
    "CC-BY-NC-4.0",
    "CC-BY-NC-SA-4.0",
    "CC-BY-ND-4.0",
    "CC-BY-NC-ND-4.0",
    "CC0-1.0",
    "MIT",
    "Apache-2.0",
    "BSD-3-Clause",
    "GPL-3.0",
    "LGPL-3.0",
    "Personal use",
];

// ---- settings ---------------------------------------------------------------------------

/// The hosted services the app has a client for. Each one has its own endpoint, default model
/// and API key: a key is only ever sent to the service it was stored for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AiProviderKind {
    #[default]
    Anthropic,
    #[serde(rename = "openai")]
    OpenAi,
    Gemini,
}

impl AiProviderKind {
    pub const ALL: [AiProviderKind; 3] = [AiProviderKind::Anthropic, AiProviderKind::OpenAi, AiProviderKind::Gemini];

    /// The name in `settings.json` and on the wire.
    pub fn id(self) -> &'static str {
        match self {
            AiProviderKind::Anthropic => "anthropic",
            AiProviderKind::OpenAi => "openai",
            AiProviderKind::Gemini => "gemini",
        }
    }

    pub fn default_base_url(self) -> &'static str {
        match self {
            AiProviderKind::Anthropic => DEFAULT_BASE_URL,
            AiProviderKind::OpenAi => "https://api.openai.com",
            AiProviderKind::Gemini => "https://generativelanguage.googleapis.com",
        }
    }

    /// The smallest current model of each service that reads a picture and fills a schema.
    pub fn default_model(self) -> &'static str {
        match self {
            AiProviderKind::Anthropic => DEFAULT_MODEL,
            AiProviderKind::OpenAi => "gpt-6-luna",
            AiProviderKind::Gemini => "gemini-3.5-flash-lite",
        }
    }
}

/// The `ai` block of `settings.json`. Never holds the key (Q26: the base URL is here from
/// the start so a local server is a configuration, not a new client).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiSettings {
    #[serde(default)]
    pub provider: AiProviderKind,
    /// `None` means the provider's default endpoint.
    #[serde(default)]
    pub base_url: Option<String>,
    /// Empty means the provider's default model (`effective_model`); `normalized` fills it in.
    #[serde(default)]
    pub model: String,
}

impl Default for AiSettings {
    fn default() -> Self {
        AiSettings {
            provider: AiProviderKind::Anthropic,
            base_url: None,
            model: DEFAULT_MODEL.to_string(),
        }
    }
}

impl AiSettings {
    /// Trims, drops empty values and refuses anything that is not an http(s) origin. An empty
    /// model becomes the provider's default, which is how the settings card switches provider.
    pub fn normalized(mut self) -> Result<AiSettings> {
        self.base_url = self
            .base_url
            .map(|u| u.trim().trim_end_matches('/').to_string())
            .filter(|u| !u.is_empty());
        if let Some(u) = &self.base_url {
            if !(u.starts_with("https://") || u.starts_with("http://")) {
                return Err(EngineError::NotAllowed(format!(
                    "base URL must start with http:// or https://: {u}"
                )));
            }
        }
        self.model = self.effective_model().to_string();
        Ok(self)
    }

    pub fn effective_base_url(&self) -> &str {
        self.base_url.as_deref().unwrap_or(self.provider.default_base_url())
    }

    /// The model a call uses: a hand-edited `settings.json` may name a provider and no model.
    pub fn effective_model(&self) -> &str {
        match self.model.trim() {
            "" => self.provider.default_model(),
            m => m,
        }
    }
}

// ---- provider ---------------------------------------------------------------------------

/// One model call: a system prompt, the user text, an optional PNG and the JSON schema the
/// answer must follow. `subject` is a short label (the project folder) for logs and mocks.
#[derive(Debug, Clone)]
pub struct AiRequest {
    pub subject: String,
    pub system: String,
    pub text: String,
    pub image_png: Option<Vec<u8>>,
    pub schema: serde_json::Value,
    pub max_tokens: u32,
}

#[derive(Debug, Clone)]
pub struct AiResponse {
    pub json: serde_json::Value,
    pub model: String,
}

pub trait AiProvider: Send + Sync {
    fn complete(&self, req: &AiRequest) -> Result<AiResponse>;
}

/// Shared handle: the engine keeps one, a long call runs outside the engine lock.
pub type SharedProvider = Arc<dyn AiProvider>;

/// The client for the service the settings name. The key must be the one stored for
/// `settings.provider`: the shell keeps one per provider and hands in the matching one.
pub fn provider_for(settings: &AiSettings, api_key: &str) -> Result<SharedProvider> {
    Ok(match settings.provider {
        AiProviderKind::Anthropic => Arc::new(AnthropicProvider::new(settings, api_key)?),
        AiProviderKind::OpenAi => Arc::new(OpenAiProvider::new(settings, api_key)?),
        AiProviderKind::Gemini => Arc::new(GeminiProvider::new(settings, api_key)?),
    })
}

fn http_client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| EngineError::AiUnavailable(e.to_string()))
}

/// One POST with a JSON body: the HTTP status and the body text, whatever the status.
fn post_json(
    client: &reqwest::blocking::Client,
    url: &str,
    headers: &[(&str, &str)],
    body: &serde_json::Value,
    api_key: &str,
) -> Result<(u16, String)> {
    let mut call = client.post(url).header("content-type", "application/json");
    for (name, value) in headers {
        call = call.header(*name, *value);
    }
    let resp = call
        .json(body)
        .send()
        .map_err(|e| EngineError::AiUnavailable(sanitize(&e.to_string(), api_key)))?;
    let status = resp.status().as_u16();
    let text = resp
        .text()
        .map_err(|e| EngineError::AiUnavailable(sanitize(&e.to_string(), api_key)))?;
    Ok((status, text))
}

/// Like `post_json` for a request with a hint not every model or server knows (how much to
/// think before answering): `body(true)` carries it; a 400 that names it (`marker`, lower
/// case) is answered with one more request without it.
fn post_with_hint(
    client: &reqwest::blocking::Client,
    url: &str,
    headers: &[(&str, &str)],
    api_key: &str,
    marker: &str,
    body: impl Fn(bool) -> serde_json::Value,
) -> Result<(u16, String)> {
    let (status, text) = post_json(client, url, headers, &body(true), api_key)?;
    if status == 400 && text.to_ascii_lowercase().contains(marker) {
        tracing::debug!("ai: the endpoint refused the {marker} hint, asking again without it");
        return post_json(client, url, headers, &body(false), api_key);
    }
    Ok((status, text))
}

/// The typed error for a failed call; all three services use these status codes alike.
fn status_error(status: u16, body: &str) -> EngineError {
    let detail = error_detail(body);
    match status {
        401 | 403 => EngineError::AiUnauthorized(detail),
        429 => EngineError::AiRateLimited(detail),
        400 | 404 | 422 => EngineError::AiInvalidResponse(format!("HTTP {status}: {detail}")),
        _ => EngineError::AiUnavailable(format!("HTTP {status}: {detail}")),
    }
}

fn declined(why: &str) -> EngineError {
    match why.trim() {
        "" => EngineError::AiInvalidResponse("the model declined this request".into()),
        why => EngineError::AiInvalidResponse(format!(
            "the model declined this request: {}",
            why.chars().take(200).collect::<String>()
        )),
    }
}

fn cut_off() -> EngineError {
    EngineError::AiInvalidResponse("answer was cut off (max_tokens)".into())
}

/// The model's text as JSON. A server without real structured output (a local one behind the
/// OpenAI client) may wrap the object in a Markdown code fence; that much is forgiven.
fn answer_json(answer: &str) -> Result<serde_json::Value> {
    let mut text = answer.trim();
    if let Some(rest) = text.strip_prefix("```") {
        text = rest.split_once('\n').map(|(_, body)| body).unwrap_or(rest);
        text = text.trim_end().strip_suffix("```").unwrap_or(text).trim();
    }
    serde_json::from_str(text).map_err(|e| EngineError::AiInvalidResponse(format!("answer is not JSON: {e}")))
}

fn response_json(body: &str) -> Result<serde_json::Value> {
    serde_json::from_str(body).map_err(|e| EngineError::AiInvalidResponse(format!("response is not JSON: {e}")))
}

fn png_base64(png: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(png)
}

/// The Anthropic Messages API over plain HTTPS (raw HTTP; there is no official Rust SDK).
pub struct AnthropicProvider {
    base_url: String,
    model: String,
    api_key: String,
    client: reqwest::blocking::Client,
}

impl AnthropicProvider {
    pub fn new(settings: &AiSettings, api_key: &str) -> Result<AnthropicProvider> {
        Ok(AnthropicProvider {
            base_url: settings.effective_base_url().to_string(),
            model: settings.effective_model().to_string(),
            api_key: api_key.to_string(),
            client: http_client()?,
        })
    }
}

#[derive(Deserialize)]
struct MessagesResponse {
    #[serde(default)]
    content: Vec<ContentBlock>,
    #[serde(default)]
    stop_reason: Option<String>,
    #[serde(default)]
    model: Option<String>,
}

#[derive(Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    text: Option<String>,
}

impl AiProvider for AnthropicProvider {
    fn complete(&self, req: &AiRequest) -> Result<AiResponse> {
        let mut content = Vec::new();
        if let Some(png) = &req.image_png {
            content.push(serde_json::json!({
                "type": "image",
                "source": { "type": "base64", "media_type": "image/png", "data": png_base64(png) }
            }));
        }
        content.push(serde_json::json!({ "type": "text", "text": req.text }));
        let body = serde_json::json!({
            "model": self.model,
            "max_tokens": req.max_tokens,
            "system": req.system,
            "messages": [{ "role": "user", "content": content }],
            "output_config": { "effort": "low", "format": { "type": "json_schema", "schema": req.schema } }
        });
        let url = format!("{}/v1/messages", self.base_url);
        tracing::debug!(subject = %req.subject, model = %self.model, "ai request");
        let headers = [("x-api-key", self.api_key.as_str()), ("anthropic-version", ANTHROPIC_VERSION)];
        let (status, text) = post_json(&self.client, &url, &headers, &body, &self.api_key)?;
        if !(200..300).contains(&status) {
            return Err(status_error(status, &text));
        }
        let parsed: MessagesResponse =
            serde_json::from_str(&text).map_err(|e| EngineError::AiInvalidResponse(format!("response is not JSON: {e}")))?;
        match parsed.stop_reason.as_deref() {
            Some("refusal") => return Err(declined("")),
            Some("max_tokens") => return Err(cut_off()),
            _ => {}
        }
        let answer = parsed
            .content
            .iter()
            .find(|b| b.kind == "text")
            .and_then(|b| b.text.clone())
            .ok_or_else(|| EngineError::AiInvalidResponse("no text block in the answer".into()))?;
        let json: serde_json::Value =
            serde_json::from_str(answer.trim()).map_err(|e| EngineError::AiInvalidResponse(format!("answer is not JSON: {e}")))?;
        Ok(AiResponse {
            json,
            model: parsed.model.unwrap_or_else(|| self.model.clone()),
        })
    }
}

/// OpenAI's Chat Completions API, the dialect most other services and local servers speak
/// too (Q26), with the answer bound to the schema by strict structured output.
pub struct OpenAiProvider {
    url: String,
    model: String,
    api_key: String,
    client: reqwest::blocking::Client,
}

impl OpenAiProvider {
    pub fn new(settings: &AiSettings, api_key: &str) -> Result<OpenAiProvider> {
        Ok(OpenAiProvider {
            url: openai_url(settings.effective_base_url()),
            model: settings.effective_model().to_string(),
            api_key: api_key.to_string(),
            client: http_client()?,
        })
    }
}

/// A bare origin gets the service's `/v1`; an endpoint with a path is the API root as the
/// OpenAI SDKs take it (`http://localhost:11434/v1`, `https://openrouter.ai/api/v1`).
fn openai_url(base: &str) -> String {
    let base = base.trim_end_matches('/');
    let after_scheme = base.split_once("://").map(|(_, rest)| rest).unwrap_or(base);
    if after_scheme.contains('/') {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    }
}

fn openai_body(req: &AiRequest, model: &str, with_effort: bool) -> serde_json::Value {
    let mut content = Vec::new();
    if let Some(png) = &req.image_png {
        content.push(serde_json::json!({
            "type": "image_url",
            "image_url": { "url": format!("data:image/png;base64,{}", png_base64(png)) }
        }));
    }
    content.push(serde_json::json!({ "type": "text", "text": req.text }));
    let mut body = serde_json::json!({
        "model": model,
        // the cap covers the model's reasoning and the answer; `max_tokens` is the deprecated name
        "max_completion_tokens": req.max_tokens,
        "messages": [
            { "role": "system", "content": req.system },
            { "role": "user", "content": content }
        ],
        "response_format": { "type": "json_schema", "json_schema": { "name": "answer", "strict": true, "schema": req.schema } }
    });
    if with_effort {
        body["reasoning_effort"] = serde_json::json!("low");
    }
    body
}

fn openai_answer(body: &str, asked_model: &str) -> Result<AiResponse> {
    let v = response_json(body)?;
    let choice = v
        .pointer("/choices/0")
        .ok_or_else(|| EngineError::AiInvalidResponse("no choice in the answer".into()))?;
    if let Some(refusal) = choice
        .pointer("/message/refusal")
        .and_then(|r| r.as_str())
        .filter(|r| !r.trim().is_empty())
    {
        return Err(declined(refusal));
    }
    match choice.get("finish_reason").and_then(|r| r.as_str()) {
        Some("length") => return Err(cut_off()),
        Some("content_filter") => return Err(declined("")),
        _ => {}
    }
    let answer = choice
        .pointer("/message/content")
        .and_then(|c| c.as_str())
        .ok_or_else(|| EngineError::AiInvalidResponse("no text in the answer".into()))?;
    Ok(AiResponse {
        json: answer_json(answer)?,
        model: v.get("model").and_then(|m| m.as_str()).unwrap_or(asked_model).to_string(),
    })
}

impl AiProvider for OpenAiProvider {
    fn complete(&self, req: &AiRequest) -> Result<AiResponse> {
        tracing::debug!(subject = %req.subject, model = %self.model, "ai request");
        let bearer = format!("Bearer {}", self.api_key);
        let headers = [("authorization", bearer.as_str())];
        // not every model takes `reasoning_effort`, and not every server knows the field
        let (status, text) = post_with_hint(&self.client, &self.url, &headers, &self.api_key, "reasoning", |with_effort| {
            openai_body(req, &self.model, with_effort)
        })?;
        if !(200..300).contains(&status) {
            return Err(status_error(status, &text));
        }
        openai_answer(&text, &self.model)
    }
}

/// Google's Gemini API (`generateContent`), with the answer bound to the schema by
/// `responseJsonSchema`. The key travels in a header, never in the URL.
pub struct GeminiProvider {
    url: String,
    model: String,
    api_key: String,
    client: reqwest::blocking::Client,
}

impl GeminiProvider {
    pub fn new(settings: &AiSettings, api_key: &str) -> Result<GeminiProvider> {
        // the model is part of the URL path; the API lists models as `models/<name>`
        let model = settings.effective_model().trim_start_matches("models/").to_string();
        if !model.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_')) {
            return Err(EngineError::NotAllowed(format!("not a Gemini model name: {model}")));
        }
        Ok(GeminiProvider {
            url: format!(
                "{}/v1beta/models/{model}:generateContent",
                settings.effective_base_url().trim_end_matches('/')
            ),
            model,
            api_key: api_key.to_string(),
            client: http_client()?,
        })
    }
}

fn gemini_body(req: &AiRequest, with_thinking_level: bool) -> serde_json::Value {
    let mut parts = Vec::new();
    if let Some(png) = &req.image_png {
        parts.push(serde_json::json!({ "inlineData": { "mimeType": "image/png", "data": png_base64(png) } }));
    }
    parts.push(serde_json::json!({ "text": req.text }));
    let mut body = serde_json::json!({
        "systemInstruction": { "parts": [{ "text": req.system }] },
        "contents": [{ "role": "user", "parts": parts }],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseJsonSchema": req.schema,
            // thinking counts against this cap, like the answer
            "maxOutputTokens": req.max_tokens
        }
    });
    if with_thinking_level {
        body["generationConfig"]["thinkingConfig"] = serde_json::json!({ "thinkingLevel": "LOW" });
    }
    body
}

fn gemini_answer(body: &str, asked_model: &str) -> Result<AiResponse> {
    let v = response_json(body)?;
    if let Some(reason) = v.pointer("/promptFeedback/blockReason").and_then(|r| r.as_str()) {
        return Err(declined(reason));
    }
    let candidate = v
        .pointer("/candidates/0")
        .ok_or_else(|| EngineError::AiInvalidResponse("no candidate in the answer".into()))?;
    let finish = candidate.get("finishReason").and_then(|r| r.as_str());
    if finish == Some("MAX_TOKENS") {
        return Err(cut_off());
    }
    // parts marked `thought` are the model's reasoning summary, not the answer
    let answer: String = candidate
        .pointer("/content/parts")
        .and_then(|p| p.as_array())
        .map(|parts| {
            parts
                .iter()
                .filter(|p| p.get("thought").and_then(|t| t.as_bool()) != Some(true))
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect()
        })
        .unwrap_or_default();
    if answer.trim().is_empty() {
        return Err(match finish {
            // SAFETY, RECITATION, PROHIBITED_CONTENT and the like end an answer before it starts
            Some(reason) if reason != "STOP" => declined(reason),
            _ => EngineError::AiInvalidResponse("no text in the answer".into()),
        });
    }
    Ok(AiResponse {
        json: answer_json(&answer)?,
        model: v.get("modelVersion").and_then(|m| m.as_str()).unwrap_or(asked_model).to_string(),
    })
}

impl AiProvider for GeminiProvider {
    fn complete(&self, req: &AiRequest) -> Result<AiResponse> {
        tracing::debug!(subject = %req.subject, model = %self.model, "ai request");
        let headers = [("x-goog-api-key", self.api_key.as_str())];
        // `thinkingLevel` is for Gemini 3 and later; older models refuse the field
        let (status, text) = post_with_hint(&self.client, &self.url, &headers, &self.api_key, "thinking", |with_level| {
            gemini_body(req, with_level)
        })?;
        if !(200..300).contains(&status) {
            // Gemini answers a wrong key with 400 INVALID_ARGUMENT, not 401
            if status == 400 && text.contains("API_KEY_INVALID") {
                return Err(EngineError::AiUnauthorized(error_detail(&text)));
            }
            return Err(status_error(status, &text));
        }
        gemini_answer(&text, &self.model)
    }
}

/// Error bodies look like `{"error":{"type":"...","message":"..."}}` with all three services;
/// keep the message.
fn error_detail(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.pointer("/error/message").and_then(|m| m.as_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| body.chars().take(300).collect())
}

/// Keeps a key out of error messages (reqwest echoes URLs, not headers, but be safe).
fn sanitize(msg: &str, key: &str) -> String {
    if key.len() >= 8 {
        msg.replace(key, "***")
    } else {
        msg.to_string()
    }
}

// ---- mock provider (tests, `MESHKEEP_AI_MOCK`) -------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MockMode {
    /// A deterministic suggestion derived from the subject.
    Ok,
    Unauthorized,
    RateLimited,
    /// Returns something that is not the schema.
    Invalid,
    Unavailable,
}

impl MockMode {
    /// `MESHKEEP_AI_MOCK` values: `ok` (or `1`), `unauthorized`, `rate_limited`, `invalid`,
    /// `unavailable`.
    pub fn parse(s: &str) -> Option<MockMode> {
        Some(match s.trim().to_ascii_lowercase().as_str() {
            "1" | "ok" | "true" => MockMode::Ok,
            "unauthorized" => MockMode::Unauthorized,
            "rate_limited" | "ratelimited" => MockMode::RateLimited,
            "invalid" => MockMode::Invalid,
            "unavailable" => MockMode::Unavailable,
            _ => return None,
        })
    }
}

/// Canned answers so UI and E2E tests run without network. Counts its calls so a test can
/// prove a cache hit.
pub struct MockProvider {
    pub mode: MockMode,
    pub calls: AtomicUsize,
}

impl MockProvider {
    pub fn new(mode: MockMode) -> MockProvider {
        MockProvider {
            mode,
            calls: AtomicUsize::new(0),
        }
    }
    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl AiProvider for MockProvider {
    fn complete(&self, req: &AiRequest) -> Result<AiResponse> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        match self.mode {
            MockMode::Unauthorized => Err(EngineError::AiUnauthorized("mock: invalid key".into())),
            MockMode::RateLimited => Err(EngineError::AiRateLimited("mock: slow down".into())),
            MockMode::Unavailable => Err(EngineError::AiUnavailable("mock: no network".into())),
            MockMode::Invalid => Ok(AiResponse {
                json: serde_json::json!("not an object"),
                model: "mock".into(),
            }),
            MockMode::Ok if req.subject == "connection test" => Ok(AiResponse {
                json: serde_json::json!({ "ok": true }),
                model: "mock".into(),
            }),
            MockMode::Ok => {
                let words: Vec<String> = req
                    .subject
                    .split(|c: char| !c.is_alphanumeric())
                    .filter(|w| w.len() > 2)
                    .map(|w| w.to_lowercase())
                    .collect();
                let mut tags = words.clone();
                tags.push("mock".into());
                let title: Vec<String> = req
                    .subject
                    .split(|c: char| !c.is_alphanumeric())
                    .filter(|w| !w.is_empty())
                    .map(|w| {
                        let mut cs = w.chars();
                        match cs.next() {
                            Some(f) => f.to_uppercase().collect::<String>() + cs.as_str(),
                            None => String::new(),
                        }
                    })
                    .collect();
                Ok(AiResponse {
                    json: serde_json::json!({
                        "title": title.join(" "),
                        "creator": "Mock Creator",
                        "license": "CC-BY-4.0",
                        "description": format!("Mock description for {}.", req.subject),
                        "tags": tags,
                    }),
                    model: "mock".into(),
                })
            }
        }
    }
}

// ---- suggestion -------------------------------------------------------------------------

/// What left the machine for this suggestion, shown in the dialog (ADR-0003 principle 3).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AiSent {
    pub thumbnail: bool,
    pub files: u32,
    pub documents: Vec<String>,
    pub sidecar: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MetadataSuggestion {
    pub title: Option<String>,
    pub creator: Option<String>,
    pub license: Option<String>,
    pub description: Option<String>,
    pub tags: Vec<String>,
    /// Tags in `tags` that no project in the library carries yet (Q24: shown as new).
    pub new_tags: Vec<String>,
    pub model: String,
    pub cached: bool,
    pub sent: AiSent,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiTestReport {
    pub model: String,
}

#[derive(Deserialize)]
struct RawSuggestion {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    creator: Option<String>,
    #[serde(default)]
    license: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    tags: Option<Vec<String>>,
}

fn suggestion_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "title": { "type": ["string", "null"], "description": "Short, human-readable project title. Null when the current title is already good." },
            "creator": { "type": ["string", "null"], "description": "Designer or author name if it can be read from the inputs, else null. Never guess." },
            // Structured outputs refuse an `enum` on a `["string", "null"]` type union ("Enum
            // value 'CC-BY-4.0' does not match declared type"), so the nullable enum is an
            // `anyOf` of a single-typed enum and null.
            "license": { "anyOf": [{ "type": "string", "enum": KNOWN_LICENSES }, { "type": "null" }], "description": "SPDX identifier when the inputs state the license, else null." },
            "description": { "type": ["string", "null"], "description": "One to three sentences on what the model is and what it is for." },
            "tags": { "type": "array", "items": { "type": "string" }, "description": "Up to 8 lower-case tags. Prefer tags from the library vocabulary; add a new one only when nothing fits." }
        },
        "required": ["title", "creator", "license", "description", "tags"],
        "additionalProperties": false
    })
}

const SYSTEM_PROMPT: &str = "You help a hobbyist catalogue a local 3D-printing model library. \
You see a rendered preview of one project (when available), its folder and file names, text files from the download, \
and the metadata already recorded. Propose metadata for the project.yaml sidecar. Be concrete and brief. \
Only fill creator and license when the inputs state them; never invent names or licenses. \
Tags are lower-case single words or hyphenated phrases; reuse the library vocabulary wherever it fits. \
Answer with JSON only.";

/// Everything needed for one call, built under the engine lock; the call itself runs without
/// it (`run_suggestion`).
pub struct PreparedSuggestion {
    pub request: AiRequest,
    pub cache_path: PathBuf,
    pub vocabulary: Vec<String>,
    pub sent: AiSent,
    /// A cached answer; when `Some`, no call is needed.
    pub cached: Option<MetadataSuggestion>,
}

fn folder_name(p: &Project, root_dir: &Path) -> String {
    match p.rel_path.rsplit('/').next() {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => root_dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| p.title.clone()),
    }
}

fn is_text_doc(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let ext_ok = lower.ends_with(".md") || lower.ends_with(".txt");
    let stem_ok = ["readme", "license", "licence", "notes", "about", "info", "description"]
        .iter()
        .any(|k| lower.contains(k));
    ext_ok && (stem_ok || lower.len() <= 24)
}

fn clip(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max_chars).collect();
        format!("{cut}\n[truncated]")
    }
}

/// Builds the prompt from what the project already has on disk. Reads README-like text
/// files and the cached thumbnail; never a model file.
pub fn prepare(
    data_dir: &Path,
    project: &Project,
    project_dir: &Path,
    thumbnail: Option<&Path>,
    tag_counts: &[TagCount],
    model: &str,
    read_doc: &dyn Fn(&crate::model::FileEntry) -> Option<String>,
) -> Result<PreparedSuggestion> {
    let subject = folder_name(project, project_dir);
    let mut text = String::new();
    text.push_str(&format!("Project folder: {subject}\n"));
    if !project.rel_path.is_empty() {
        text.push_str(&format!("Path in library: {}\n", project.rel_path));
    }
    let mut sent = AiSent::default();

    // current sidecar values
    let has_sidecar = matches!(project.sidecar, crate::model::SidecarState::Ok);
    if has_sidecar || !project.tags.is_empty() || project.creator.is_some() || project.description.is_some() {
        sent.sidecar = true;
        text.push_str("\nCurrent metadata:\n");
        text.push_str(&format!("- title: {}\n", project.title));
        if let Some(c) = &project.creator {
            text.push_str(&format!("- creator: {c}\n"));
        }
        if let Some(l) = &project.license {
            text.push_str(&format!("- license: {l}\n"));
        }
        if let Some(u) = &project.source_url {
            text.push_str(&format!("- source_url: {u}\n"));
        }
        if let Some(d) = &project.description {
            text.push_str(&format!("- description: {}\n", clip(d, 600)));
        }
        if !project.tags.is_empty() {
            text.push_str(&format!("- tags: {}\n", project.tags.join(", ")));
        }
    } else {
        text.push_str(&format!("Current title (from the folder name): {}\n", project.title));
    }

    // file list
    text.push_str("\nFiles:\n");
    for f in project.files.iter().take(MAX_FILES) {
        let kind = match f.kind {
            FileKind::Model => "model",
            FileKind::Image => "image",
            FileKind::Document => "document",
            FileKind::Attachment => "archive",
            FileKind::Other => "other",
        };
        text.push_str(&format!("- {} ({kind}, {} KB)\n", f.rel_path, f.size / 1024));
    }
    if project.files.len() > MAX_FILES {
        text.push_str(&format!("- ... and {} more\n", project.files.len() - MAX_FILES));
    }
    sent.files = project.files.len().min(MAX_FILES) as u32;

    // README-like documents
    let mut docs = 0;
    for f in project
        .files
        .iter()
        .filter(|f| f.kind == FileKind::Document && is_text_doc(&f.name))
    {
        if docs >= MAX_DOCS {
            break;
        }
        match read_doc(f) {
            Some(body) => {
                text.push_str(&format!("\n--- {} ---\n{}\n", f.rel_path, clip(body.trim(), MAX_DOC_CHARS)));
                sent.documents.push(f.rel_path.clone());
                docs += 1;
            }
            None => tracing::debug!("ai: skip {}", f.rel_path),
        }
    }

    // vocabulary
    let vocabulary: Vec<String> = tag_counts.iter().take(MAX_VOCAB).map(|t| t.tag.clone()).collect();
    if !vocabulary.is_empty() {
        text.push_str(&format!("\nLibrary tag vocabulary: {}\n", vocabulary.join(", ")));
    }

    // thumbnail
    let image_png = thumbnail.and_then(|p| match std::fs::read(p) {
        Ok(bytes) if bytes.len() <= MAX_IMAGE_BYTES && bytes.starts_with(b"\x89PNG") => Some(bytes),
        Ok(_) => None,
        Err(e) => {
            tracing::debug!("ai: no thumbnail {}: {e}", p.display());
            None
        }
    });
    sent.thumbnail = image_png.is_some();
    if sent.thumbnail {
        text.push_str("\nThe attached image is a rendered preview of the main model file.\n");
    }

    let request = AiRequest {
        subject,
        system: SYSTEM_PROMPT.to_string(),
        text,
        image_png,
        schema: suggestion_schema(),
        max_tokens: MAX_TOKENS,
    };

    // cache key: everything that influences the answer
    let mut h = Sha256::new();
    h.update(SCHEMA_VERSION.to_le_bytes());
    h.update(model.as_bytes());
    h.update(b"\0");
    h.update(request.system.as_bytes());
    h.update(b"\0");
    h.update(request.text.as_bytes());
    h.update(b"\0");
    if let Some(png) = &request.image_png {
        h.update(png);
    }
    let key = format!("{:x}", h.finalize());
    let cache_path = cache_dir(data_dir).join(format!("{key}.json"));
    let cached = std::fs::read_to_string(&cache_path)
        .ok()
        .and_then(|t| serde_json::from_str::<MetadataSuggestion>(&t).ok())
        .map(|mut s| {
            s.cached = true;
            s.sent = sent.clone();
            s
        });

    Ok(PreparedSuggestion {
        request,
        cache_path,
        vocabulary,
        sent,
        cached,
    })
}

pub fn cache_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("ai-cache")
}

/// Calls the provider (unless the answer is cached), validates the answer against the
/// schema rules and stores it in the cache.
pub fn run_suggestion(prepared: PreparedSuggestion, provider: &dyn AiProvider) -> Result<MetadataSuggestion> {
    if let Some(cached) = prepared.cached {
        return Ok(cached);
    }
    let answer = provider.complete(&prepared.request)?;
    let mut suggestion = validate(answer.json, &prepared.vocabulary)?;
    suggestion.model = answer.model;
    suggestion.sent = prepared.sent;
    if let Some(dir) = prepared.cache_path.parent() {
        std::fs::create_dir_all(dir).map_err(io_err(dir))?;
    }
    let text = serde_json::to_string(&suggestion).map_err(|e| EngineError::Serde(e.to_string()))?;
    let tmp = prepared.cache_path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(io_err(&tmp))?;
    std::fs::rename(&tmp, &prepared.cache_path).map_err(io_err(&prepared.cache_path))?;
    Ok(suggestion)
}

fn clean(v: Option<String>, max_chars: usize) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).map(|s| {
        if s.chars().count() > max_chars {
            s.chars().take(max_chars).collect()
        } else {
            s
        }
    })
}

/// Turns the model's JSON into a suggestion the UI can show: unknown fields are ignored,
/// bad values dropped, and only `KNOWN_LICENSES` pass.
pub fn validate(json: serde_json::Value, vocabulary: &[String]) -> Result<MetadataSuggestion> {
    if !json.is_object() {
        return Err(EngineError::AiInvalidResponse("answer is not a JSON object".into()));
    }
    let raw: RawSuggestion =
        serde_json::from_value(json).map_err(|e| EngineError::AiInvalidResponse(format!("answer does not match the schema: {e}")))?;
    let mut tags: Vec<String> = raw
        .tags
        .unwrap_or_default()
        .into_iter()
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty() && t.chars().count() <= 40)
        .collect();
    let mut seen = std::collections::BTreeSet::new();
    tags.retain(|t| seen.insert(t.clone()));
    tags.truncate(MAX_TAGS);
    let new_tags = tags.iter().filter(|t| !vocabulary.contains(t)).cloned().collect();
    let license = clean(raw.license, 40)
        .filter(|l| KNOWN_LICENSES.iter().any(|k| k.eq_ignore_ascii_case(l)))
        .map(|l| {
            KNOWN_LICENSES
                .iter()
                .find(|k| k.eq_ignore_ascii_case(&l))
                .map(|k| k.to_string())
                .unwrap_or(l)
        });
    Ok(MetadataSuggestion {
        title: clean(raw.title, 120),
        creator: clean(raw.creator, 80),
        license,
        description: clean(raw.description, 1000),
        tags,
        new_tags,
        model: String::new(),
        cached: false,
        sent: AiSent::default(),
    })
}

/// A tiny request that proves the key, endpoint and model work together.
pub fn test_request() -> AiRequest {
    AiRequest {
        subject: "connection test".into(),
        system: "Answer with JSON only.".into(),
        text: "Reply with {\"ok\": true}.".into(),
        image_png: None,
        schema: serde_json::json!({ "type": "object", "properties": { "ok": { "type": "boolean" } }, "required": ["ok"], "additionalProperties": false }),
        // the model may think before it answers, and that shares the cap with the answer
        max_tokens: 1024,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_cleans_tags_and_licenses() {
        let s = validate(
            serde_json::json!({ "title": "  Bin  ", "creator": "", "license": "cc-by-4.0", "description": null, "tags": ["Gridfinity", " bin", "bin", "", "x".repeat(50)], "extra": 1 }),
            &["bin".into()],
        )
        .unwrap();
        assert_eq!(s.title.as_deref(), Some("Bin"));
        assert_eq!(s.creator, None);
        assert_eq!(s.license.as_deref(), Some("CC-BY-4.0"));
        assert_eq!(s.tags, vec!["gridfinity", "bin"]);
        assert_eq!(s.new_tags, vec!["gridfinity"]);
        let unknown = validate(serde_json::json!({ "license": "WTFPL", "tags": [] }), &[]).unwrap();
        assert_eq!(unknown.license, None);
        assert!(matches!(
            validate(serde_json::json!([1, 2]), &[]),
            Err(EngineError::AiInvalidResponse(_))
        ));
    }

    /// The API's structured-output validator rejects an `enum` whose node declares a type
    /// union (issue #56: "Enum value 'CC-BY-4.0' does not match declared type ['string',
    /// 'null']"). Every enum must sit on a node with exactly one type, and every value must
    /// be of that type.
    #[test]
    fn schema_enums_sit_on_single_typed_nodes() {
        fn walk(v: &serde_json::Value, path: &str) {
            if let Some(obj) = v.as_object() {
                if let Some(values) = obj.get("enum").and_then(|e| e.as_array()) {
                    let ty = obj.get("type").and_then(|t| t.as_str());
                    assert!(ty.is_some(), "{path}: enum without a single `type`");
                    for value in values {
                        let matches = match ty {
                            Some("string") => value.is_string(),
                            Some("null") => value.is_null(),
                            Some("boolean") => value.is_boolean(),
                            Some("integer") | Some("number") => value.is_number(),
                            _ => false,
                        };
                        assert!(matches, "{path}: enum value {value} does not match type {ty:?}");
                    }
                }
                for (k, child) in obj {
                    walk(child, &format!("{path}/{k}"));
                }
            } else if let Some(items) = v.as_array() {
                for (i, child) in items.iter().enumerate() {
                    walk(child, &format!("{path}/{i}"));
                }
            }
        }
        let schema = suggestion_schema();
        walk(&schema, "");
        walk(&test_request().schema, "test");
        // the license stays nullable and still lists every known license
        let license = &schema["properties"]["license"]["anyOf"];
        assert_eq!(license[0]["enum"].as_array().unwrap().len(), KNOWN_LICENSES.len());
        assert_eq!(license[1]["type"], "null");
    }

    #[test]
    fn settings_normalize_base_url() {
        let s = AiSettings {
            provider: AiProviderKind::Anthropic,
            base_url: Some(" http://localhost:11434/ ".into()),
            model: " ".into(),
        }
        .normalized()
        .unwrap();
        assert_eq!(s.base_url.as_deref(), Some("http://localhost:11434"));
        assert_eq!(s.model, DEFAULT_MODEL);
        assert_eq!(AiSettings::default().effective_base_url(), DEFAULT_BASE_URL);
        assert!(AiSettings {
            base_url: Some("ftp://x".into()),
            ..AiSettings::default()
        }
        .normalized()
        .is_err());
    }

    /// Every provider has its own endpoint and default model; an empty model means that
    /// default, and a `settings.json` from before there was a choice still reads as Anthropic.
    #[test]
    fn each_provider_has_its_own_endpoint_and_default_model() {
        for kind in AiProviderKind::ALL {
            let s = AiSettings {
                provider: kind,
                base_url: None,
                model: String::new(),
            };
            assert_eq!(s.effective_base_url(), kind.default_base_url());
            assert_eq!(
                s.effective_model(),
                kind.default_model(),
                "unnormalized settings still name a model"
            );
            assert_eq!(s.normalized().unwrap().model, kind.default_model());
            assert_eq!(serde_json::to_value(kind).unwrap(), kind.id());
            assert!(kind.default_base_url().starts_with("https://"));
        }
        let ids: Vec<_> = AiProviderKind::ALL.iter().map(|k| k.id()).collect();
        assert_eq!(ids, ["anthropic", "openai", "gemini"]);
        let old: AiSettings = serde_json::from_str(r#"{ "base_url": null, "model": "claude-haiku-5-5" }"#).unwrap();
        assert_eq!(old, AiSettings::default());
        let edited: AiSettings = serde_json::from_str(r#"{ "provider": "gemini" }"#).unwrap();
        assert_eq!(edited.effective_model(), "gemini-3.5-flash-lite");
        // a chosen model survives, whatever the provider
        let kept = AiSettings {
            provider: AiProviderKind::OpenAi,
            base_url: None,
            model: " my-model ".into(),
        };
        assert_eq!(kept.normalized().unwrap().model, "my-model");
    }

    fn sample_request(image: bool) -> AiRequest {
        AiRequest {
            subject: "Cable Clips".into(),
            system: "Answer with JSON only.".into(),
            text: "Project folder: Cable Clips".into(),
            image_png: image.then(|| b"\x89PNG-bytes".to_vec()),
            schema: suggestion_schema(),
            max_tokens: 4096,
        }
    }

    #[test]
    fn openai_requests_follow_chat_completions() {
        let body = openai_body(&sample_request(true), "gpt-6-luna", true);
        assert_eq!(body["model"], "gpt-6-luna");
        assert_eq!(body["max_completion_tokens"], 4096);
        assert!(
            body.get("max_tokens").is_none(),
            "the deprecated cap is refused by reasoning models"
        );
        assert_eq!(body["reasoning_effort"], "low");
        assert_eq!(
            body["messages"][0],
            serde_json::json!({ "role": "system", "content": "Answer with JSON only." })
        );
        let content = &body["messages"][1]["content"];
        assert_eq!(content[0]["type"], "image_url");
        assert_eq!(
            content[0]["image_url"]["url"],
            format!("data:image/png;base64,{}", png_base64(b"\x89PNG-bytes"))
        );
        assert_eq!(
            content[1],
            serde_json::json!({ "type": "text", "text": "Project folder: Cable Clips" })
        );
        let format = &body["response_format"];
        assert_eq!(format["type"], "json_schema");
        assert_eq!(format["json_schema"]["strict"], true);
        assert_eq!(format["json_schema"]["schema"], suggestion_schema());
        // without a picture there is only the text; without the hint, no effort field
        let plain = openai_body(&sample_request(false), "m", false);
        assert_eq!(plain["messages"][1]["content"].as_array().unwrap().len(), 1);
        assert!(plain.get("reasoning_effort").is_none());

        // a bare origin gets /v1, an endpoint with a path is the API root
        assert_eq!(openai_url("https://api.openai.com"), "https://api.openai.com/v1/chat/completions");
        assert_eq!(
            openai_url("http://localhost:11434/v1/"),
            "http://localhost:11434/v1/chat/completions"
        );
        assert_eq!(
            openai_url("https://openrouter.ai/api/v1"),
            "https://openrouter.ai/api/v1/chat/completions"
        );
    }

    /// Strict structured output takes a schema only when every object closes itself and
    /// requires all of its properties (optional fields are nullable instead).
    #[test]
    fn schemas_are_strict_enough_for_openai() {
        fn walk(v: &serde_json::Value, path: &str) {
            if let Some(obj) = v.as_object() {
                if obj.get("type").and_then(|t| t.as_str()) == Some("object") {
                    assert_eq!(obj.get("additionalProperties"), Some(&serde_json::json!(false)), "{path}");
                    let mut props: Vec<&str> = obj["properties"].as_object().unwrap().keys().map(|k| k.as_str()).collect();
                    let mut required: Vec<&str> = obj["required"].as_array().unwrap().iter().map(|r| r.as_str().unwrap()).collect();
                    props.sort();
                    required.sort();
                    assert_eq!(props, required, "{path}: every property must be required");
                }
                for (k, child) in obj {
                    walk(child, &format!("{path}/{k}"));
                }
            } else if let Some(items) = v.as_array() {
                for (i, child) in items.iter().enumerate() {
                    walk(child, &format!("{path}/{i}"));
                }
            }
        }
        walk(&suggestion_schema(), "");
        walk(&test_request().schema, "test");
    }

    #[test]
    fn openai_answers_are_read_and_refusals_are_errors() {
        let ok = openai_answer(
            r#"{ "model": "gpt-6-luna-2026-09-01", "choices": [{ "finish_reason": "stop", "message": { "role": "assistant", "content": "{\"ok\": true}", "refusal": null } }] }"#,
            "gpt-6-luna",
        )
        .unwrap();
        assert_eq!(ok.json, serde_json::json!({ "ok": true }));
        assert_eq!(ok.model, "gpt-6-luna-2026-09-01");
        // a local server may fence the object and leave the model out
        let fenced = openai_answer(
            r#"{ "choices": [{ "finish_reason": "stop", "message": { "content": "```json\n{\"ok\": true}\n```" } }] }"#,
            "llava",
        )
        .unwrap();
        assert_eq!(fenced.json["ok"], true);
        assert_eq!(fenced.model, "llava");
        let message = |body: &str| match openai_answer(body, "m") {
            Err(EngineError::AiInvalidResponse(m)) => m,
            other => panic!("expected an invalid response, got {other:?}"),
        };
        assert!(message(
            r#"{ "choices": [{ "finish_reason": "stop", "message": { "content": null, "refusal": "I cannot help with that." } }] }"#
        )
        .contains("declined this request: I cannot help"));
        assert!(message(r#"{ "choices": [{ "finish_reason": "length", "message": { "content": "{\"ok\"" } }] }"#).contains("cut off"));
        assert!(message(r#"{ "choices": [{ "finish_reason": "content_filter", "message": { "content": "" } }] }"#).contains("declined"));
        assert!(message(r#"{ "choices": [] }"#).contains("no choice"));
        assert!(
            message(r#"{ "choices": [{ "finish_reason": "stop", "message": { "content": "sure, here it is" } }] }"#).contains("not JSON")
        );
        assert!(message("<html>").contains("response is not JSON"));
    }

    #[test]
    fn gemini_requests_follow_generate_content() {
        let body = gemini_body(&sample_request(true), true);
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], "Answer with JSON only.");
        let parts = &body["contents"][0]["parts"];
        assert_eq!(body["contents"][0]["role"], "user");
        assert_eq!(
            parts[0]["inlineData"],
            serde_json::json!({ "mimeType": "image/png", "data": png_base64(b"\x89PNG-bytes") })
        );
        assert_eq!(parts[1]["text"], "Project folder: Cable Clips");
        let config = &body["generationConfig"];
        assert_eq!(config["responseMimeType"], "application/json");
        assert_eq!(config["responseJsonSchema"], suggestion_schema());
        assert_eq!(config["maxOutputTokens"], 4096);
        assert_eq!(config["thinkingConfig"]["thinkingLevel"], "LOW");
        let plain = gemini_body(&sample_request(false), false);
        assert_eq!(plain["contents"][0]["parts"].as_array().unwrap().len(), 1);
        assert!(plain["generationConfig"].get("thinkingConfig").is_none());

        // the model is part of the path: `models/` is dropped, anything that is not a name refused
        let settings = |model: &str| AiSettings {
            provider: AiProviderKind::Gemini,
            base_url: None,
            model: model.into(),
        };
        let p = GeminiProvider::new(&settings("models/gemini-3.5-flash-lite"), "key").unwrap();
        assert_eq!(
            p.url,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent"
        );
        assert!(!p.url.contains("key"), "the key is a header, never part of the URL");
        assert!(matches!(
            GeminiProvider::new(&settings("x/../y?key=1"), "key"),
            Err(EngineError::NotAllowed(_))
        ));
    }

    #[test]
    fn gemini_answers_skip_thoughts_and_blocked_prompts_are_errors() {
        let ok = gemini_answer(
            r#"{ "candidates": [{ "content": { "role": "model", "parts": [{ "text": "the user wants ok", "thought": true }, { "text": "{\"ok\":" }, { "text": " true}" }] }, "finishReason": "STOP" }], "modelVersion": "gemini-3.5-flash-lite-001" }"#,
            "gemini-3.5-flash-lite",
        )
        .unwrap();
        assert_eq!(ok.json, serde_json::json!({ "ok": true }));
        assert_eq!(ok.model, "gemini-3.5-flash-lite-001");
        let message = |body: &str| match gemini_answer(body, "m") {
            Err(EngineError::AiInvalidResponse(m)) => m,
            other => panic!("expected an invalid response, got {other:?}"),
        };
        assert!(message(r#"{ "promptFeedback": { "blockReason": "SAFETY" } }"#).contains("declined this request: SAFETY"));
        assert!(message(r#"{ "candidates": [{ "finishReason": "RECITATION" }] }"#).contains("declined this request: RECITATION"));
        assert!(
            message(r#"{ "candidates": [{ "content": { "parts": [{ "text": "{\"ok\"" }] }, "finishReason": "MAX_TOKENS" }] }"#)
                .contains("cut off")
        );
        assert!(message(r#"{ "candidates": [{ "content": { "parts": [] }, "finishReason": "STOP" }] }"#).contains("no text"));
        assert!(message(r#"{ "candidates": [] }"#).contains("no candidate"));
    }

    #[test]
    fn failed_calls_map_to_typed_errors() {
        let openai =
            r#"{ "error": { "message": "Incorrect API key provided.", "type": "invalid_request_error", "code": "invalid_api_key" } }"#;
        assert!(matches!(status_error(401, openai), EngineError::AiUnauthorized(m) if m == "Incorrect API key provided."));
        assert!(matches!(status_error(403, "{}"), EngineError::AiUnauthorized(_)));
        assert!(matches!(status_error(429, "{}"), EngineError::AiRateLimited(_)));
        assert!(
            matches!(status_error(404, r#"{ "error": { "message": "no such model" } }"#), EngineError::AiInvalidResponse(m) if m == "HTTP 404: no such model")
        );
        assert!(matches!(status_error(503, "busy"), EngineError::AiUnavailable(m) if m == "HTTP 503: busy"));
    }

    // ---- the clients against a canned server on localhost -----------------------------------

    /// Answers one connection per canned reply and returns what each request sent (head and
    /// body, as text), so a test sees the path, the headers and the JSON that left.
    fn serve(replies: Vec<(u16, &'static str)>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for (status, reply) in replies {
                let (mut stream, _) = listener.accept().unwrap();
                let mut raw = Vec::new();
                let mut buf = [0u8; 4096];
                loop {
                    let n = stream.read(&mut buf).unwrap();
                    raw.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&raw);
                    if let Some((head, body)) = text.split_once("\r\n\r\n") {
                        let length = head
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if body.len() >= length {
                            break;
                        }
                    }
                    if n == 0 {
                        break;
                    }
                }
                seen.push(String::from_utf8_lossy(&raw).into_owned());
                let answer = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
                    reply.len()
                );
                stream.write_all(answer.as_bytes()).unwrap();
            }
            seen
        });
        (base, handle)
    }

    /// A client that talks to the canned server directly, whatever proxy the environment names.
    fn direct_client() -> reqwest::blocking::Client {
        reqwest::blocking::Client::builder().no_proxy().build().unwrap()
    }

    fn sent_json(request: &str) -> serde_json::Value {
        serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap()
    }

    const OPENAI_OK: &str =
        r#"{ "model": "gpt-6-luna", "choices": [{ "finish_reason": "stop", "message": { "content": "{\"ok\": true}" } }] }"#;

    #[test]
    fn the_openai_client_sends_a_bearer_key_and_asks_again_without_an_effort_the_model_refuses() {
        let (base, server) = serve(vec![
            (
                400,
                r#"{ "error": { "message": "Unsupported parameter: 'reasoning_effort' is not supported with this model." } }"#,
            ),
            (200, OPENAI_OK),
            (401, r#"{ "error": { "message": "Incorrect API key provided." } }"#),
        ]);
        let provider = OpenAiProvider {
            url: openai_url(&base),
            model: "gpt-6-luna".into(),
            api_key: "sk-openai-test-key".into(),
            client: direct_client(),
        };
        let answer = provider.complete(&test_request()).unwrap();
        assert_eq!(answer.json["ok"], true);
        assert_eq!(answer.model, "gpt-6-luna");
        assert!(matches!(provider.complete(&test_request()), Err(EngineError::AiUnauthorized(m)) if m.contains("Incorrect API key")));
        let seen = server.join().unwrap();
        assert_eq!(seen.len(), 3);
        for request in &seen {
            assert!(request.starts_with("POST /v1/chat/completions HTTP/1.1"), "{request}");
            assert!(request.to_ascii_lowercase().contains("authorization: bearer sk-openai-test-key"));
        }
        assert_eq!(sent_json(&seen[0])["reasoning_effort"], "low");
        assert!(
            sent_json(&seen[1]).get("reasoning_effort").is_none(),
            "the second try drops the refused field"
        );
        assert_eq!(sent_json(&seen[1])["response_format"]["json_schema"]["strict"], true);
    }

    #[test]
    fn the_gemini_client_sends_the_key_as_a_header_and_reads_a_wrong_key_as_unauthorized() {
        let (base, server) = serve(vec![
            (
                200,
                r#"{ "candidates": [{ "content": { "parts": [{ "text": "{\"ok\": true}" }] }, "finishReason": "STOP" }], "modelVersion": "gemini-3.5-flash-lite" }"#,
            ),
            (
                400,
                r#"{ "error": { "code": 400, "message": "API key not valid. Please pass a valid API key.", "status": "INVALID_ARGUMENT", "details": [{ "reason": "API_KEY_INVALID" }] } }"#,
            ),
            (
                429,
                r#"{ "error": { "code": 429, "message": "Quota exceeded.", "status": "RESOURCE_EXHAUSTED" } }"#,
            ),
        ]);
        let settings = AiSettings {
            provider: AiProviderKind::Gemini,
            base_url: Some(base),
            model: String::new(),
        };
        let provider = GeminiProvider {
            client: direct_client(),
            ..GeminiProvider::new(&settings, "gemini-test-key-123").unwrap()
        };
        let answer = provider.complete(&test_request()).unwrap();
        assert_eq!(answer.json["ok"], true);
        assert!(matches!(provider.complete(&test_request()), Err(EngineError::AiUnauthorized(m)) if m.contains("API key not valid")));
        assert!(matches!(provider.complete(&test_request()), Err(EngineError::AiRateLimited(m)) if m == "Quota exceeded."));
        let seen = server.join().unwrap();
        assert_eq!(seen.len(), 3, "a wrong key is not asked twice");
        let first = &seen[0];
        assert!(
            first.starts_with("POST /v1beta/models/gemini-3.5-flash-lite:generateContent HTTP/1.1"),
            "{first}"
        );
        assert!(first.to_ascii_lowercase().contains("x-goog-api-key: gemini-test-key-123"));
        assert!(!first.lines().next().unwrap().contains("gemini-test-key-123"), "never in the URL");
        assert_eq!(sent_json(first)["generationConfig"]["responseMimeType"], "application/json");
    }

    #[test]
    fn provider_for_builds_the_client_the_settings_name() {
        for kind in AiProviderKind::ALL {
            let settings = AiSettings {
                provider: kind,
                base_url: None,
                model: String::new(),
            };
            assert!(provider_for(&settings, "key").is_ok(), "{kind:?}");
        }
    }

    #[test]
    fn mock_modes_parse() {
        assert_eq!(MockMode::parse("1"), Some(MockMode::Ok));
        assert_eq!(MockMode::parse("Unauthorized"), Some(MockMode::Unauthorized));
        assert_eq!(MockMode::parse("nope"), None);
    }
}
