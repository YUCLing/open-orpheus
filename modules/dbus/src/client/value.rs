//! Conversion between D-Bus values and the plain JS values exposed through
//! napi.
//!
//! Outgoing arguments are described by the call's D-Bus signature string (the
//! caller knows what it is calling); incoming values are self-describing —
//! `zvariant::Value` carries its own type — so decoding needs no signature.
//! `serde_json::Value` is the JS-facing representation throughout: napi
//! converts it to and from arbitrary JS values.
//!
//! # Value rules
//!
//! | signature    | JS value                                          |
//! |--------------|---------------------------------------------------|
//! | `y n q i u`  | number                                            |
//! | `x t`        | number, or bigint outside the ±2^53 safe range    |
//! | `d`          | number                                            |
//! | `b`          | boolean                                           |
//! | `s o g`      | string                                            |
//! | `v`          | `{ signature, value }`                            |
//! | `aX`         | array (`ay` is a `number[]`)                      |
//! | `a{KV}`      | object when `K` is `s`/`o`/`g`, else `[[k, v], …]` |
//! | `(…)`        | array with one element per field                  |
//! | `h`          | `null` when decoded, rejected when encoded        |
//!
//! The bigint half of the `x t` rule depends on napi's `napi6` feature, which
//! this crate enables in `Cargo.toml`. Without it napi rounds signed values
//! beyond ±2^53 and turns unsigned values above `i64::MAX` into strings, which
//! would silently violate the table above.
//!
//! # Encoding limits
//!
//! On the way in, napi represents a JS bigint wider than `i64` as a string, so
//! a `t` argument passed as a bigint above `2^63 - 1` is rejected by
//! [`encode_args`] instead of being truncated. Values that fit in `i64` —
//! including every wall-clock timestamp in microseconds — are unaffected.

use serde_json::{Map, Number, Value as Json};
use zbus::zvariant::{Array, Dict, ObjectPath, Signature, Structure, StructureBuilder, Value};

/// Split a D-Bus signature into the signatures of its top-level arguments.
///
/// `zvariant::Signature::from_str` deliberately flattens a top-level structure
/// onto the same value as the concatenation of its fields (`"(is)"` and `"is"`
/// parse identically), which would make a single struct argument
/// indistinguishable from two arguments. Splitting the string itself keeps the
/// distinction, while the whole string is still validated by the parser first.
pub fn split_top_level(signature: &str) -> Result<Vec<&str>, String> {
    // Validate the whole signature (including the empty one, which is `Unit`)
    // so the scan below only has to track nesting.
    Signature::try_from(signature)
        .map_err(|e| format!("invalid D-Bus signature {signature:?}: {e}"))?;

    let mut args = Vec::new();
    let mut start = 0;
    let mut depth = 0usize;

    for (index, byte) in signature.bytes().enumerate() {
        match byte {
            b'(' | b'{' => depth += 1,
            b')' | b'}' => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| format!("invalid D-Bus signature {signature:?}"))?;
                if depth == 0 {
                    args.push(&signature[start..=index]);
                    start = index + 1;
                }
            }
            // `a` is only ever a prefix of its element type, so it never ends
            // an argument on its own: either the element type is a basic type
            // (handled below) or one of the groups above closes.
            b'a' => {}
            // A basic type outside any group ends the argument on its own.
            _ if depth == 0 => {
                args.push(&signature[start..=index]);
                start = index + 1;
            }
            _ => {}
        }
    }

    if start != signature.len() {
        return Err(format!("invalid D-Bus signature {signature:?}"));
    }

    Ok(args)
}

