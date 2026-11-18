//! Trusted operation definitions mirrored from the gateway's registered jg policy.
//! No caller supplies instructions, security markers, models or destinations.
use crate::error::{Result, fail};
use serde_json::{Map, Value, json};
use std::{collections::BTreeMap, sync::LazyLock};

static POLICY: LazyLock<Vec<Value>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../policies/jevgrep.json")).expect("built-in jg policy")
});
fn invalid() -> String {
    fail("input does not match the registered jg operation")
}

// Only the object/array/scalar shapes used in this fixed, local policy. No
// remote refs, custom schemas or arbitrary instructions are accepted at runtime.
fn shape(schema: &Value, v: &Value) -> bool {
    if let Some(c) = schema.get("const") {
        return v == c;
    }
    if let Some(choices) = schema["enum"].as_array() {
        return choices.contains(v);
    }
    match schema["type"].as_str() {
        Some("string") => v.is_string(),
        Some("boolean") => v.is_boolean(),
        Some("integer") => v
            .as_i64()
            .is_some_and(|n| n >= schema["minimum"].as_i64().unwrap_or(i64::MIN)),
        Some("array") => v.as_array().is_some_and(|a| {
            a.len() as u64 >= schema["minItems"].as_u64().unwrap_or(0)
                && a.len() as u64 <= schema["maxItems"].as_u64().unwrap_or(u64::MAX)
                && a.iter().all(|item| shape(&schema["items"], item))
        }),
        Some("object") => v.as_object().is_some_and(|obj| {
            schema["required"].as_array().is_none_or(|keys| {
                keys.iter()
                    .all(|k| k.as_str().is_some_and(|k| obj.contains_key(k)))
            }) && obj.iter().all(|(k, value)| {
                if let Some(s) = schema["properties"].get(k) {
                    shape(s, value)
                } else if schema["additionalProperties"].is_object() {
                    shape(&schema["additionalProperties"], value)
                } else {
                    schema["additionalProperties"] != false
                }
            })
        }),
        _ => false,
    }
}

pub(crate) fn build(operation: &str, input: &str) -> Result<super::resource::Input> {
    if input.len() > 13 * 1024 * 1024 {
        return Err(invalid());
    }
    let policy = POLICY
        .iter()
        .find(|p| p["id"] == operation)
        .ok_or_else(invalid)?;
    let mut state: Map<String, Value> = serde_json::from_str(input).map_err(|_| invalid())?;
    let schema = &policy["schema"]["properties"]["state"];
    for (name, spec) in schema["properties"].as_object().unwrap() {
        if let Some(fixed) = spec.get("const")
            && state.insert(name.clone(), fixed.clone()).is_some()
        {
            return Err(invalid());
        }
    }
    let state = Value::Object(state);
    if !shape(schema, &state) {
        return Err(invalid());
    }
    let mut questions = BTreeMap::new();
    if let Some(fixed) = policy.pointer("/schema/properties/questions/const") {
        questions = serde_json::from_value(fixed.clone()).map_err(|_| invalid())?;
    } else {
        let navigation = operation == "navigation";
        let items = state[if navigation { "items" } else { "declarations" }]
            .as_array()
            .ok_or_else(invalid)?;
        let rules = &policy["indexed_questions"]["rules"];
        for (i, item) in items.iter().enumerate() {
            if navigation {
                if item["id"] != format!("n{i}") {
                    return Err(invalid());
                }
                let branch =
                    if state.get("relationAnchor").is_some() && item.get("sourceRange").is_none() {
                        0
                    } else if item["kind"] == "directory" {
                        1
                    } else if item.get("sourceRange").is_some() {
                        2
                    } else {
                        3
                    };
                let template = rules["q"][branch]["instructions"].as_str().unwrap();
                questions.insert(
                    format!("q{i}"),
                    json!({"type":"noul","instructions":render(template,i,item)?}),
                );
            } else {
                for prefix in ["q", "scope", "ref"] {
                    if prefix == "ref" && state.get("selectedEvidence").is_none() {
                        continue;
                    }
                    let template = rules[prefix][0]["instructions"].as_str().unwrap();
                    questions.insert(
                        format!("{prefix}{i}"),
                        json!({"type":"noul","instructions":render(template,i,item)?}),
                    );
                }
            }
        }
    }
    if questions.is_empty() || questions.len() > 256 {
        return Err(invalid());
    }
    Ok(super::resource::Input { state, questions })
}

// Substitute only markers in the template, never interpret a path/name as a second template.
fn render(mut template: &str, index: usize, item: &Value) -> Result<String> {
    let mut out = String::new();
    while let Some((prefix, tail)) = template.split_once("{{") {
        out.push_str(prefix);
        let (key, rest) = tail.split_once("}}").ok_or_else(invalid)?;
        if key == "index" {
            out.push_str(&index.to_string());
        } else if let Some(path) = key.strip_prefix("json:") {
            out.push_str(&item.pointer(path).ok_or_else(invalid)?.to_string());
        } else {
            let field = item.pointer(key).ok_or_else(invalid)?;
            match field {
                Value::String(s) => out.push_str(s),
                Value::Number(n) => out.push_str(&n.to_string()),
                _ => return Err(invalid()),
            }
        }
        template = rest;
    }
    out.push_str(template);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_inputs_and_unicode() {
        assert!(build("doctor", r#"{"source":"any"}"#).is_err());
        assert_eq!(
            build("doctor", "{}").unwrap().state["_emrank"],
            "jg\u{2063}v1"
        );
        let mut state = json!({"query":"q","path":"a","source":"source","declarations":[{"name":"λ{{index}}","startLine":1,"endLine":1}]});
        let first = build("evidence", &state.to_string()).unwrap();
        assert_eq!(first.questions.len(), 2);
        assert!(
            first.questions["q0"]["instructions"]
                .as_str()
                .unwrap()
                .contains("λ{{index}}")
        );
        state["selectedEvidence"] = json!([]);
        assert_eq!(
            build("evidence", &state.to_string())
                .unwrap()
                .questions
                .len(),
            3
        );
        state["destination"] = json!("elsewhere");
        assert!(build("evidence", &state.to_string()).is_err());
    }
}
