use crate::{
    dpop,
    error::{Result, fail},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use p256::ecdsa::{Signature, signature::Signer};
use reqwest::header::{HeaderMap, HeaderValue};
use sha2::{Digest, Sha256};

fn fields(
    method: &str,
    target: &str,
    body: &[u8],
    proof: &dpop::Proof,
    jkt: &str,
) -> (String, String, String) {
    let digest = format!("sha-256=:{}:", STANDARD.encode(Sha256::digest(body)));
    let params = format!(
        "(\"@method\" \"@target-uri\" \"content-type\" \"content-digest\" \"dpop\");created={};expires={};nonce=\"{}\";alg=\"ecdsa-p256-sha256\";keyid=\"{}\";tag=\"oauth-resource-v1\"",
        proof.iat,
        proof.iat + 60,
        proof.jti,
        jkt
    );
    let base = format!(
        "\"@method\": {method}\n\"@target-uri\": {target}\n\"content-type\": application/json\n\"content-digest\": {digest}\n\"dpop\": {}\n\"@signature-params\": {params}",
        proof.encoded
    );
    (digest, format!("sig1={params}"), base)
}

// Internal only: caller freezes the business bytes before signing. The same
// native instance key signs DPoP and the RFC 9421 P1363 signature.
pub fn sign(
    headers: &mut HeaderMap,
    secret: &str,
    target: &str,
    body: &[u8],
    proof: &dpop::Proof,
) -> Result<()> {
    sign_method(headers, secret, "POST", target, body, proof)
}

pub fn sign_models(
    headers: &mut HeaderMap,
    secret: &str,
    target: &str,
    proof: &dpop::Proof,
) -> Result<()> {
    sign_method(headers, secret, "GET", target, b"", proof)
}

pub(crate) fn sign_method(
    headers: &mut HeaderMap,
    secret: &str,
    method: &str,
    target: &str,
    body: &[u8],
    proof: &dpop::Proof,
) -> Result<()> {
    let (digest, input, base) = fields(method, target, body, proof, &dpop::thumbprint(secret)?);
    let signature: Signature = dpop::signing_key(secret)?.sign(base.as_bytes());
    for (name, value) in [
        ("content-digest", digest),
        ("signature-input", input),
        (
            "signature",
            format!("sig1=:{}:", STANDARD.encode(signature.to_bytes())),
        ),
    ] {
        let mut value =
            HeaderValue::from_str(&value).map_err(|_| fail("cannot encode request signature"))?;
        value.set_sensitive(true);
        headers.insert(name, value);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use p256::ecdsa::{VerifyingKey, signature::Verifier};
    use serde_json::Value;

    #[test]
    fn frozen_gateway_node_vector_matches_canonical_bytes_and_p1363() {
        // Gateway fixture SHA-256 93e91907...e1, copied without regeneration.
        let v: Value =
            serde_json::from_str(include_str!("../fixtures/node-profile-v1.json")).unwrap();
        let s = |name: &str| v[name].as_str().unwrap();
        let proof = dpop::Proof {
            encoded: s("proof").into(),
            jti: "proof-fixture".into(),
            iat: v["now"].as_u64().unwrap(),
        };
        let (digest, input, base) =
            fields("POST", s("target"), s("body").as_bytes(), &proof, s("jkt"));
        assert_eq!(digest, s("content_digest"));
        assert_eq!(input, s("signature_input"));
        assert!(!base.ends_with('\n'));
        let mut point = vec![4];
        for name in ["x", "y"] {
            point.extend(
                URL_SAFE_NO_PAD
                    .decode(v["client_jwk"][name].as_str().unwrap())
                    .unwrap(),
            );
        }
        let key = VerifyingKey::from_sec1_bytes(&point).unwrap();
        let sig = STANDARD
            .decode(
                s("signature")
                    .strip_prefix("sig1=:")
                    .unwrap()
                    .strip_suffix(':')
                    .unwrap(),
            )
            .unwrap();
        assert_eq!(sig.len(), 64);
        key.verify(base.as_bytes(), &Signature::from_slice(&sig).unwrap())
            .unwrap();
        assert!(
            key.verify(
                format!("{base}\n").as_bytes(),
                &Signature::from_slice(&sig).unwrap()
            )
            .is_err()
        );
        let mut headers = HeaderMap::new();
        sign(
            &mut headers,
            &URL_SAFE_NO_PAD.encode([3u8; 32]),
            s("target"),
            s("body").as_bytes(),
            &proof,
        )
        .unwrap();
        assert_eq!(headers["signature-input"], input);
        let raw = headers["signature"].to_str().unwrap();
        let generated = STANDARD
            .decode(
                raw.strip_prefix("sig1=:")
                    .unwrap()
                    .strip_suffix(':')
                    .unwrap(),
            )
            .unwrap();
        key.verify(base.as_bytes(), &Signature::from_slice(&generated).unwrap())
            .unwrap();
        assert_ne!(
            fields("POST", s("target"), b"changed body", &proof, s("jkt")).0,
            digest
        );
    }
}
