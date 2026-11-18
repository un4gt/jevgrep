// Test-only adapter for the gateway's explicitly delivered offline executable.
// No N-API exports, network transport, production credentials or runtime clock
// override. Calls the same serializers and signers as the native resource path.
use super::*;
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use std::{
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, Command, Stdio},
};

struct Gateway {
    child: Child,
    output: BufReader<std::process::ChildStdout>,
}
impl Gateway {
    fn open(executable: &str) -> Self {
        let mut command = Command::new(executable);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        Self { child, output }
    }
    fn send(&mut self, request: &Value, records: &mut Vec<Value>) -> Value {
        let input = self.child.stdin.as_mut().unwrap();
        writeln!(input, "{request}").unwrap();
        input.flush().unwrap();
        let mut line = String::new();
        assert!(
            self.output.read_line(&mut line).unwrap() > 0,
            "gateway exited before replying"
        );
        let response: Value = serde_json::from_str(&line).unwrap();
        records.push(json!({"request":request,"outcome":response}));
        response
    }
}
impl Drop for Gateway {
    fn drop(&mut self) {
        self.child.stdin.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn wire(client: &str, now: u64, target: &str, headers: &HeaderMap, body: &[u8]) -> Value {
    let headers: Vec<_> = headers
        .iter()
        .map(|(k, v)| vec![k.as_str(), v.to_str().unwrap()])
        .collect();
    json!({"client_id":client,"now":now,"method":"POST","target":target,"headers":headers,"body_base64":STANDARD.encode(body)})
}

fn nonce(outcome: &Value) -> String {
    let value = outcome["response"]["headers"]["DPoP-Nonce"]
        .as_str()
        .unwrap();
    assert!(dpop::valid_nonce(value));
    assert_eq!(outcome["fixture_effect"], false);
    assert_eq!(outcome["response"]["body"]["error"], "use_dpop_nonce");
    value.into()
}

#[test]
#[ignore = "requires the delivered gateway offline executable and wire-v1 package; run explicitly"]
fn actual_native_wire_against_gateway() {
    let executable = std::env::var("EMRANK_OFFLINE_GATEWAY").unwrap();
    let package = std::env::var("EMRANK_WIRE_PACKAGE").unwrap();
    let report = std::env::var("EMRANK_INTEROP_REPORT").unwrap();
    let read = |file: &str| -> Value {
        serde_json::from_slice(&std::fs::read(Path::new(&package).join(file)).unwrap()).unwrap()
    };
    let config = read("configuration.json");
    let cases = read("cases.json");
    let now = config["now"].as_u64().unwrap();
    let issuer = config["issuer"].as_str().unwrap();
    let target = config["resource_endpoint"].as_str().unwrap();
    let metadata: profile::Metadata = serde_json::from_value(read("metadata.json")).unwrap();
    let mut records = Vec::new();
    for (index, case_name) in ["p1363-resource-valid", "second-registered-application"]
        .iter()
        .enumerate()
    {
        let registration = &config["clients"][index];
        let client = registration["client_id"].as_str().unwrap();
        let access = registration["token"].as_str().unwrap();
        let secret = URL_SAFE_NO_PAD.encode([3 + index as u8; 32]);
        assert_eq!(dpop::thumbprint(&secret).unwrap(), registration["jkt"]);
        assert!(
            metadata
                .validate(&crate::config::Config {
                    issuer: issuer.into(),
                    client_id: client.into(),
                    base_url: config["resource"].as_str().unwrap().into(),
                    model: "test/model".into()
                })
                .unwrap()
        );
        let case = cases["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == *case_name)
            .unwrap();
        let attestation = case["steps"][0]["request"]["headers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|h| {
                h[0].as_str()
                    .unwrap()
                    .eq_ignore_ascii_case("oauth-client-attestation")
            })
            .unwrap()[1]
            .as_str()
            .unwrap();
        let input = validate(EvaluationInput {
            state_json: r#"{"source":"native gateway interoperability fixture","query":"events"}"#
                .into(),
            questions: vec![EvaluationQuestion {
                id: "q0".into(),
                instructions: "Does this source describe events?".into(),
            }],
        })
        .unwrap();
        let body = serialize(&input, "test/model").unwrap();
        let mut gateway = Gateway::open(&executable);
        let mut rs_nonce = None;
        for attempt in 0..2 {
            let proof = dpop::fixture_proof(
                &secret,
                "POST",
                target,
                Some(access),
                rs_nonce.as_deref(),
                now,
            )
            .unwrap();
            let mut headers = HeaderMap::new();
            headers.insert(
                "authorization",
                HeaderValue::from_str(&format!("DPoP {access}")).unwrap(),
            );
            headers.insert(
                "oauth-client-attestation",
                HeaderValue::from_str(attestation).unwrap(),
            );
            headers.insert("dpop", HeaderValue::from_str(&proof.encoded).unwrap());
            headers.insert("content-type", HeaderValue::from_static("application/json"));
            integrity::sign(&mut headers, &secret, target, &body, &proof).unwrap();
            let request = wire(client, now, target, &headers, &body);
            let outcome = gateway.send(&request, &mut records);
            if attempt == 0 {
                assert_eq!(outcome["response"]["status"], 401);
                rs_nonce = Some(nonce(&outcome));
            } else {
                assert_eq!(
                    outcome["response"]["status"], 204,
                    "native resource signature rejected: {outcome}"
                );
                assert_eq!(outcome["fixture_effect"], true);
                let replay = gateway.send(&request, &mut records);
                assert_eq!(replay["response"]["status"], 401);
                assert_eq!(replay["response"]["body"]["emrank_reason"], "dpop_replayed");
                assert_eq!(replay["fixture_effect"], false);
            }
        }
        let par_target = format!("{issuer}/oauth/par");
        let par_body = profile::par_form(&[
            ("response_type", "code".into()),
            ("client_id", client.into()),
            ("redirect_uri", "http://127.0.0.1:49152/callback".into()),
            ("scope", "inference:systemone offline_access".into()),
            ("resource", config["resource"].as_str().unwrap().into()),
            ("state", pkce::random()),
            ("code_challenge", pkce::hash(&pkce::random())),
            ("code_challenge_method", "S256".into()),
            ("dpop_jkt", dpop::thumbprint(&secret).unwrap()),
        ])
        .unwrap();
        let mut as_nonce = None;
        for attempt in 0..2 {
            let proof =
                dpop::fixture_proof(&secret, "POST", &par_target, None, as_nonce.as_deref(), now)
                    .unwrap();
            let mut headers = HeaderMap::new();
            headers.insert(
                "oauth-client-attestation",
                HeaderValue::from_str(attestation).unwrap(),
            );
            headers.insert("dpop", HeaderValue::from_str(&proof.encoded).unwrap());
            headers.insert(
                "content-type",
                HeaderValue::from_static("application/x-www-form-urlencoded"),
            );
            let outcome = gateway.send(
                &wire(client, now, &par_target, &headers, par_body.as_bytes()),
                &mut records,
            );
            if attempt == 0 {
                assert_eq!(outcome["response"]["status"], 400);
                as_nonce = Some(nonce(&outcome));
            } else {
                assert_eq!(
                    outcome["response"]["status"], 201,
                    "native PAR rejected: {outcome}"
                );
                assert_eq!(outcome["response"]["body"]["expires_in"], 90);
                assert_eq!(outcome["fixture_effect"], true);
            }
        }
    }
    assert_eq!(records.len(), 10);
    std::fs::write(report, serde_json::to_vec_pretty(&json!({"fixture_only":true,"source":"native Rust serializers/DPoP/HTTP signature; offline HTTPS target; no network", "requests":records})).unwrap()).unwrap();
}
