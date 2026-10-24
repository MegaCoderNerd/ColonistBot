"""Checked contracts for synthetic learner examples. No external game archive."""

from __future__ import annotations

PROVENANCE = {
    "synthetic_fixture",
    "heuristic_demonstration",
    "synthetic_self_play",
    "reinforcement_target",
    "search_target",
}
LABEL_ROLES = {"heuristic_behavior", "policy_sample", "fixture", "search"}
REQUIRED = (
    "schema_version",
    "example_id",
    "game_id",
    "decision_index",
    "seed",
    "ruleset",
    "player_count",
    "generating_policy",
    "model_checkpoint",
    "completion_status",
    "cutoff_reason",
    "target_provenance",
    "label_role",
    "chosen_action_id",
    "actor_win",
    "reward_note",
    "observation",
)


class ExampleError(ValueError):
    pass


def observation_leak(observation: dict) -> str | None:
    if not isinstance(observation, dict):
        return "observation is not an object"
    if observation.get("schema_version") not in ("colonist_observation_v1", "colonist_observation_v2"):
        return "observation schema"
    forbidden = {"dev_deck_order", "devDeckOrder", "future_dice", "opponent_hands", "opponent_dev_identities", "stolen_resource"}
    found = forbidden.intersection(observation)
    if found:
        return "hidden field " + ",".join(sorted(found))
    for opponent in observation.get("opponents", []):
        if not isinstance(opponent, dict):
            return "opponent record"
        if "hand" in opponent or "dev_cards" in opponent or "ready_devs" in opponent:
            return "opponent hidden cards"
        if observation.get("schema_version") == "colonist_observation_v2":
            tracked = opponent.get("tracked_resources")
            if not isinstance(tracked, dict):
                return "opponent tracked resources"
            for key in ("lumber", "brick", "wool", "grain", "ore", "unknown", "exact"):
                if key not in tracked:
                    return f"opponent tracked resources missing {key}"
        for key in ("public_vp", "hand_size"):
            if key not in opponent:
                return f"opponent missing {key}"
    actor = observation.get("actor")
    if not isinstance(actor, dict) or "hand" not in actor:
        return "actor hand"
    if not observation.get("candidates"):
        return "no legal candidates"
    if observation.get("schema_version") == "colonist_observation_v2":
        if not isinstance(observation.get("bank_exact"), bool):
            return "bank exactness"
        if observation.get("bank_exact") and not isinstance(observation.get("bank"), dict):
            return "exact bank missing"
        if not observation.get("bank_exact") and observation.get("bank") not in (None, {}):
            return "uncertain bank included counts"
    ids = [candidate.get("action_id") for candidate in observation["candidates"]]
    if any(not isinstance(action_id, str) or not action_id for action_id in ids):
        return "candidate id"
    if len(ids) != len(set(ids)):
        return "duplicate candidate id"
    return None


def validate_example(example: dict) -> None:
    missing = [key for key in REQUIRED if key not in example]
    if missing:
        raise ExampleError("missing " + ", ".join(missing))
    if example["schema_version"] != "colonist_training_example_v1":
        raise ExampleError("schema_version")
    if example["target_provenance"] not in PROVENANCE:
        raise ExampleError("target_provenance")
    if example["label_role"] not in LABEL_ROLES:
        raise ExampleError("label_role")
    if example["ruleset"] != "base":
        raise ExampleError("ruleset")
    if example["player_count"] not in (2, 3, 4):
        raise ExampleError("player_count")
    if not example["generating_policy"]:
        raise ExampleError("generating_policy")
    leak = observation_leak(example["observation"])
    if leak:
        raise ExampleError(leak)
    chosen = example["chosen_action_id"]
    legal = {candidate["action_id"] for candidate in example["observation"]["candidates"]}
    if chosen not in legal:
        raise ExampleError("chosen action is not legal")
    teacher = example.get("teacher_action_id")
    if teacher is not None and teacher not in legal:
        raise ExampleError("teacher action is not legal")
    status = example["completion_status"]
    score = example["actor_win"]
    if status == "incomplete":
        if score is not None:
            raise ExampleError("incomplete game has a win label")
        if not example["cutoff_reason"]:
            raise ExampleError("incomplete game needs a cutoff reason")
    elif status == "completed":
        if score not in (0, 0.5, 1):
            raise ExampleError("completed game needs a 0, 0.5, or 1 actor_win")
        if example["cutoff_reason"] is not None:
            raise ExampleError("completed game has a cutoff reason")
    else:
        raise ExampleError("completion_status")
    if example["target_provenance"] == "heuristic_demonstration" and example["label_role"] != "heuristic_behavior":
        raise ExampleError("heuristic demonstrations are behavior labels")
    if example["target_provenance"] == "synthetic_fixture" and example["label_role"] != "fixture":
        raise ExampleError("fixtures are not competence labels")


def game_split(game_id: str, eval_fraction: float = 0.2, salt: str = "colonist-ml-split-v1") -> str:
    import hashlib

    digest = hashlib.sha256(f"{salt}:{game_id}".encode("utf-8")).hexdigest()
    bucket = int(digest[:8], 16) / 0xFFFFFFFF
    return "eval" if bucket < eval_fraction else "train"


def load_jsonl(path: str, held_out_seeds: set[str] | None = None) -> tuple[list[dict], int]:
    import json

    examples = []
    seen = set()
    dropped = 0
    held_out_seeds = held_out_seeds or set()
    with open(path, "r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            example = json.loads(line)
            try:
                validate_example(example)
            except ExampleError as error:
                raise ExampleError(f"{path}:{line_number}: {error}") from error
            if example["seed"] in held_out_seeds:
                raise ExampleError(f"{path}:{line_number}: held-out seed {example['seed']} leaked into training")
            if example["example_id"] in seen:
                dropped += 1
                continue
            seen.add(example["example_id"])
            examples.append(example)
    return examples, dropped