/// Encode `body` according to `signature`.
///
/// Returns `None` when the call takes no arguments, in which case the message
/// body is the unit type rather than an empty structure.
pub fn encode_args(signature: &str, body: &[Json]) -> Result<Option<Structure<'static>>, String> {
    let args = split_top_level(signature)?;
    if args.len() != body.len() {
        return Err(format!(
            "signature {signature:?} expects {} argument(s), got {}",
            args.len(),
            body.len()
        ));
    }
    if args.is_empty() {
        return Ok(None);
    }

    let mut structure = StructureBuilder::new();
    for (index, (arg_signature, value)) in args.iter().zip(body).enumerate() {
        let argument = Signature::try_from(*arg_signature)
            .map_err(|e| format!("invalid D-Bus signature {arg_signature:?}: {e}"))?;
        structure = structure.append_field(json_to_value(&argument, value, index)?);
    }

    structure
        .build()
        .map(Some)
        .map_err(|e| format!("failed to encode arguments: {e}"))
}

/// Convert a decoded D-Bus value to its JS representation.
pub fn value_to_json(value: &Value<'_>) -> Result<Json, String> {
    Ok(match value {
        Value::U8(v) => Json::Number(Number::from(*v)),
        Value::Bool(v) => Json::Bool(*v),
        Value::I16(v) => Json::Number(Number::from(*v)),
        Value::U16(v) => Json::Number(Number::from(*v)),
        Value::I32(v) => Json::Number(Number::from(*v)),
        Value::U32(v) => Json::Number(Number::from(*v)),
        Value::I64(v) => Json::Number(Number::from(*v)),
        Value::U64(v) => Json::Number(Number::from(*v)),
        Value::F64(v) => match Number::from_f64(*v) {
            Some(number) => Json::Number(number),
            None => return Err(format!("cannot represent the float {v} in JS")),
        },
        Value::Str(v) => Json::String(v.as_str().to_owned()),
        Value::Signature(v) => Json::String(v.to_string()),
        Value::ObjectPath(v) => Json::String(v.as_str().to_owned()),
        // A variant is the only value that has to describe itself: every other
        // type's shape is implied by the signature it was decoded with.
        Value::Value(inner) => {
            let mut variant = Map::new();
            variant.insert(
                "signature".to_string(),
                Json::String(inner.value_signature().to_string()),
            );
            variant.insert("value".to_string(), value_to_json(inner)?);
            Json::Object(variant)
        }
        Value::Array(array) => Json::Array(
            array
                .iter()
                .map(value_to_json)
                .collect::<Result<Vec<_>, _>>()?,
        ),
        Value::Dict(dict) => dict_to_json(dict)?,
        Value::Structure(structure) => Json::Array(
            structure
                .fields()
                .iter()
                .map(value_to_json)
                .collect::<Result<Vec<_>, _>>()?,
        ),
        // Real services do return file descriptors (e.g. `GetConnectionCredentials`
        // carries one as `ProcessFD`). They cannot cross the napi boundary, so
        // they are dropped rather than failing the whole reply.
        #[cfg(unix)]
        Value::Fd(_) => Json::Null,
        // Only reachable when a dependency enables zvariant's `gvariant`
        // feature, which adds the `Maybe` variant this crate cannot represent.
        #[allow(unreachable_patterns)]
        _ => {
            return Err(format!(
                "D-Bus value of type {:?} cannot be represented in JS",
                value.value_signature()
            ))
        }
    })
}

/// Turn a decoded body into its per-argument JS values.
pub fn structure_to_json(structure: &Structure<'_>) -> Result<Vec<Json>, String> {
    structure.fields().iter().map(value_to_json).collect()
}

fn dict_to_json(dict: &Dict<'_, '_>) -> Result<Json, String> {
    if dict_has_string_keys(dict) {
        let mut object = Map::new();
        for (key, value) in dict.iter() {
            // `o` and `g` keys are admitted by `dict_has_string_keys` too, but
            // decode to their own variants rather than `Value::Str`; all three
            // have an unambiguous string form to use as the JS object key.
            let key = match key {
                Value::Str(key) => key.as_str().to_owned(),
                Value::ObjectPath(key) => key.as_str().to_owned(),
                Value::Signature(key) => key.to_string(),
                _ => return Err("dictionary key is not a string".to_string()),
            };
            object.insert(key, value_to_json(value)?);
        }
        Ok(Json::Object(object))
    } else {
        // JS objects cannot express non-string keys without ambiguity, so
        // non-string-keyed dictionaries come back as `[key, value]` pairs.
        Ok(Json::Array(
            dict.iter()
                .map(|(key, value)| {
                    Ok(Json::Array(vec![
                        value_to_json(key)?,
                        value_to_json(value)?,
                    ]))
                })
                .collect::<Result<Vec<_>, String>>()?,
        ))
    }
}

