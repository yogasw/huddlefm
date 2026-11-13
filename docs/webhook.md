# Webhook

An admin can have HuddleFM tell another system when something happens. It is set in Settings, on the Admin tab, under **Webhook**: **Set up** opens a form with an address, an optional auth token and a list of events to tick. **Send a test** posts a `webhook.test` event, and **Remove** deletes the webhook and its token. Nothing is sent until an address is saved and at least one event is ticked.

The address and token are stored in the database, not in the environment. The token is never shown again after it is saved: leave the field empty to keep it, type a new one to replace it, or tick "Remove the saved token".

## Events

| Event           | Sent when                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `huddle.joined` | The bot joined a huddle and its session started                                                                 |
| `huddle.left`   | The bot left by itself: alone, idle or paused for too long, the huddle ended, or the media connection ended     |
| `queue.low`     | The queue fell to the number of songs set for the "Songs left" notice (1 by default), once until it is refilled |
| `queue.last`    | The last song in the queue started                                                                              |
| `queue.ended`   | The queue ran out and nothing is playing                                                                        |
| `session.ended` | Someone ended the session, a host or an agent                                                                   |

The queue events do not depend on the notices posted in the thread: the webhook gets them even when those are off.

## Request

Each event is a `POST` of JSON to the address, with `Content-Type: application/json` and, when a token is saved, `Authorization: Bearer <token>`.

```json
{
  "event": "queue.last",
  "at": "2026-01-01T12:00:00.000Z",
  "sessionId": "…",
  "huddleId": "…",
  "channelId": "C…",
  "threadTs": "1700000000.000100",
  "current": { "title": "Song", "artist": "Artist" },
  "queueLength": 0,
  "recent": [{ "title": "Earlier song", "artist": "Artist" }]
}
```

`current` is `null` when nothing is playing. `recent` is up to the last five songs played. `huddle.left` and `session.ended` also carry a `reason`, such as `alone timeout`, `idle timeout`, `paused timeout`, `huddle ended`, `ended by host` or `ended by agent`.

A response with a status from 200 to 299 counts as received. Anything else, or no answer within five seconds, is tried again twice, one second and then three seconds later, and then given up on with a warning in the log. Redirects are not followed. A webhook that is down never holds up the music.

## Addresses

Only `https://` addresses are accepted, with no username or password in them. Addresses that point at this host or a private network (localhost, `.local` and `.internal` names, and private, loopback and link-local IP addresses) are refused. Host names are not resolved when the address is saved, so this guards against a slip, not against an admin who means harm.
