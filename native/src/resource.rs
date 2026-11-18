use crate::{
    dpop,
    error::{Result, fail},
    integrity, pkce, profile, protocol, storage, token, transport,
};
use napi_derive::napi;
use reqwest::header::{HeaderMap, HeaderValue};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::watch;

const MAX_BODY: usize = 13 * 1024 * 1024;
const MAX_RESPONSE: usize = 1024 * 1024;
const MAX_QUESTIONS: usize = 256;
const MAX_ACTIVE: usize = 64;

#[napi(object)]
pub struct EvaluationQuestion {
    pub id: String,
    pub instructions: String,
}

#[napi(object)]
pub struct EvaluationInput {
    pub state_json: String,
    pub questions: Vec<EvaluationQuestion>,
}

// No destination, model, method, arbitrary headers or signature interface is
// exposed. The login session owns the endpoint and model; only noul evaluation
// is supported. This boundary is not remote application attestation.
pub(crate) struct Input {
    pub(crate) state: Value,
    pub(crate) questions: BTreeMap<String, Value>,
}

fn validate(input: EvaluationInput) -> Result<Input> {
    if input.state_json.len() > MAX_BODY
        || input.questions.is_empty()
        || input.questions.len() > MAX_QUESTIONS
    {
        return Err(fail("evaluation exceeds input limits"));
    }
    let state: Value = serde_json::from_str(&input.state_json)
        .map_err(|_| fail("evaluation state must be a JSON object"))?;
    if !state.is_object() || state.as_object().is_some_and(|s| s.is_empty()) {
        return Err(fail("evaluation state must be a nonempty JSON object"));
    }
    let mut size = input.state_json.len();
    let mut questions = BTreeMap::new();
    for question in input.questions {
        size = size
            .saturating_add(question.id.len())
            .saturating_add(question.instructions.len());
        if question.id.is_empty()
            || question.id.len() > 128
            || !question
                .id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            || question.instructions.is_empty()
            || question.instructions.len() > 65536
            || size > MAX_BODY
        {
            return Err(fail("invalid evaluation question or input size"));
        }
        if questions
            .insert(
                question.id,
                json!({"type": "noul", "instructions": question.instructions}),
            )
            .is_some()
        {
            return Err(fail("duplicate evaluation question"));
        }
    }
    Ok(Input { state, questions })
}

fn serialize(input: &Input, model: &str) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(
        &json!({"model": model, "state": input.state, "questions": input.questions}),
    )
    .map_err(|_| fail("cannot serialize evaluation"))?;
    if bytes.len() > MAX_BODY
        || (profile::native_build() && input.state.get("items").is_some() && bytes.len() > 38_320)
    {
        return Err(fail("serialized evaluation exceeds its operation limit"));
    }
    Ok(bytes)
}

struct Operation {
    namespace: String,
    input: Option<Input>,
    cancel: watch::Sender<bool>,
    deadline: Instant,
}

static OPERATIONS: LazyLock<Mutex<HashMap<String, Operation>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn begin(namespace: String, input: EvaluationInput, timeout_ms: Option<u32>) -> Result<String> {
    if profile::native_build() {
        return Err(fail("use a registered jg operation"));
    }
    schedule(namespace, validate(input)?, timeout_ms)
}
pub fn begin_operation(
    namespace: String,
    operation: &str,
    input: &str,
    timeout_ms: Option<u32>,
) -> Result<String> {
    if !profile::native_build() {
        return Err(fail("registered operations require a native build"));
    }
    schedule(
        namespace,
        crate::operations::build(operation, input)?,
        timeout_ms,
    )
}
fn schedule(namespace: String, input: Input, timeout_ms: Option<u32>) -> Result<String> {
    if namespace.is_empty() || namespace.len() > 128 {
        return Err(fail("invalid evaluation session"));
    }
    let timeout = timeout_ms.unwrap_or(60_000);
    if timeout == 0 || timeout > 60_000 {
        return Err(fail("evaluation timeout must be 1–60000 milliseconds"));
    }
    let mut operations = OPERATIONS
        .lock()
        .map_err(|_| fail("evaluation state unavailable"))?;
    operations.retain(|_, op| op.input.is_none() || op.deadline > Instant::now());
    if operations.len() >= MAX_ACTIVE {
        return Err(fail("too many pending evaluations"));
    }
    let handle = pkce::random();
    let (cancel, _) = watch::channel(false);
    operations.insert(
        handle.clone(),
        Operation {
            namespace,
            input: Some(input),
            cancel,
            deadline: Instant::now() + Duration::from_millis(timeout.into()),
        },
    );
    Ok(handle)
}

