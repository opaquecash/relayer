//! Node orchestration (spec/relayer-market.md §4): react to gossip messages.
//! On an advert for a chain we serve, validate the job on-chain and publish a bid.
//! On a bid, cache it for the gateway. On a payload addressed to our box key, open
//! it and run accept-then-submit on the matching chain.

use base64::Engine as _;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

use crate::crypto::BoxIdentity;
use crate::gateway::{publish_message, record_bid};
use crate::job::{bid_signing_hash, parse_hex32, Advert, Bid, Message, PayloadEnvelope};
use crate::submitter::Submitter;

pub struct Node {
    pub submitters: Arc<Vec<Box<dyn Submitter>>>,
    pub box_id: Arc<BoxIdentity>,
    pub min_fee: u128,
    pub publish: mpsc::Sender<Vec<u8>>,
    pub bids: Arc<Mutex<HashMap<String, Vec<Bid>>>>,
    /// Chain id remembered per job id from adverts we bid on (routes the payload).
    job_chain: Mutex<HashMap<String, u16>>,
}

impl Node {
    pub fn new(
        submitters: Arc<Vec<Box<dyn Submitter>>>,
        box_id: Arc<BoxIdentity>,
        min_fee: u128,
        publish: mpsc::Sender<Vec<u8>>,
        bids: Arc<Mutex<HashMap<String, Vec<Bid>>>>,
    ) -> Self {
        Self {
            submitters,
            box_id,
            min_fee,
            publish,
            bids,
            job_chain: Mutex::new(HashMap::new()),
        }
    }

    fn submitter_for(&self, chain: u16) -> Option<&dyn Submitter> {
        self.submitters.iter().find(|s| s.chain() == chain).map(|s| s.as_ref())
    }

    /// Dispatch one inbound gossip payload.
    pub async fn handle(&self, bytes: &[u8]) {
        let msg: Message = match serde_json::from_slice(bytes) {
            Ok(m) => m,
            Err(_) => return,
        };
        match msg {
            Message::Advert(a) => self.on_advert(a).await,
            Message::Bid(b) => record_bid(&self.bids, b),
            Message::Payload(p) => self.on_payload(p).await,
        }
    }

    async fn on_advert(&self, a: Advert) {
        let Some(submitter) = self.submitter_for(a.chain) else { return };
        let Ok(job_id) = parse_hex32(&a.job_id) else { return };
        let fee: u128 = a.fee.parse().unwrap_or(0);
        if fee < self.min_fee {
            return;
        }
        // Validate against chain state before bidding (spec §4 step 2).
        let job = match submitter.fetch_job(&job_id).await {
            Ok(j) => j,
            Err(e) => {
                tracing::debug!("fetch_job failed: {e}");
                return;
            }
        };
        if !job.exists || job.accepted || job.closed || job.fee != fee {
            return;
        }
        // Don't bid on a job already (nearly) expired: accept would revert at the deadline.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if job.deadline <= now + 15 {
            return;
        }
        match submitter.free_stake().await {
            Ok(Some(free)) if free >= fee => {}
            _ => return,
        }

        let x = self.box_id.public;
        let hash = bid_signing_hash(&job_id, &x);
        let sig = match submitter.sign_bid(&hash) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("sign_bid failed: {e}");
                return;
            }
        };
        let bid = Bid {
            t: "bid".into(),
            v: 1,
            job_id: a.job_id.clone(),
            chain: a.chain,
            operator: submitter.operator(),
            x25519_pk: format!("0x{}", hex::encode(x)),
            sig,
        };
        self.job_chain.lock().unwrap().insert(a.job_id.clone(), a.chain);
        tracing::info!("bidding on job {} (chain {})", a.job_id, a.chain);
        // Serve our own bid on this node's gateway too: gossipsub does not deliver a
        // message back to its publisher, so without this our gateway would never list it.
        record_bid(&self.bids, bid.clone());
        publish_message(&self.publish, &Message::Bid(bid)).await;
    }

    async fn on_payload(&self, p: PayloadEnvelope) {
        // Only react to envelopes addressed to our box key.
        let our_key = format!("0x{}", hex::encode(self.box_id.public));
        if p.to.trim_start_matches("0x").to_lowercase()
            != our_key.trim_start_matches("0x").to_lowercase()
        {
            return;
        }
        let Ok(job_id) = parse_hex32(&p.job_id) else { return };
        let chain = match self.job_chain.lock().unwrap().get(&p.job_id).copied() {
            Some(c) => c,
            None => return, // we never bid on this job
        };
        let Some(submitter) = self.submitter_for(chain) else { return };

        let boxed = match base64::engine::general_purpose::STANDARD.decode(&p.box_b64) {
            Ok(b) => b,
            Err(_) => return,
        };
        let payload = match self.box_id.open(&boxed) {
            Ok(pt) => pt,
            Err(e) => {
                tracing::warn!("payload decrypt failed: {e}");
                return;
            }
        };
        tracing::info!("submitting job {} on chain {}", p.job_id, chain);
        match submitter.accept_and_submit(&job_id, &payload).await {
            Ok(tx) => tracing::info!("job {} submitted: {tx}", p.job_id),
            Err(e) => tracing::error!("submit failed for {}: {e}", p.job_id),
        }
    }
}

