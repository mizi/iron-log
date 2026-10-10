# Iron Log

A phone-first workout log that installs to the home screen and works offline.

- Tap an exercise, set weight and reps, log the set
- Rest timer starts after each set and beeps when time is up
- Last session and personal best shown for the current exercise
- History: weekly volume for 8 weeks, personal bests with estimated 1-rep max, past sessions
- kg or lb, custom exercise list

## Install on iPhone

Open the site in Safari, tap **Share**, then **Add to Home Screen**.

## Data

The log is stored on the device in `localStorage`.
Use **Settings → Export backup** to save a JSON file, and **Import backup** to merge it back in.

## Sync

Optional. **Settings → Sync** keeps a copy in one JSON file (`iron-log.json`) in a private GitHub repository, so several devices share one log.

1. Create a private repository, for example `iron-log-data`, with a README.
2. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) with access to only that repository and **Contents: Read and write**.
3. Enter `owner/repo` and the token in Settings on each device.

Sync runs when the app opens, when it comes back to the foreground or online, and two seconds after each change. Devices merge rather than overwrite: sets are combined by id, deletions are tracked so they reach every device, and the newest settings win. The token is kept on the device and sent only to `api.github.com`.

Backends are pluggable: `sync.js` defines the provider contract (`pull`, `push`, and the `SyncError` kinds), and `providers` maps a config name to an implementation.

## Development

Static files, no build step. Serve the folder with any static server:

```sh
python3 -m http.server 8000
```

Run the tests with `node --test tests/`.

GitHub Pages serves the `main` branch root. Bump `VERSION` in `sw.js` when shipping changes so installed copies refresh their cache.