pub fn cancel(handle: &str) {
    if let Ok(operations) = OPERATIONS.lock()
        && let Some(op) = operations.get(handle)
    {
        op.cancel.send_replace(true);
    }
}

struct Cleanup(String);
impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Ok(mut operations) = OPERATIONS.lock() {
            operations.remove(&self.0);
        }
    }
}

#[napi(object)]
pub struct EvaluationResponse {
    pub status: u32,
    pub body: String,
    pub retry_after: Option<String>,
}

pub async fn execute(handle: String) -> Result<EvaluationResponse> {
    let (namespace, input, mut cancelled, deadline) = {
        let mut operations = OPERATIONS
            .lock()
            .map_err(|_| fail("evaluation state unavailable"))?;
        let op = operations
            .get_mut(&handle)
            .ok_or_else(|| fail("unknown evaluation"))?;
        let input = op
            .input
            .take()
            .ok_or_else(|| fail("evaluation already started"))?;
        (
            op.namespace.clone(),
            input,
            op.cancel.subscribe(),
            op.deadline,
        )
    };
    let _cleanup = Cleanup(handle);
    if *cancelled.borrow() {
        return Err(fail("evaluation cancelled"));
    }
    let operation_cancelled = cancelled.clone();
    tokio::select! {
        biased;
        _ = cancelled.changed() => Err(fail("evaluation cancelled")),
        result = tokio::time::timeout_at(deadline.into(), send(namespace, input, operation_cancelled, deadline)) =>
            result.unwrap_or_else(|_| Err(fail("evaluation timed out"))),
    }
}

fn active(cancelled: &watch::Receiver<bool>, deadline: Instant) -> Result<()> {
    if *cancelled.borrow() {
        return Err(fail("evaluation cancelled"));
    }
    if Instant::now() >= deadline {
        return Err(fail("evaluation timed out"));
    }
    Ok(())
}

struct Prepared {
    url: url::Url,
    model: String,
    headers: HeaderMap,
    body: Arc<Vec<u8>>,
    attested: bool,
    access_generation: String,
}

const SIGN_IN_REQUIRED: &str = "session expired or revoked; run jg emrank --login";

