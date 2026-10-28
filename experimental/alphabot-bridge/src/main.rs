//! One-decision probe of the shipped AlphaBot.
//!
//! `MlpNet::load` is their loader, including the embedded CTNN self-check.
//! `AlphaBot::choose_action` is their search. This binary does not convert a
//! ColonistBot state: their vertex ids, hidden-information contract, and
//! derived masks are not interchangeable with ours.

use std::sync::Arc;
use std::time::Instant;

use catan_core::game::CatanGame;
use catan_core::players::Player;
use catan_env::alpha::AlphaBot;
use catan_env::net::MlpNet;
use catan_env::obs::{encode_obs, Visibility, OBS_DIM};

fn main() {
    let mut args = std::env::args().skip(1);
    let net_path = args.next().expect("usage: alphabot-bridge <catan-512.ctnn> [seed]");
    let seed: u64 = args.next().unwrap_or_else(|| "1".to_string()).parse().expect("seed");

    let net = Arc::new(MlpNet::load(std::path::Path::new(&net_path)));
    let game = CatanGame::new(4, seed);
    let valid = game.valid_actions();
    let mut first = AlphaBot::new(seed, Arc::clone(&net), 8, 96, 300);
    let mut second = AlphaBot::new(seed, Arc::clone(&net), 8, 96, 300);
    let started = Instant::now();
    let action = first.choose_action(&game, &valid);
    let elapsed_ms = started.elapsed().as_millis();
    let again = second.choose_action(&game, &valid);
    let legal = valid.contains(&action);

    let (perfect_differs, realistic_same) = hidden_composition_probe();

    println!(
        "{{\"model_self_check\":true,\"search\":\"catan_env::alpha::AlphaBot\",\"inference\":\"catan_env::net::MlpNet\",\"config\":\"8,96,300\",\"players\":{},\"victory_target\":{},\"visibility_used_by_search\":\"perfect\",\"action\":\"{}\",\"legal\":{},\"legal_count\":{},\"reproducible\":{},\"elapsed_ms\":{},\"perfect_obs_changes_when_hidden_mix_changes\":{},\"realistic_obs_changes_when_hidden_mix_changes\":{}}}",
        game.state.num_players,
        game.state.victory_target,
        format!("{action:?}").replace('"', "'"),
        legal,
        valid.len(),
        action == again,
        elapsed_ms,
        perfect_differs,
        !realistic_same
    );
    if !legal || action != again || !perfect_differs || !realistic_same {
        std::process::exit(1);
    }
}

/// Same public card count, different hidden mix. Perfect observations move.
/// Realistic observations stay put. AlphaBot's search calls the perfect encoder.
fn hidden_composition_probe() -> (bool, bool) {
    let mut wheat = CatanGame::new(4, 7);
    let mut wood = CatanGame::new(4, 7);
    wheat.state.resources[1] = [2, 0, 0, 0, 0];
    wood.state.resources[1] = [0, 0, 2, 0, 0];
    let mut perfect_a = vec![0.0; OBS_DIM];
    let mut perfect_b = vec![0.0; OBS_DIM];
    let mut realistic_a = vec![0.0; OBS_DIM];
    let mut realistic_b = vec![0.0; OBS_DIM];
    encode_obs(&wheat, 0, Visibility::Perfect, &mut perfect_a);
    encode_obs(&wood, 0, Visibility::Perfect, &mut perfect_b);
    encode_obs(&wheat, 0, Visibility::Realistic, &mut realistic_a);
    encode_obs(&wood, 0, Visibility::Realistic, &mut realistic_b);
    (perfect_a != perfect_b, realistic_a == realistic_b)
}
