//! libp2p GossipSub mesh on `opaque/jobs/v1` (spec/relayer-market.md §3). Nodes
//! publish and receive the JSON market messages; the HTTP gateway feeds local intake
//! into the same topic so browser/SDK clients without a libp2p stack participate.

use anyhow::Result;
use libp2p::{
    futures::StreamExt,
    gossipsub, identify, noise,
    swarm::{NetworkBehaviour, SwarmEvent},
    tcp, yamux, Multiaddr,
};
use std::time::Duration;
use tokio::sync::mpsc;

use crate::config::TOPIC;

#[derive(NetworkBehaviour)]
struct Behaviour {
    gossipsub: gossipsub::Behaviour,
    identify: identify::Behaviour,
}

/// Handle to the running swarm: publish outbound messages, receive inbound bytes.
pub struct P2p {
    pub outbound: mpsc::Sender<Vec<u8>>,
}

/// Start the swarm. Inbound message payloads are forwarded to `inbound`; bytes sent on
/// the returned channel are published to the topic.
pub async fn start(
    listen: &str,
    peers: &[String],
    inbound: mpsc::Sender<Vec<u8>>,
) -> Result<P2p> {
    let mut swarm = libp2p::SwarmBuilder::with_new_identity()
        .with_tokio()
        .with_tcp(tcp::Config::default(), noise::Config::new, yamux::Config::default)?
        .with_behaviour(|key| {
            let gossipsub = gossipsub::Behaviour::new(
                gossipsub::MessageAuthenticity::Signed(key.clone()),
                gossipsub::ConfigBuilder::default()
                    .heartbeat_interval(Duration::from_secs(1))
                    .validation_mode(gossipsub::ValidationMode::Strict)
                    .build()
                    .expect("valid gossipsub config"),
            )
            .expect("gossipsub behaviour");
            let identify = identify::Behaviour::new(identify::Config::new(
                "/opaque-relayer/1.0.0".into(),
                key.public(),
            ));
            Behaviour { gossipsub, identify }
        })?
        .with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(60)))
        .build();

    let topic = gossipsub::IdentTopic::new(TOPIC);
    swarm.behaviour_mut().gossipsub.subscribe(&topic)?;
    swarm.listen_on(listen.parse::<Multiaddr>()?)?;
    for p in peers {
        if let Ok(addr) = p.parse::<Multiaddr>() {
            let _ = swarm.dial(addr);
        }
    }

    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(64);
    let publish_topic = topic.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                Some(bytes) = rx.recv() => {
                    if let Err(e) = swarm
                        .behaviour_mut()
                        .gossipsub
                        .publish(publish_topic.clone(), bytes)
                    {
                        tracing::debug!("gossip publish skipped: {e}");
                    }
                }
                event = swarm.select_next_some() => {
                    handle_event(event, &inbound).await;
                }
            }
        }
    });

    Ok(P2p { outbound: tx })
}

async fn handle_event(event: SwarmEvent<BehaviourEvent>, inbound: &mpsc::Sender<Vec<u8>>) {
    match event {
        SwarmEvent::NewListenAddr { address, .. } => {
            tracing::info!("listening on {address}");
        }
        SwarmEvent::Behaviour(BehaviourEvent::Gossipsub(gossipsub::Event::Message {
            message,
            ..
        })) => {
            let _ = inbound.send(message.data).await;
        }
        _ => {}
    }
}
