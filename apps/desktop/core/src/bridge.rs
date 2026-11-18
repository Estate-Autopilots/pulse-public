//! Authenticated localhost-only bridge for enumerated app-event counts. No keyboard hook.
use crate::{tracker::Tracker, AgentCore};
use serde::Deserialize;
use std::{collections::BTreeMap, io::Read};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Commands {
    epoch: String,
    app: String,
    counts: BTreeMap<String, u32>,
}
pub fn serve(tracker: Tracker, core: AgentCore) -> Result<(), String> {
    let server =
        tiny_http::Server::http("127.0.0.1:47831").map_err(|_| "Adobe bridge port unavailable")?;
    for mut req in server.incoming_requests() {
        let token = tracker.bridge_token();
        let authenticated = req
            .headers()
            .iter()
            .any(|h| h.field.equiv("X-Pulse-Bridge-Token") && h.value.as_str() == token);
        // Browser pages cannot call the bridge, even if a token was accidentally pasted into a page.
        let origin = req.headers().iter().any(|h| h.field.equiv("Origin"));
        if !authenticated || origin {
            let _ = req.respond(tiny_http::Response::empty(403));
            continue;
        }
        if req.url() == "/state" && req.method() == &tiny_http::Method::Get {
            let body = tracker.bridge_state(&core).to_string();
            let _ = req.respond(tiny_http::Response::from_string(body).with_header(
                tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap(),
            ));
            continue;
        }
        if req.url() != "/commands" || req.method() != &tiny_http::Method::Post {
            let _ = req.respond(tiny_http::Response::empty(403));
            continue;
        }
        let mut bytes = Vec::new();
        let read = req.as_reader().take(16385).read_to_end(&mut bytes);
        let status = if read.is_err() || bytes.len() > 16384 {
            400
        } else {
            match serde_json::from_slice::<Commands>(&bytes) {
                Ok(c) => {
                    if tracker
                        .commands(&core, &token, &c.epoch, &c.app, c.counts)
                        .is_ok()
                    {
                        200
                    } else {
                        400
                    }
                }
                Err(_) => 400,
            }
        };
        let _ = req.respond(tiny_http::Response::empty(status));
    }
    Ok(())
}