fn dict_has_string_keys(dict: &Dict<'_, '_>) -> bool {
    match dict.signature() {
        Signature::Dict { key, .. } => {
            matches!(
                &**key,
                Signature::Str | Signature::ObjectPath | Signature::Signature
            )
        }
        _ => false,
    }
}

fn json_to_value(
    signature: &Signature,
    json: &Json,
    index: usize,
) -> Result<Value<'static>, String> {
    Ok(match signature {
        Signature::U8 => Value::from(range_u64(json, signature, index, u8::MAX as u64)? as u8),
        Signature::Bool => match json.as_bool() {
            Some(value) => Value::Bool(value),
            None => return Err(type_error(signature, index)),
        },
        Signature::I16 => {
            Value::from(range_i64(json, signature, index, i16::MIN as i64, i16::MAX as i64)? as i16)
        }
        Signature::U16 => Value::from(range_u64(json, signature, index, u16::MAX as u64)? as u16),
        Signature::I32 => {
            Value::from(range_i64(json, signature, index, i32::MIN as i64, i32::MAX as i64)? as i32)
        }
        Signature::U32 => Value::from(range_u64(json, signature, index, u32::MAX as u64)? as u32),
        Signature::I64 => Value::I64(expect_i64(json, signature, index)?),
        Signature::U64 => Value::U64(expect_u64(json, signature, index)?),
        Signature::F64 => match json.as_f64() {
            Some(value) => Value::F64(value),
            None => return Err(type_error(signature, index)),
        },
        Signature::Str => Value::from(expect_string(json, signature, index)?.to_owned()),
        Signature::Signature => Value::Signature(
            Signature::try_from(expect_string(json, signature, index)?)
                .map_err(|e| format!("argument {index}: invalid signature: {e}"))?,
        ),
        Signature::ObjectPath => Value::from(
            ObjectPath::try_from(expect_string(json, signature, index)?.to_owned())
                .map_err(|e| format!("argument {index}: invalid object path: {e}"))?,
        ),
        Signature::Variant => {
            let (inner_signature, inner) = expect_variant(json, index)?;
            Value::Value(Box::new(json_to_value(&inner_signature, inner, index)?))
        }
        Signature::Array(element) => {
            let elements = json
                .as_array()
                .ok_or_else(|| type_error(signature, index))?;
            let mut array = Array::new(element);
            for item in elements {
                array
                    .append(json_to_value(element, item, index)?)
                    .map_err(|e| format!("argument {index}: {e}"))?;
            }
            Value::Array(array)
        }
        Signature::Dict { key, value } => {
            let mut dict = Dict::new(key, value);
            if let Some(object) = json.as_object() {
                if !matches!(
                    &**key,
                    Signature::Str | Signature::ObjectPath | Signature::Signature
                ) {
                    return Err(format!(
                        "argument {index}: a dictionary keyed by {key:?} must be given as \
                         [key, value] pairs"
                    ));
                }
                for (object_key, object_value) in object {
                    let key = json_to_value(key, &Json::String(object_key.clone()), index)?;
                    let value = json_to_value(value, object_value, index)?;
                    dict.append(key, value)
                        .map_err(|e| format!("argument {index}: {e}"))?;
                }
            } else if let Some(pairs) = json.as_array() {
                for pair in pairs {
                    let pair = pair
                        .as_array()
                        .filter(|pair| pair.len() == 2)
                        .ok_or_else(|| {
                            format!("argument {index}: expected a [key, value] pair, got {pair}")
                        })?;
                    let key = json_to_value(key, &pair[0], index)?;
                    let value = json_to_value(value, &pair[1], index)?;
                    dict.append(key, value)
                        .map_err(|e| format!("argument {index}: {e}"))?;
                }
            } else {
                return Err(format!(
                    "argument {index}: expected a dictionary ({signature})"
                ));
            }
            Value::Dict(dict)
        }
        Signature::Structure(fields) => {
            let values = json
                .as_array()
                .ok_or_else(|| type_error(signature, index))?;
            if values.len() != fields.len() {
                return Err(format!(
                    "argument {index}: expected a {}-field structure ({signature}), got {} field(s)",
                    fields.len(),
                    values.len()
                ));
            }
            let mut structure = StructureBuilder::new();
            for (field, value) in fields.iter().zip(values) {
                structure = structure.append_field(json_to_value(field, value, index)?);
            }
            Value::Structure(
                structure
                    .build()
                    .map_err(|e| format!("argument {index}: {e}"))?,
            )
        }
        Signature::Unit => {
            return Err(format!(
                "argument {index}: an empty signature cannot carry a value"
            ))
        }
        // File descriptors have no JS representation, and `Maybe` only exists
        // when a dependency enables zvariant's `gvariant` feature.
        #[allow(unreachable_patterns)]
        _ => {
            return Err(format!(
                "argument {index}: D-Bus type {signature} is not supported from JS \
                 (unix file descriptors cannot cross the napi boundary)"
            ))
        }
    })
}

