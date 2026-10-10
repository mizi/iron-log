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

Everything is stored on the device in `localStorage`. Nothing is sent to a server.
Use **Settings → Export backup** to save a JSON file, and **Import backup** to restore it.

## Development

Static files, no build step. Serve the folder with any static server:

```sh
python3 -m http.server 8000
```

GitHub Pages serves the `main` branch root. Bump `VERSION` in `sw.js` when shipping changes so installed copies refresh their cache.