enum Preparation {
    Ready(Box<Prepared>),
    SignInRequired(&'static str),
}

async fn prepare(
    namespace: String,
    input: Arc<Input>,
    body: Option<Arc<Vec<u8>>>,
    cancelled: watch::Receiver<bool>,
    deadline: Instant,
) -> Result<Preparation> {
    tokio::task::spawn_blocking(move || {
        active(&cancelled, deadline)?;
        let _lock = storage::lock_while(|| active(&cancelled, deadline))?;
        active(&cancelled, deadline)?;
        let Some(mut session) = storage::load()? else {
            return Ok(Preparation::SignInRequired(SIGN_IN_REQUIRED));
        };
        if session.cache_namespace != namespace {
            return Err(fail("session changed; rerun the command"));
        }
        if session.config.model.is_empty() {
            return Err(fail(
                "choose an available model with jg emrank --model before querying",
            ));
        }
        let url = session.config.resource_endpoint()?;
        // Once sent, a refresh must finish saving its rotated token even if the
        // caller cancels. Cancellation is checked again before any inference.
        if let Err(error) = token::fresh(&mut session) {
            if session.refresh_pending {
                return Ok(Preparation::SignInRequired(token::UNKNOWN_REFRESH_OUTCOME));
            }
            if session.access_token.is_empty() {
                return Ok(Preparation::SignInRequired(SIGN_IN_REQUIRED));
            }
            return Err(error);
        }
        crate::activation::ensure(&mut session)?;
        active(&cancelled, deadline)?;
        let body = match body {
            Some(body) => body,
            None => Arc::new(serialize(&input, &session.config.model)?),
        };
        let proof = dpop::create(
            &session.key,
            "POST",
            url.as_str(),
            Some(&session.access_token),
            session.resource_nonce.as_deref(),
        )?;
        let mut authorization = HeaderValue::from_str(&format!("DPoP {}", session.access_token))
            .map_err(|_| fail("invalid stored access token"))?;
        authorization.set_sensitive(true);
        let mut proof_header =
            HeaderValue::from_str(&proof.encoded).map_err(|_| fail("invalid DPoP proof"))?;
        proof_header.set_sensitive(true);
        let mut headers = profile::headers(&session)?;
        headers.insert("authorization", authorization);
        headers.insert("dpop", proof_header);
        headers.insert("content-type", HeaderValue::from_static("application/json"));
        headers.insert("accept", HeaderValue::from_static("application/json"));
        if session.attested || profile::native_build() {
            integrity::sign(&mut headers, &session.key, url.as_str(), &body, &proof)?;
            // Persist a locally renewed same-key attestation for later calls.
            storage::save(&session)?;
        }
        Ok(Preparation::Ready(Box::new(Prepared {
            url,
            model: session.config.model.clone(),
            headers,
            body,
            attested: session.attested || profile::native_build(),
            access_generation: pkce::hash(&session.access_token),
        })))
    })
    .await
    .map_err(|_| fail("native evaluation preparation failed"))?
}

async fn save_nonce(namespace: String, nonce: String) -> Result<()> {
    tokio::task::spawn_blocking(move || {
        let _lock = storage::lock()?;
        let mut session = storage::load()?.ok_or_else(|| fail("run jg emrank --login"))?;
        if session.cache_namespace != namespace {
            return Err(fail("session changed; rerun the command"));
        }
        session.resource_nonce = Some(nonce);
        storage::save(&session)
    })
    .await
    .map_err(|_| fail("native nonce persistence failed"))?
}

fn response_nonce(headers: &HeaderMap) -> Result<Option<String>> {
    protocol::nonce(headers)
}

fn nonce_challenge(headers: &HeaderMap) -> bool {
    protocol::authenticate(headers, "use_dpop_nonce")
}

fn retry_after(headers: &HeaderMap) -> Option<String> {
    let mut values = headers.get_all("retry-after").iter();
    let value = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        return None;
    }
    if value.len() > 64 {
        return None;
    }
    if let Ok(seconds) = value.parse::<u32>() {
        return Some(seconds.to_string());
    }
    httpdate::parse_http_date(value)
        .ok()
        .map(httpdate::fmt_http_date)
}

fn rejection(status: u16, retry_after: Option<String>) -> EvaluationResponse {
    let message = match status {
        401 => "EMRank authorization rejected; check the application's authorization status",
        403 => "EMRank request is not permitted for this account or application",
        429 => "EMRank gateway or upstream limit reached; retry later",
        _ => "EMRank request rejected",
    };
    EvaluationResponse {
        status: status.into(),
        body: json!({"error": {"message": message}}).to_string(),
        retry_after,
    }
}