/// Name the offending argument and its expected signature.
fn type_error(signature: &Signature, index: usize) -> String {
    format!("argument {index}: expected a value of D-Bus type {signature}")
}

fn expect_string<'a>(
    json: &'a Json,
    signature: &Signature,
    index: usize,
) -> Result<&'a str, String> {
    json.as_str().ok_or_else(|| type_error(signature, index))
}

fn expect_i64(json: &Json, signature: &Signature, index: usize) -> Result<i64, String> {
    if let Some(value) = json.as_i64() {
        return Ok(value);
    }
    if let Some(value) = json.as_f64() {
        // `i64::MAX as f64` rounds up to 2^63, so it is an exclusive bound:
        // 2^63 is not representable as an `i64` and casting it would saturate
        // to `i64::MAX` while accepting a value the caller never passed.
        if value.fract() == 0.0 && value >= i64::MIN as f64 && value < i64::MAX as f64 {
            return Ok(value as i64);
        }
        return Err(format!(
            "argument {index}: {value} is out of range for type {signature}"
        ));
    }
    Err(type_error(signature, index))
}

fn expect_u64(json: &Json, signature: &Signature, index: usize) -> Result<u64, String> {
    if let Some(value) = json.as_u64() {
        return Ok(value);
    }
    if let Some(value) = json.as_f64() {
        // As above, `u64::MAX as f64` is 2^64, so the upper bound is
        // exclusive: casting 2^64 would saturate to `u64::MAX`.
        if value.fract() == 0.0 && value >= 0.0 && value < u64::MAX as f64 {
            return Ok(value as u64);
        }
        return Err(format!(
            "argument {index}: {value} is out of range for type {signature}"
        ));
    }
    Err(type_error(signature, index))
}

fn range_i64(
    json: &Json,
    signature: &Signature,
    index: usize,
    min: i64,
    max: i64,
) -> Result<i64, String> {
    json.as_i64()
        .filter(|value| (min..=max).contains(value))
        .ok_or_else(|| {
            format!("argument {index}: expected a number in {min}..={max} for type {signature}")
        })
}

fn range_u64(json: &Json, signature: &Signature, index: usize, max: u64) -> Result<u64, String> {
    json.as_u64().filter(|value| *value <= max).ok_or_else(|| {
        format!("argument {index}: expected a number in 0..={max} for type {signature}")
    })
}

