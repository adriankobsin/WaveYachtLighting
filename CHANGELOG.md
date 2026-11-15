# Changelog

## 1.0.0 – 2026-11-15

First version in Git.

- Touch-panel app: deck menu, deck GA plans with lit zones that glow by level, on/off and dimming per circuit, deck and ship-wide scenes, "All exterior off".
- Circuits and zones from Barillec drawing 2139145-451 rev G (Deck Lighting Arrangement) for Sundeck, Bridge, Owner's, Main and Mast decks.
- Admin mode (password, server-side scrypt hash): add/edit/delete circuits, move and reshape lit areas on the GA, edit scenes per deck, Save & deploy to all panels, 30 automatic layout backups.
- Lutron HomeWorks QSX integration over LEAP: pairing with the Access button, connection test, zone and scene discovery, per-circuit zone addresses with On/Off tests, Lutron scene links, live keypad feedback, automatic reconnect.
- Mock QSX processor for testing without hardware.
- Browser demo (`npm run build-demo`) with a simulated processor.
- systemd service and `deploy/update.sh` for updates from Git.
- Fixed: "Save connection settings" sent an empty IP address.
