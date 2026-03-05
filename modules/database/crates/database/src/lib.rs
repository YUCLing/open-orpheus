// Use #[neon::export] to export Rust functions as JavaScript functions.
// See more at: https://docs.rs/neon/latest/neon/attr.export.html

use std::time::Instant;

use neon::{
    handle::Handle,
    object::Object,
    prelude::{Context, Cx},
    result::{JsResult, ResultExt},
    types::{JsArray, JsNumber, JsObject, JsString, JsValue},
};
use rusqlite::{Batch, Connection, fallible_iterator::FallibleIterator};

#[neon::export]
fn create_connection<'cx>(cx: &mut Cx<'cx>, path: String) -> JsResult<'cx, JsNumber> {
    let Ok(conn) = Connection::open(path) else {
        let err_msg = JsString::new(cx, "Failed to create database connection");
        return cx.throw(err_msg);
    };
    let ptr = Box::into_raw(Box::new(conn));
    Ok(JsNumber::new(cx, ptr as usize as f64))
}

fn value_ref_to_js_string<'cx>(
    cx: &mut Cx<'cx>,
    val: rusqlite::types::ValueRef,
) -> Handle<'cx, JsString> {
    match val {
        rusqlite::types::ValueRef::Null => cx.string(""),
        rusqlite::types::ValueRef::Integer(i) => cx.string(i.to_string()),
        rusqlite::types::ValueRef::Real(f) => cx.string(f.to_string()),
        rusqlite::types::ValueRef::Text(t) => cx.string(std::str::from_utf8(t).unwrap()),
        rusqlite::types::ValueRef::Blob(b) => cx.string(format!("{:?}", b)),
    }
}

/// Execute SQL string, returns an array of objects representing rows,
/// and an array of performance info (total time, execution time, rows affected).
#[neon::export]
fn execute_sql<'cx>(cx: &mut Cx<'cx>, ptr: f64, sql: String) -> JsResult<'cx, JsArray> {
    let conn = unsafe { &mut *(ptr as usize as *mut Connection) };

    let t0 = Instant::now();

    let mut batch = Batch::new(&conn, &sql);
    let mut results = Vec::new();
    let prev_changes = conn.total_changes();

    let t1 = Instant::now();

    while let Ok(Some(mut stmt)) = batch.next() {
        let column_count = stmt.column_count();
        let mut column_names = Vec::with_capacity(column_count);
        for i in 0..column_count {
            let Ok(name) = stmt.column_name(i) else {
                let err_msg = cx.string(format!("Failed to get column name for index: {}", i));
                return cx.throw(err_msg);
            };
            column_names.push(name.to_string());
        }
        let Ok(mut rows) = stmt.query([]) else {
            let err_msg = cx.string(format!(
                "Failed to execute SQL statement: {:?}",
                stmt.expanded_sql()
            ));
            return cx.throw(err_msg);
        };
        while let Ok(Some(row)) = rows.next() {
            let row_obj = cx.empty_object();
            for i in 0..column_count {
                let val = row.get_ref(i).unwrap();
                let name = cx.string(&column_names[i]);
                let js_val = value_ref_to_js_string(cx, val);
                row_obj.prop(cx, name).set(js_val).unwrap();
            }
            results.push(row_obj);
        }
    }

    let t2 = Instant::now();

    let row_affected = conn.total_changes() - prev_changes;

    let result = cx.empty_array();
    result.prop(cx, 0).set(0).unwrap();

    let result_rows = cx.empty_array();
    if results.is_empty() {
        let val = cx.undefined();
        result.prop(cx, 1).set(val).unwrap();
    } else {
        for (i, row) in results.into_iter().enumerate() {
            result_rows.prop(cx, i as u32).set(row).unwrap();
        }
        result.prop(cx, 1).set(result_rows).unwrap();
    }

    let perf = cx.empty_array();
    perf.prop(cx, 0).set((t2 - t0).as_millis() as u32).unwrap();
    perf.prop(cx, 1).set((t1 - t0).as_millis() as u32).unwrap();
    perf.prop(cx, 2).set(row_affected as f64).unwrap();
    let result_len = result.len(cx);
    result.prop(cx, result_len).set(perf).unwrap();

    Ok(result)
}

