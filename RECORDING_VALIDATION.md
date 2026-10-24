# Recording-based validation

Ordinary `npm test` does not read the local recording bundle. Tests marked `recording fixture required` stay skipped until `COLONIST_RECORDINGS_PATH` points at a bundle.

The bundle is one JSON object:

```json
{ "recordings": [ { "schemaVersion": 1, "id": "...", "gameId": "...", "frames": [], "log": [], "sockets": [] } ] }
```

The local file is `colonist-recordings-v1.json` in the repository root. It is gitignored. Do not commit it or copy its contents into the repo. These games are regression input only. They are not ML training data.

## PowerShell

```powershell
$env:COLONIST_RECORDINGS_PATH = "C:\Users\ashma\.gemini\antigravity\scratch\ColonistBot\colonist-recordings-v1.json"
$env:COLONIST_RECORDINGS_STRICT = "1"
npm run validate:recordings
npm run test:recordings
```

`npm run test:recordings` sets that path when the variable is empty, turns on strict mode, validates every recording, and runs Vitest in one worker. A missing, unreadable, or malformed bundle fails before the suite. A recording-dependent test whose required game id is absent fails with `Uncovered recording scenario` instead of being skipped.

Strict mode off, or no path and no fallback bundle:

```powershell
Remove-Item Env:COLONIST_RECORDINGS_PATH -ErrorAction SilentlyContinue
Remove-Item Env:COLONIST_RECORDINGS_STRICT -ErrorAction SilentlyContinue
npm test
```

The coverage summary is written to `data/external/recording-coverage.json`. That directory is gitignored. It lists game ids, rule buckets, event types, and which named tests have their required ids. It does not include frames or player names.

This file has 79 recordings and 79 unique ids. All 79 decode to a board. 75 are two-player games with `modeSetting` 0, `diceSetting` 1, and 15 victory points. Two are four-player rush games (`modeSetting` 12). The other two four-player games use different dice or victory-point settings and stay out of both dice cohorts. `farm9373`, `edge9896`, and `deck7708` are present.

Reconstruction checks every accepted recording, rejects duplicate ids, and fails if any recording has no board. It does not expect the older 53-game file.

The dice test still checks the published 51-game fit that defines the model (`gameCount` 51, 3,568 rolls, 1,144 holdout rolls, 140 rush rolls). The live cohort is separate: two-player 15-VP balanced games, plus the rush games, with every other ruleset counted and excluded. On that live cohort the 24-roll windows must still have zero cap violations, the 36-roll windows must still exceed 80 violations, lag-1 must stay under 0.085, and the 24-of-36 shoe must beat fair 2d6 and the stationary marginal by the same 0.08 NLL and 0.01 Brier margins. The holdout is the same 16/51 fraction, taken from the end of the file.

The Road Building acceptance test uses frame 200 of `farm9373`. The final snapshot has road pieces and a playable card, but no settlement the coach treats as worth two roads, so the headline stays "Hold the cards and roll." The earlier prefix is a position where the existing coach does recommend the card. A card bought this turn is still refused there.

`npm run test:recordings` uses a 120 second Vitest timeout so corpus construction and the benchmark rollouts can finish. The ordinary `npm test` timeout is unchanged.