// Only numeric answers and usage are released. Unknown strings, diagnostics,
// headers and response bodies may contain echoed credentials and stay native.
fn business_response(bytes: &[u8], input: &Input, model: &str) -> Result<String> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| fail("invalid evaluation response"))?;
    let answers = value
        .get("answers")
        .and_then(Value::as_object)
        .ok_or_else(|| fail("missing evaluation answers"))?;
    if answers.len() != input.questions.len() {
        return Err(fail("evaluation answer set mismatch"));
    }
    let mut safe = serde_json::Map::new();
    for id in input.questions.keys() {
        let answer = answers
            .get(id)
            .ok_or_else(|| fail("missing evaluation answer"))?;
        let probability = answer
            .get("noul")
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite() && (0.0..=1.0).contains(n))
            .ok_or_else(|| fail("invalid evaluation probability"))?;
        if answer.get("type").and_then(Value::as_str) != Some("noul") {
            return Err(fail("unexpected evaluation answer type"));
        }
        safe.insert(id.clone(), json!({"type": "noul", "noul": probability}));
    }
    let mut result = json!({"model": model, "answers": safe});
    if let Some(usage) = value.get("usage").filter(|v| !v.is_null()) {
        if !usage.is_object() {
            return Err(fail("invalid evaluation usage"));
        }
        let mut counts = serde_json::Map::new();
        for name in ["input_tokens", "output_tokens"] {
            if let Some(count) = usage.get(name).filter(|v| !v.is_null()) {
                let count = count
                    .as_u64()
                    .filter(|n| *n <= 9_007_199_254_740_991)
                    .ok_or_else(|| fail("invalid evaluation usage"))?;
                counts.insert(name.into(), json!(count));
            }
        }
        result["usage"] = json!(counts);
    }
    Ok(result.to_string())
}

async fn send(
    namespace: String,
    input: Input,
    cancelled: watch::Receiver<bool>,
    deadline: Instant,
) -> Result<EvaluationResponse> {
    let client = transport::resource_client()?;
    let input = Arc::new(input);
    let mut body = None;
    let mut retried_nonce = false;
    let mut recovered = false;
    for _ in 0..3 {
        let prepared = match prepare(
            namespace.clone(),
            input.clone(),
            body.clone(),
            cancelled.clone(),
            deadline,
        )
        .await?
        {
            Preparation::Ready(prepared) => *prepared,
            Preparation::SignInRequired(message) => {
                return Ok(EvaluationResponse {
                    status: 401,
                    body: json!({"error":{"message":message}}).to_string(),
                    retry_after: None,
                });
            }
        };
        body = Some(prepared.body.clone());
        active(&cancelled, deadline)?;
        let mut response = client
            .post(prepared.url)
            .headers(prepared.headers)
            .body(prepared.body.as_ref().clone())
            .send()
            .await
            .map_err(|_| fail("evaluation HTTPS request failed"))?;
        let status = response.status().as_u16();
        let nonce = response_nonce(response.headers())?;
        let challenged = status == 401 && nonce_challenge(response.headers());
        if let Some(nonce) = nonce.as_ref() {
            save_nonce(namespace.clone(), nonce.clone()).await?;
        }
        if (300..400).contains(&status) {
            return Err(fail("EMRank redirects are not allowed"));
        }
        if !(200..300).contains(&status) {
            let headers = response.headers().clone();
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| fail("cannot read gateway rejection"))?
            {
                if bytes.len().saturating_add(chunk.len()) > 65536 {
                    return Err(fail("gateway rejection exceeds 64 KiB"));
                }
                bytes.extend_from_slice(&chunk);
            }
            let error = protocol::parse(&bytes);
            if !retried_nonce
                && challenged
                && nonce.is_some()
                && error.as_ref().is_some_and(|e| e.error == "use_dpop_nonce")
            {
                retried_nonce = true;
                continue;
            }
            let mut result = rejection(status, retry_after(&headers));
            let model_error = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|v| v.get("error")?.get("code")?.as_str().map(str::to_owned));
            if matches!(
                (status, model_error.as_deref()),
                (403, Some("model_not_allowed")) | (404, Some("model_not_found"))
            ) {
                result.body = json!({"error":{"message":"selected model is no longer available to this application; run jg emrank --model"}}).to_string();
            }
            if prepared.attested
                && let Some(controlled) = error.as_ref().and_then(|e| {
                    protocol::classify(status, e, protocol::Request::Resource, &headers)
                })
            {
                result.body = json!({"error":{"message":controlled.message}}).to_string();
                let can_recover = !recovered
                    && matches!(
                        controlled.action,
                        protocol::Action::Activate | protocol::Action::Refresh
                    );
                if controlled.action != protocol::Action::Keep {
                    let namespace = namespace.clone();
                    tokio::task::spawn_blocking(move || -> Result<()> {
                        let _lock = storage::lock()?;
                        if let Some(mut session) = storage::load()?
                            && session.cache_namespace == namespace
                        {
                            // An older in-flight request must not invalidate a newly rotated access token.
                            if controlled.action != protocol::Action::Refresh
                                || pkce::hash(&session.access_token) == prepared.access_generation
                            {
                                token::apply_rejection(&mut session, &controlled)?;
                            }
                        }
                        Ok(())
                    })
                    .await
                    .map_err(|_| fail("cannot save gateway rejection state"))??;
                }
                if can_recover {
                    recovered = true;
                    continue;
                }
            }
            return Ok(result);
        }
        let json_type = response
            .headers()
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.split(';').next())
            .is_some_and(|h| h.trim().eq_ignore_ascii_case("application/json"));
        if status != 200 || !json_type || response.headers().contains_key("content-encoding") {
            return Err(fail("unsupported evaluation response format"));
        }
        if response
            .content_length()
            .is_some_and(|n| n > MAX_RESPONSE as u64)
        {
            return Err(fail("evaluation response exceeds 1 MiB"));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| fail("cannot read evaluation response"))?
        {
            if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE {
                return Err(fail("evaluation response exceeds 1 MiB"));
            }
            bytes.extend_from_slice(&chunk);
        }
        return Ok(EvaluationResponse {
            status: status.into(),
            body: business_response(&bytes, &input, &prepared.model)?,
            retry_after: None,
        });
    }
    Err(fail("resource nonce challenge failed"))
}

