//! HTTP intake gateway (spec/relayer-market.md §3.4). Lets clients without a libp2p
//! stack advertise jobs, poll bids, and deliver payloads. Everything received is
//! re-published to the gossip mesh and (for bids) cached for polling.

use axum::{
    extract::{Path, State},
    routing::{get, post},
    Json, Router,
};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

use crate::job::{Bid, Message};

#[derive(Clone)]
pub struct GatewayState {
    /// Publish raw JSON bytes to the gossip mesh.
    pub publish: mpsc::Sender<Vec<u8>>,
    /// Bids seen per job id (served back to polling users).
    pub bids: Arc<Mutex<HashMap<String, Vec<Bid>>>>,
}

pub fn router(state: GatewayState) -> Router {
    Router::new()
        .route("/v1/jobs", post(post_job))
        .route("/v1/jobs/:jobId/bids", get(get_bids))
        .route("/v1/jobs/:jobId/payload", post(post_payload))
        .route("/v1/health", get(|| async { "ok" }))
        .with_state(state)
}

/// Record a bid the node observed (from gossip), so the gateway can serve it.
pub fn record_bid(bids: &Arc<Mutex<HashMap<String, Vec<Bid>>>>, bid: Bid) {
    let mut map = bids.lock().unwrap();
    let entry = map.entry(bid.job_id.clone()).or_default();
    if !entry.iter().any(|b| b.operator == bid.operator) {
        entry.push(bid);
    }
}

async fn post_job(State(s): State<GatewayState>, Json(advert): Json<Value>) -> Json<Value> {
    let _ = s.publish.send(serde_json::to_vec(&advert).unwrap_or_default()).await;
    Json(serde_json::json!({ "ok": true }))
}

async fn get_bids(
    State(s): State<GatewayState>,
    Path(job_id): Path<String>,
) -> Json<Vec<Bid>> {
    let map = s.bids.lock().unwrap();
    Json(map.get(&job_id).cloned().unwrap_or_default())
}

async fn post_payload(
    State(s): State<GatewayState>,
    Path(_job_id): Path<String>,
    Json(envelope): Json<Value>,
) -> Json<Value> {
    let _ = s.publish.send(serde_json::to_vec(&envelope).unwrap_or_default()).await;
    Json(serde_json::json!({ "ok": true }))
}

/// Re-publish a locally minted message (used by the node's own delivery duties).
pub async fn publish_message(publish: &mpsc::Sender<Vec<u8>>, msg: &Message) {
    if let Ok(bytes) = serde_json::to_vec(msg) {
        let _ = publish.send(bytes).await;
    }
}
