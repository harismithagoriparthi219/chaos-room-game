# CHAOS ROOM: Trust Nobody!

A mobile-friendly, 4–8 player social deduction game. Players join by room code, vote on a response to four ship crises, choose a private action, then vote on a suspect.

## Run it

Requires Node.js 20 or newer. No package installation is needed.

```sh
node server.mjs
```

Open `http://localhost:4173`. The host creates a room and shares the six-character code. For a quick local multiplayer check, open the page in several browser windows or devices on the same network and use the host computer's local network address.

## Rules

- One saboteur is assigned in rooms of 4–6; two are assigned in rooms of 7–8.
- Each crisis has a 45-second team vote, a 20-second private action, and a 25-second accusation vote. Missing votes become safe defaults so a disconnected player cannot stall the room.
- Crew actions can reduce damage; saboteurs can help or add hidden damage.
- The crew survives four crises to win. The saboteurs win if systems reach zero or all crew members are accused.
- A correct accusation repairs one system point. A wrong accusation costs one. Tied votes and skips have no effect; a player cannot be accused twice.
- Roles and private actions stay on the server and are only returned to the player they belong to. Roles are revealed after the game.

## Test

```sh
node --test
```

The tests cover complete crew and saboteur outcomes, 4- and 7-player role counts, role secrecy, invalid actions, accusation limits, reconnect-by-session, leaderboard scoring, and timeout defaults.

## Publish

The `render.yaml` Blueprint deploys the Docker app as one always-on Render web service in Singapore with `/health` as its health check. It uses a paid always-on compute plan; review the current plan and billing in Render before applying the Blueprint. Render Free services sleep after 15 minutes without inbound traffic and may restart, which can clear active rooms.

To publish:

1. Push this project to a GitHub repository.
2. In Render, choose **New → Blueprint**, connect that repository, and review the `chaos-room` service and compute plan.
3. Apply the Blueprint and wait for the service status to become **Live**. Render provides a public `onrender.com` URL.
4. Open the URL on two separate devices. Create a room on one device, join with its code on the other, and verify that the lobby and each subsequent vote update on both screens.

Keep exactly one app instance: active rooms are held in server memory, so separate instances would not see the same rooms. Browser refreshes and brief disconnects reconnect while the server process remains running; a server restart clears active rooms. To preserve games across restarts or scale beyond one instance, add shared persistent storage before increasing the instance count.