/// The signature of a `v` argument's inner value, plus that value.
fn expect_variant(json: &Json, index: usize) -> Result<(Signature, &Json), String> {
    let object = json.as_object().ok_or_else(|| {
        format!("argument {index}: expected a variant ({{ signature, value }}), got {json}")
    })?;
    let signature = object
        .get("signature")
        .and_then(Json::as_str)
        .ok_or_else(|| format!("argument {index}: a variant needs a \"signature\" string"))?;
    let signature = Signature::try_from(signature)
        .map_err(|e| format!("argument {index}: invalid variant signature: {e}"))?;
    let value = object
        .get("value")
        .ok_or_else(|| format!("argument {index}: a variant needs a \"value\""))?;
    Ok((signature, value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn splits_top_level_arguments() {
        assert!(split_top_level("").unwrap().is_empty());
        assert_eq!(split_top_level("is").unwrap(), ["i", "s"]);
        assert_eq!(split_top_level("a{sv}").unwrap(), ["a{sv}"]);
        assert_eq!(split_top_level("a{sv}as").unwrap(), ["a{sv}", "as"]);
        assert_eq!(split_top_level("ay").unwrap(), ["ay"]);
        assert_eq!(split_top_level("(is)").unwrap(), ["(is)"]);
        assert_eq!(split_top_level("(is)u").unwrap(), ["(is)", "u"]);
        assert_eq!(split_top_level("a(is)").unwrap(), ["a(is)"]);
        assert_eq!(split_top_level("v").unwrap(), ["v"]);
    }

    #[test]
    fn rejects_invalid_signatures() {
        assert!(split_top_level("a{sv").is_err());
        assert!(split_top_level("z").is_err());
        assert!(split_top_level("(is").is_err());
    }

    #[test]
    fn encodes_no_arguments_as_unit() {
        assert!(encode_args("", &[]).unwrap().is_none());
    }

    #[test]
    fn rejects_argument_count_mismatches() {
        let error = encode_args("s", &[]).unwrap_err();
        assert!(error.contains("expects 1 argument(s), got 0"), "{error}");
        let error = encode_args("", &[json!("x")]).unwrap_err();
        assert!(error.contains("expects 0 argument(s), got 1"), "{error}");
    }

    #[test]
    fn encodes_basic_types() {
        let structure = encode_args("sbi", &[json!("hi"), json!(true), json!(-3)])
            .unwrap()
            .unwrap();
        assert_eq!(structure.signature().to_string_no_parens(), "sbi");
        assert!(matches!(structure.fields()[0], Value::Str(_)));
        assert!(matches!(structure.fields()[1], Value::Bool(true)));
        assert!(matches!(structure.fields()[2], Value::I32(-3)));
    }

    #[test]
    fn encodes_64_bit_integers_beyond_the_safe_range() {
        let value = 9_007_199_254_740_993_i64;
        let structure = encode_args("x", &[json!(value)]).unwrap().unwrap();
        assert!(matches!(structure.fields()[0], Value::I64(v) if v == value));

        let value = u64::MAX;
        let structure = encode_args("t", &[json!(value)]).unwrap().unwrap();
        assert!(matches!(structure.fields()[0], Value::U64(v) if v == value));
    }

    #[test]
    fn rejects_out_of_range_and_mistyped_values() {
        assert!(encode_args("y", &[json!(256)])
            .unwrap_err()
            .contains("0..=255"));
        assert!(encode_args("y", &[json!(-1)])
            .unwrap_err()
            .contains("0..=255"));
        assert!(encode_args("s", &[json!(1)])
            .unwrap_err()
            .contains("argument 0"));
        assert!(encode_args("d", &[json!("x")])
            .unwrap_err()
            .contains("argument 0"));
        assert!(encode_args("b", &[json!(1)])
            .unwrap_err()
            .contains("argument 0"));
    }

    #[test]
    fn rejects_float_values_that_round_to_the_integer_bounds() {
        // 2^63 is exactly representable as an f64 but is one past `i64::MAX`,
        // and `u64::MAX as f64` is 2^64. Both would saturate if accepted.
        for (signature, value) in [
            ("x", 9_223_372_036_854_775_808.0_f64),
            ("t", 18_446_744_073_709_551_616.0_f64),
        ] {
            let error = encode_args(signature, &[json!(value)]).unwrap_err();
            assert!(error.contains("out of range"), "{signature}: {error}");
        }

        // The largest representable values below each bound still encode
        // exactly, as does the most negative `i64`.
        let structure = encode_args("x", &[json!(-9_223_372_036_854_775_808.0_f64)])
            .unwrap()
            .unwrap();
        assert!(matches!(structure.fields()[0], Value::I64(i64::MIN)));

        let structure = encode_args("x", &[json!(9_223_372_036_854_774_784.0_f64)])
            .unwrap()
            .unwrap();
        assert!(matches!(structure.fields()[0], Value::I64(v) if v == 9_223_372_036_854_774_784));

        let structure = encode_args("t", &[json!(18_446_744_073_709_549_568.0_f64)])
            .unwrap()
            .unwrap();
        assert!(matches!(structure.fields()[0], Value::U64(v) if v == 18_446_744_073_709_549_568));
    }

    #[test]
    fn encodes_structs_and_distinguishes_them_from_argument_lists() {
        let structure = encode_args("(is)", &[json!([7, "x"])]).unwrap().unwrap();
        assert_eq!(structure.signature().to_string_no_parens(), "(is)");
        assert_eq!(structure.fields().len(), 1);
        assert!(matches!(&structure.fields()[0], Value::Structure(_)));

        let structure = encode_args("is", &[json!(7), json!("x")]).unwrap().unwrap();
        assert_eq!(structure.signature().to_string_no_parens(), "is");
        assert_eq!(structure.fields().len(), 2);
    }

    #[test]
    fn encodes_dicts_and_variants() {
        let structure = encode_args(
            "a{sv}",
            &[json!({ "length": { "signature": "x", "value": 1_000_000 } })],
        )
        .unwrap()
        .unwrap();
        let Value::Dict(dict) = &structure.fields()[0] else {
            panic!("expected a dictionary, got {:?}", structure.fields()[0]);
        };
        assert!(dict_has_string_keys(dict));
        let (_, value) = dict.iter().next().unwrap();
        assert!(matches!(value, Value::Value(inner) if inner.value_signature() == &Signature::I64));
    }

    #[test]
    fn encodes_non_string_keyed_dicts_from_pairs() {
        let structure = encode_args("a{iv}", &[json!([[1, { "signature": "s", "value": "x" }]])])
            .unwrap()
            .unwrap();
        let Value::Dict(dict) = &structure.fields()[0] else {
            panic!("expected a dictionary");
        };
        assert!(!dict_has_string_keys(dict));
        assert_eq!(dict.iter().count(), 1);

        // The object form cannot express a non-string key, so it is rejected
        // rather than silently coerced.
        let error = encode_args(
            "a{iv}",
            &[json!({ "1": { "signature": "s", "value": "x" } })],
        )
        .unwrap_err();
        assert!(error.contains("[key, value] pairs"), "{error}");
    }

    #[test]
    fn requires_a_signature_for_variants() {
        let error = encode_args("v", &[json!({ "value": 1 })]).unwrap_err();
        assert!(error.contains("\"signature\""), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_file_descriptors() {
        // `h` is only a valid signature on unix, where the fd type exists.
        assert!(split_top_level("h").is_ok());
        let error = encode_args("h", &[json!(0)]).unwrap_err();
        assert!(error.contains("not supported"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn decodes_file_descriptors_as_null() {
        // Real replies may carry a handle (e.g. `GetConnectionCredentials`
        // includes `ProcessFD`); it has no JS representation.
        let file = std::fs::File::open("/dev/null").unwrap();
        let fd = zbus::zvariant::Fd::from(std::os::fd::OwnedFd::from(file));
        assert_eq!(value_to_json(&Value::Fd(fd)).unwrap(), Json::Null);
    }

    #[test]
    fn decodes_basic_types() {
        assert_eq!(value_to_json(&Value::from(7u8)).unwrap(), json!(7));
        assert_eq!(value_to_json(&Value::Bool(true)).unwrap(), json!(true));
        assert_eq!(value_to_json(&Value::from(-3i64)).unwrap(), json!(-3));
        assert_eq!(value_to_json(&Value::from(1.5f64)).unwrap(), json!(1.5));
        assert_eq!(value_to_json(&Value::from("hi")).unwrap(), json!("hi"));
    }

    #[test]
    fn decodes_variants_self_describingly() {
        let value = Value::Value(Box::new(Value::from("hi")));
        assert_eq!(
            value_to_json(&value).unwrap(),
            json!({ "signature": "s", "value": "hi" })
        );
    }

    #[test]
    fn decodes_dicts() {
        let mut dict = Dict::new(&Signature::Str, &Signature::Variant);
        dict.append(
            Value::from("track"),
            Value::Value(Box::new(Value::from("hello"))),
        )
        .unwrap();
        assert_eq!(
            value_to_json(&Value::Dict(dict)).unwrap(),
            json!({ "track": { "signature": "s", "value": "hello" } })
        );

        let mut dict = Dict::new(&Signature::I32, &Signature::Str);
        dict.append(Value::from(1i32), Value::from("one")).unwrap();
        assert_eq!(
            value_to_json(&Value::Dict(dict)).unwrap(),
            json!([[1, "one"]])
        );
    }

    #[test]
    fn decodes_object_path_and_signature_keyed_dicts_as_objects() {
        // `o` and `g` keys are string-like, so they decode as JS objects, but
        // the keys arrive as their own value variants rather than `Value::Str`.
        let mut dict = Dict::new(&Signature::ObjectPath, &Signature::Str);
        dict.append(
            Value::ObjectPath(ObjectPath::try_from("/a").unwrap()),
            Value::from("x"),
        )
        .unwrap();
        assert_eq!(
            value_to_json(&Value::Dict(dict)).unwrap(),
            json!({ "/a": "x" })
        );

        let mut dict = Dict::new(&Signature::Signature, &Signature::Str);
        dict.append(
            Value::Signature(Signature::try_from("s").unwrap()),
            Value::from("x"),
        )
        .unwrap();
        assert_eq!(
            value_to_json(&Value::Dict(dict)).unwrap(),
            json!({ "s": "x" })
        );
    }

    #[test]
    fn decodes_structs_and_arrays() {
        let mut structure = StructureBuilder::new();
        structure = structure.append_field(Value::from(1i32));
        structure = structure.append_field(Value::from("x"));
        assert_eq!(
            value_to_json(&Value::Structure(structure.build().unwrap())).unwrap(),
            json!([1, "x"])
        );

        let mut array = Array::new(&Signature::Str);
        array.append(Value::from("a")).unwrap();
        assert_eq!(value_to_json(&Value::Array(array)).unwrap(), json!(["a"]));
    }

    #[test]
    fn round_trips_a_nested_argument_list() {
        let body = json!([
            "org.mpris.MediaPlayer2.Player",
            { "Volume": { "signature": "d", "value": 0.5 } },
            [["a", "b"], ["c", "d"]]
        ]);
        let structure = encode_args("sa{sv}a(ss)", body.as_array().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(structure.signature().to_string_no_parens(), "sa{sv}a(ss)");
        // Decoding this structure back yields the same JSON that was encoded,
        // which is what the reply path produces for an identical body.
        assert_eq!(Json::Array(structure_to_json(&structure).unwrap()), body);
    }
}