#[neon::export]
fn execute_transaction<'cx>(cx: &mut Cx<'cx>, ptr: f64, sql: String) -> JsResult<'cx, JsArray> {
    let conn = unsafe { &mut *(ptr as usize as *mut Connection) };
    let Ok(tx) = conn.transaction() else {
        let err_msg = cx.string("Failed to start transaction");
        return cx.throw(err_msg);
    };
    let ret = execute_sql(cx, ptr, sql);
    if let Err(e) = tx.commit() {
        let err_msg = cx.string(format!("Failed to commit transaction, error: {}", e));
        return cx.throw(err_msg);
    }
    ret
}

#[neon::export]
fn close_connection(ptr: f64) -> bool {
    let _ = unsafe { Box::from_raw(ptr as usize as *mut Connection) };
    true
}

/// Execute multiple SQL statements inside an array, returns values of the last statement as an array.
///
/// ## Example return
/// ```json
/// {
///    "value": [
///        [
///            "a",
///            "b"
///        ]
///}
////// ```
#[neon::export]
fn execute_sqls<'cx>(cx: &mut Cx<'cx>, ptr: f64, sqls: Handle<JsArray>) -> JsResult<'cx, JsObject> {
    let sqls = sqls.to_vec(cx)?;
    let mut stmts = Vec::with_capacity(sqls.len());

    for sql in sqls {
        let sql = sql.downcast::<JsString, _>(cx).or_throw(cx)?.value(cx);
        stmts.push(sql);
    }

    let conn = unsafe { &mut *(ptr as usize as *mut Connection) };

    let mut value: Option<Handle<JsValue>> = None;
    for (i, sql) in stmts.iter().enumerate() {
        let Ok(mut stmt) = conn.prepare(&sql) else {
            let err_msg = cx.string(format!("Failed to prepare SQL statement: {}", sql));
            return cx.throw(err_msg);
        };
        if i != stmts.len() - 1 {
            // For all statements except the last one, we just execute them without fetching results
            if let Err(e) = stmt.query([]) {
                let err_msg = cx.string(format!(
                    "Failed to execute SQL statement: {}, error: {}",
                    sql, e
                ));
                return cx.throw(err_msg);
            }
        } else {
            // For the last statement, we execute it and fetch results
            let column_count = stmt.column_count();
            let Ok(mut rows) = stmt.query([]) else {
                let err_msg = cx.string(format!("Failed to execute SQL statement: {}", sql));
                return cx.throw(err_msg);
            };
            let mut results = Vec::new();
            while let Ok(Some(row)) = rows.next() {
                let row_obj = cx.empty_array();
                for i in 0..column_count {
                    let val = row.get_ref(i).unwrap();
                    let js_val = value_ref_to_js_string(cx, val);
                    row_obj.prop(cx, i as u32).set(js_val).unwrap();
                }
                results.push(row_obj);
            }
            if results.is_empty() {
                value = Some(cx.undefined().upcast());
            } else {
                let result_array = cx.empty_array();
                for (i, row) in results.into_iter().enumerate() {
                    result_array.prop(cx, i as u32).set(row).unwrap();
                }
                value = Some(result_array.upcast());
            }
        }
    }

    let result = cx.empty_object();
    result.prop(cx, "value").set(value.unwrap()).unwrap();
    Ok(result)
}

// Use #[neon::main] to add additional behavior at module loading time.
// See more at: https://docs.rs/neon/latest/neon/attr.main.html

// #[neon::main]
// fn main(_cx: ModuleContext) -> NeonResult<()> {
//     println!("module is loaded!");
//     Ok(())
// }
