# SheCanAI response board

A no-login sticky-note board. The question sits in the middle; participants pick a name and a colour and post notes around it.

- Participants: open the site URL.
- Host: open `/?host=YOUR_HOST_KEY` to switch questions, close posting, delete notes and download all responses as CSV.

Run locally: `HOST_KEY=secret node server.js` (no dependencies). Set `DATA_DIR` to a persistent disk path to keep notes across restarts.