#[cfg(test)]
#[path = "interop.rs"]
mod interop;

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> Input {
        validate(EvaluationInput {
            state_json: "{\"source\":\"test\"}".into(),
            questions: vec![EvaluationQuestion {
                id: "q0".into(),
                instructions: "Relevant?".into(),
            }],
        })
        .unwrap()
    }
    #[test]
    fn response_is_reconstructed_without_server_strings() {
        let bytes = br#"{"model":"leaked-token","answers":{"q0":{"type":"noul","noul":0.5,"debug":"proof"}},"usage":{"input_tokens":3,"secret":"private"},"debug":"token"}"#;
        assert_eq!(
            serde_json::from_str::<Value>(
                &business_response(bytes, &input(), "chosen-model").unwrap()
            )
            .unwrap(),
            json!({"model":"chosen-model","answers":{"q0":{"type":"noul","noul":0.5}},"usage":{"input_tokens":3}})
        );
        for bytes in [
            br#"{"answers":{"q0":{"type":"noul","noul":2}}}"#.as_slice(),
            br#"{"answers":{}}"#,
            br#"{"answers":{"q0":{"type":"noul","noul":0.5}},"usage":{"input_tokens":-1}}"#,
        ] {
            assert!(business_response(bytes, &input(), "model").is_err());
        }
    }
    #[test]
    fn nonce_error_description_is_not_a_challenge() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "www-authenticate",
            HeaderValue::from_static("Bearer error=\"use_dpop_nonce\""),
        );
        assert!(!nonce_challenge(&headers));
        headers.insert(
            "www-authenticate",
            HeaderValue::from_static("DPoP error_description=\"use_dpop_nonce\""),
        );
        assert!(!nonce_challenge(&headers));
        headers.insert(
            "www-authenticate",
            HeaderValue::from_static("DPoP error=\"use_dpop_nonce\""),
        );
        assert!(nonce_challenge(&headers));
    }
}
