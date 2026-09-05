use napi::{
    bindgen_prelude::{ArrayBuffer, Null, ToNapiValue},
    Env, Error, JsString, Result, Unknown, ValueType,
};
use rusqlite::types::Value;

macro_rules! err_wrapper {
    ($exp: expr) => {
        $exp.map_err(|err| Error::from(err))?
    };
    (safe, $exp: expr) => {
        unsafe { err_wrapper!($exp) }
    };
}

pub fn js_to_rusqlite_value(val: Unknown) -> Result<Value> {
    let t = err_wrapper!(val.get_type());
    if t == ValueType::Null || t == ValueType::Undefined {
        return Ok(Value::Null);
    }
    if t == ValueType::String {
        return Ok(Value::Text(err_wrapper!(safe, val.cast())));
    }
    if t == ValueType::Number {
        let n: f64 = err_wrapper!(safe, val.cast());
        if n == (n as i64) as f64 && n.is_finite() {
            return Ok(Value::Integer(n as i64));
        }
        return Ok(Value::Real(n));
    }
    if t == ValueType::Boolean {
        return Ok(Value::Integer(if err_wrapper!(safe, val.cast()) {
            1
        } else {
            0
        }));
    }
    Ok(Value::Null)
}

pub fn value_to_js_string<'a>(env: &'a Env, val: &Value) -> Result<JsString<'a>> {
    match val {
        Value::Null => env.create_string(""),
        Value::Integer(i) => env.create_string(i.to_string()),
        Value::Real(f) => env.create_string(f.to_string()),
        Value::Text(t) => env.create_string(t),
        Value::Blob(b) => env.create_string(format!("{:?}", b)),
    }
}

pub fn value_to_js_value<'a>(env: &'a Env, val: &Value) -> Result<Unknown<'a>> {
    match val {
        Value::Null => Null.into_unknown(env),
        Value::Integer(i) => env.create_int64(*i).and_then(|x| x.into_unknown(env)),
        Value::Real(f) => f.into_unknown(env),
        Value::Text(t) => env.create_string(t).and_then(|x| x.into_unknown(env)),
        Value::Blob(b) => ArrayBuffer::from_data(env, b.clone()).and_then(|x| x.into_unknown(env)),
    }
}
