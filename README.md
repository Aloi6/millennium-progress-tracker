# Millennium Progress Tracker

A compact Millennium plugin for marking game progress in the desktop Steam Library. Set a status from Steam's game context menu or from a cover badge. Open **Progress Tracker** below Library search to review tracked games.

- **Progress and planning** — Mark games Backlog, Playing, Completed, Mastered, On Hold, or Dropped. Set an optional priority and choose a game to play first.
- **Tracker tools** — Export CSV, save or merge a JSON backup, or enable automatic Steam collections for your statuses. Collection sync is optional and only manages collections created by MPT.
- **Storage** — Progress is stored locally in Steam. JSON backups include statuses, priorities, and play order.

## Install

Place `com.mpt.progress.star` in `Steam/millennium/plugins`. Enable **Millennium Progress Tracker** in Millennium settings and restart Steam. Version 0.5.2 was tested on Windows with Millennium 3.6.3.

## Build from source

Install Bun, then run:

```sh
bun install --frozen-lockfile
bun run build
```

Starlight writes the package to `dist/com.mpt.progress.star`. Steam client updates can affect the right-click integration and artwork detection.
