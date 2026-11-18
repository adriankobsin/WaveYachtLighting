# Changelog

## 1.5.0 – 2026-11-18

- **Light fixtures on the GA.** Each circuit is now drawn as its real fittings: floodlight and spotlight beams, downlights, pendants, wall lights, step lights, underwater lights, LED strips, neon and general areas. Fixtures that are off stay visible as grey outlines; lights fade on screen when they change.
- Crew: tap any light on the plan to switch or dim its circuit in a small pop-up. Zoom buttons under each plan.
- Admin (deck → Lights): fixture toolbar above the plan. Pick a type, click to place (points stay armed for rows; strips, neon and areas are drawn point by point). Drag to move; white handle aims and sizes, amber handle sets beam width; colour, type, circuit, duplicate and delete in the editor. Keys: arrows, Ctrl+D, Delete, Esc.
- Lit areas in existing layouts become "Area" fixtures automatically – nothing is lost. The standard Sundeck and Main deck layouts now use real fixtures; on update, Sundeck and Main deck circuits that still have their standard areas (or none) get them once (`fxUpgraded`). Circuits you have edited keep their areas.
- Admin → Overview → **Decks on the dashboard**: untick a deck to hide it from the crew dashboard and menu (admins still see it).

## 1.4.1 – 2026-11-17

- Browser demo: new decks were not added when the page first showed a cached copy of the saved layout. The check now runs when the live layout arrives.

## 1.4.0 – 2026-11-17

- New decks **Lower deck** (Pont principal -1, «Нижняя палуба») and **Tank deck** (Pont principal -2, «Палуба цистерн»), placed after Main deck. They start with no circuits; add circuits in admin (deck → Lights → + Add circuit).
- Updating an existing server adds decks that are new in the standard layout to the saved layout once, in their standard place. Saved circuits, scenes and edits are not touched (`knownDefaultDecks` records which decks have been offered). The browser demo does the same.

## 1.3.0 – 2026-11-16

- **English / Russian** switch (EN / RU) in the top bar. Each panel remembers its choice.
- Everything is translated: menus, buttons, admin pages (Lights, Scenes, Lutron setup, Users & passwords), dialogs, messages, server and Lutron error messages, and the demo's simulated-processor panel.
- Deck, circuit and scene names and deck notes have Russian versions (`ru` in the layout). All current decks, circuits and scenes are translated.
- Admin can edit **Name (Russian)** for circuits and **Scene name (Russian)** for scenes.
- Headings fall back to Inter for Cyrillic, since Space Grotesk has no Cyrillic letters.
- To keep the admin top bar on one line: the subtitle and the "circuits on" count are hidden in admin mode, and in Russian "Save & deploy" reads «Применить».
- Circuit cards are slightly wider and names can wrap to two lines.

## 1.2.0 – 2026-11-15

- Admin users: **Wave AVI** stays the master account. Other users (ETO, engineer…) can be added with their own password and the same admin access.
- New admin page **Users & passwords**: change your own password, add, rename and delete users, set a new password for another user.
- Rules: the master cannot be deleted and only it can change the master password; you cannot delete yourself; passwords need at least 8 characters and must differ between users (login is by password only); changing a password logs that user out on other screens.
- The top bar shows who is logged in (Exit admin · name). "Discard changes" is now "Discard" so the admin top bar fits on one line.
- `npm run set-password` sets the Wave AVI password, or another user's with `-- --user "Name"`.
- Users are stored in `data/users.json`. The old `data/admin.json` is migrated automatically.
- Browser demo: same user features, with PBKDF2-hashed passwords in the demo's shared store.

## 1.1.1 – 2026-11-15

- Browser demo: the simulated-processor panel (Access button, "Processor online") is hidden from normal users and only shown to admins on the Lutron setup page. The processor status in the top bar is still shown to everyone.

## 1.1.0 – 2026-11-15

- New **At anchor** scene: anchor floods (GR2) on, walkways and side decks at 30 %, ship name at 70 %, deck downlights at 20 %, everything else off.
- Scenes are fully editable in admin, both on the Overview (all decks at once) and on each deck:
  - each light can be **Off**, **On** at a set level, or **Don't change** (left as it is when the scene runs);
  - rename, add, duplicate, delete and reorder scenes;
  - "Set all" (Off / 25 / 50 / 100 % / Don't change), "Copy current lighting" and "Preview" for the deck or for all decks;
  - pressing a scene button while in admin opens it in the editor.
- Server and demo: a scene level of -1 means "don't change".

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
