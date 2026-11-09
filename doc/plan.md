# Phone → TV File Transfer: Build Plan

Build this project one phase at a time. Finish a phase and meet its acceptance criteria before starting the next one.

## 1. Goal

A website where a **phone browser (Sender)** sends **one file per session** to a **TV browser (Receiver, Android TV / Challenger)**.

- Website loads over the internet once. The internet is also used for a few KB during pairing.
- The file travels **directly over the local Wi-Fi/hotspot** using a WebRTC data channel, with **zero internet data**.
- The file is **streamed**: never fully held in memory on either device.
- A dropped connection can be **resumed**.

## 2. Decisions (fixed, do not re-ask)

| Topic | Decision |
|---|---|
| Roles | Phone = Sender, TV = Receiver. One direction, one file per session |
| Stack | Next.js (App Router) + TypeScript, deployed on Vercel |
| Pairing | TV shows QR + 4-digit code. Phone scans the QR, or types the 4 digits **on the phone**. Nothing typed on the TV |
| Mailbox | Next.js route handlers + Upstash Redis (free tier). Holds a few KB for about 2 minutes |
| File path | WebRTC data channel, `iceServers: []` (no STUN, no TURN), so it can never relay over the internet |
| Safety | Confirmation code (4 digits) derived from both DTLS fingerprints, shown on both screens, phone taps "Matches" |
| Memory | Chunked reads, backpressure, ACK window, write to disk on the TV (OPFS) |
| Resume | Included in v1 |
| Saved TV | Phase 5b: trusted devices skip the QR scan and the confirmation code on later sessions |
| Network | TV is connected to the phone's mobile hotspot (same Wi-Fi). Use the **5 GHz** band |
| File size | Typical 1 to 5 GB (large videos). Long transfers: resume, free-space check, wake lock are required |
| TV browser | Unknown. Phase 0 reports what it supports |

## 3. Architecture

```
TV (/tv)                       Vercel API (mailbox)               Phone (/send)
1. Create WebRTC offer
2. POST /api/rooms ──────────► store offer, TTL 120 s
   ◄── code 4821 + tvToken
3. Show QR (…/send?code=4821) + "4821"
                                                      4. Scan QR / type 4821
                              ◄────────────────────── 5. GET offer (room claimed)
                                                      6. Create answer
                              ◄────────────────────── 7. POST answer
8. Poll GET answer (1 s) ◄───
9. Both show confirmation code; phone taps "Matches"
10. DELETE room. Data channel opens over the local Wi-Fi.
11. Phone streams the file ──► TV writes to disk ──► ACKs back
```

### Repository structure

```
app/
  page.tsx                      // landing: choose TV or Phone
  tv/page.tsx                   // receiver UI
  send/page.tsx                 // sender UI (reads ?code=)
  api/rooms/route.ts            // POST create
  api/rooms/[code]/route.ts     // GET offer, DELETE
  api/rooms/[code]/answer/route.ts   // POST/GET answer
  api/tv/route.ts               // Phase 5b: TV publishes/refreshes offer (saved-TV inbox)
  api/tv/offer/route.ts         // Phase 5b: phone fetches offer by tvId
  api/tv/answer/route.ts        // Phase 5b: phone posts answer, TV polls it
lib/
  rtc/peer.ts                   // RTCPeerConnection setup, waitIce, channels
  rtc/sdp.ts                    // fingerprint parse, confirmation code
  transfer/protocol.ts          // message types and constants
  transfer/sender.ts            // read, chunk, backpressure, window
  transfer/receiver.ts          // receive, write, ACK
  storage/transfers.ts          // IndexedDB: resume state
  storage/trust.ts              // Phase 5b: saved TVs/phones, persisted certificates
  server/redis.ts               // Upstash client
  server/rooms.ts               // room logic, rate limit
workers/
  opfs-writer.worker.ts         // sync access handle writer
components/
  QrCode.tsx, ProgressBar.tsx, ConfirmCode.tsx, TvButton.tsx
```

## 4. Protocol

### Channels

- **control** (reliable, ordered): JSON messages.
- **data** (reliable, ordered, binary): file chunks only.

### Constants

| Name | Value |
|---|---|
| CHUNK_SIZE | 16 KiB (16384). Tune up after testing |
| HIGH_WATER (`bufferedAmount`) | 1 MiB |
| LOW_WATER (`bufferedAmountLowThreshold`) | 512 KiB |
| WINDOW | 8 MiB unacknowledged at most |
| ACK_EVERY | 1 MiB written |

### Control messages

```ts
type Msg =
  | { t: "META"; fileId: string; name: string; size: number; mime: string; lastModified: number }
  | { t: "ACCEPT"; fileId: string; offset: number }   // TV: start (or resume) from this byte
  | { t: "REJECT"; reason: string }
  | { t: "ACK"; offset: number }                      // TV: bytes safely on disk
  | { t: "DONE"; size: number }                       // phone: all bytes sent
  | { t: "COMPLETE" }                                 // TV: file finalized
  | { t: "CANCEL" }
  | { t: "ERROR"; message: string };
```

`fileId` = hex(SHA-256(`name|size|lastModified`)). It identifies the file across reconnects.

## 5. Mailbox API

All room data lives in Redis key `room:{code}` as JSON, with `EX 120`.

| Endpoint | Caller | Behavior |
|---|---|---|
| `POST /api/rooms` body `{offer}` | TV | Pick a random unused 4-digit code (`SET NX`), store `{offer, claimed:false, answer:null}`. Return `{code, token}` |
| `GET /api/rooms/{code}` | Phone | Return `{offer}` and mark claimed. If already claimed, return 409 |
| `POST /api/rooms/{code}/answer` body `{answer}` | Phone | Store answer. Only the claimer may post |
| `GET /api/rooms/{code}/answer` header `x-token` | TV | Return `{answer}` or 204 if not yet |
| `DELETE /api/rooms/{code}` header `x-token` | TV | Delete the room |

### Abuse limits

- Rate limit per IP (`@upstash/ratelimit`): for example 10 claim attempts per minute.
- A code is claimable once. Wrong codes count toward the limit.
- Total room lifetime 120 s. Never log SDP.

### Environment variables

Added automatically when you connect Upstash to the Vercel project:

```
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

## 6. Confirmation code

1. Parse `a=fingerprint:sha-256 …` from the TV's offer and from the phone's answer.
2. Sort the two strings, join them, take SHA-256 (`crypto.subtle`), read the first 4 bytes as a number, `mod 10000`, zero-pad to 4 digits.
3. Show on both screens. The phone has a "Matches" button, and the transfer will not start until it is tapped.
4. If it does not match, both sides close the connection.

## 7. Streaming and memory rules (must always hold)

**Sender (phone)**
- Read with `file.stream()` or `blob.slice(start, end).arrayBuffer()` in `CHUNK_SIZE` pieces. Never `file.arrayBuffer()` on the whole file.
- Pause when `bufferedAmount > HIGH_WATER`. Resume on `bufferedamountlow`.
- Keep `sentBytes − ackedBytes ≤ WINDOW`. Wait for ACKs when the window is full.

**Receiver (TV)**
- Write each chunk immediately (OPFS sync access handle in a worker). Do not collect chunks in an array.
- Send ACK after each `ACK_EVERY` bytes written (and at the end).
- Finish: `getFile()` → `URL.createObjectURL(file)` → anchor click with `download`. The blob is disk-backed, not in RAM.
- OPFS file name: `{fileId}.part`. Delete it after the user confirms the download.

## 7b. Expected speed and large-file rules

Estimates only. Real numbers come from Phase 0 (loopback test) and Phase 3 (benchmarks).

| Speed | 1 GB | 2 GB | 5 GB |
|---|---|---|---|
| 5 MB/s (2.4 GHz hotspot) | about 3.5 min | about 7 min | about 17 min |
| 15 MB/s (typical 5 GHz) | about 1 min | about 2.5 min | about 6 min |
| 30 MB/s (best case) | about 35 s | about 1 min | about 3 min |

What limits speed (slowest wins): Wi-Fi link (band, signal, TV Wi-Fi chip), TV CPU (DTLS encryption), TV storage write speed, chunk size.

Rules for large files:
- **5 GHz hotspot.** Show a setup tip on the phone screen: Android Settings → Hotspot → AP band → 5 GHz; iPhone: turn off "Maximize Compatibility". The TV must support 5 GHz.
- **Free-space check on the TV before ACCEPT.** With the OPFS-then-download method, require about **2× file size** free (a 5 GB file needs about 10 GB). Refuse early with a clear message if there is not enough (`navigator.storage.estimate()`).
- **Direct-to-download streaming (evaluate in Phase 3).** If the TV browser supports service workers, stream chunks straight into a browser download so no second copy is needed. This halves the space and removes the long copy at the end. Fall back to OPFS-then-download if unsupported.
- **Keep devices awake.** Wake Lock on both devices. Warn the user to keep the phone screen on and not to switch apps. Warn about battery drain on the phone while hosting the hotspot.
- **Resume is mandatory** (Phase 4). A 5 GB transfer must never restart from zero after a short drop.
- **Tuning.** Start at 16 KiB chunks. Benchmark 32 and 64 KiB in Phase 3 and keep the fastest setting that is stable on the TV.

## 8. Resume design

- TV IndexedDB store `transfers`: `{fileId, name, size, lastModified, confirmedOffset}`, updated on every ACK.
- After a disconnect, run a normal new pairing (QR scan).
- Phone picks the same file again, so `fileId` matches. Phone sends META.
- TV replies `ACCEPT` with `offset = min(confirmedOffset, actual .part size)`, rounded down to a chunk boundary.
- Phone seeks to `offset` and continues. If `fileId` is unknown on the TV, offset is 0.
- If OPFS or IndexedDB was cleared, restart from 0.

## 8b. Saved TV design (Phase 5b)

Goal: after the first pairing, later sessions need **no QR scan and no confirmation code**. The TV page must still be open on `/tv`, and the few-KB internet handshake still happens.

### Identities

- On first successful pairing (after "Matches"), the TV creates `tvId` = 32 random bytes (base64url) and sends `{t:"SAVE", tvId, tvName}` on the control channel. The phone stores `{tvId, tvName, tvFingerprint}`.
- The phone creates `phoneId` (random) and sends `{t:"SAVE", phoneId, phoneName}`. The TV stores `{phoneId, phoneName, phoneFingerprint}` as a trusted phone.
- Both devices **persist their WebRTC certificate** in IndexedDB (`RTCPeerConnection.generateCertificate`, max expiry) and pass it in `certificates`, so their fingerprints stay stable between sessions.

### Saved-TV session flow

```
TV (/tv, has tvId)                 Vercel API                     Phone (/send)
1. PUT /api/tv  (x-tv-id)  ──────► store offer under hash(tvId), TTL 120 s
   refresh every ~90 s while the page is open
2. Screen: "Ready: waiting for a saved phone"
                                                   3. Open /send, tap "Living room TV"
                              ◄────────────────── 4. GET /api/tv/offer (x-tv-id)
                                                   5. Compare offer fingerprint with saved tvFingerprint
                              ◄────────────────── 6. POST /api/tv/answer
7. Poll answer ◄───────────
8. Compare answer fingerprint with trusted phones
9. Both match → skip confirmation code → channel opens → phone picks the file
```

### Rules

- The server stores only `hash(tvId)`, never `tvId`.
- If both fingerprints match the saved ones → connect with no confirmation code.
- If either fingerprint differs (new phone, cleared storage, certificate renewed) → show the confirmation code and, once "Matches" is tapped, update the saved fingerprint.
- If the TV page is closed, the phone shows "TV not ready: open /tv on the TV".
- Management: the TV has "Forget this phone" and "Forget all". The phone has "Forget this TV". Forgetting rotates `tvId`.
- Rate limit and 409 on a second claim apply here too.

## 9. Phases

Each phase lists tasks and **acceptance criteria**. Do not skip ahead.

### Phase 0: Capability check (DONE: `tv-phase0.zip`)

- Test page for the TV: WebRTC, ICE addresses, data channel, OPFS (worker), IndexedDB, quota, service worker, wake lock, download.
- **Acceptance:** results from the Challenger TV and the phone are collected and reviewed. Decide go / adjust.
- Also record: the loopback speed on the TV (its WebRTC CPU ceiling), service worker support, and whether the TV supports 5 GHz Wi-Fi.

### Phase 1: Project foundation and mailbox

Tasks:
- Create the Next.js project, TypeScript strict, deploy to Vercel.
- Add Upstash Redis through the Vercel Marketplace.
- Implement `lib/server/redis.ts`, `lib/server/rooms.ts` and the five API routes.
- Add rate limiting and expiry.
- Unit tests for room logic (create, claim twice, expiry, wrong token).

Acceptance:
- `curl` flow works end to end: create → get offer → post answer → get answer → delete.
- A second claim returns 409. A room is gone after 120 s.

### Phase 2: Pairing and an open data channel

Tasks:
- `/tv`: create offer, wait for ICE (5 s cap), POST the room, show QR + 4-digit code, poll for the answer.
- `/send`: read `?code=`, with a manual 4-digit entry box as fallback. GET offer, create answer, POST it.
- Confirmation code on both screens, "Matches" button on the phone.
- Open `control` and `data` channels, show "Connected: [device name]" on the TV.
- Status and error screens (expired code, claimed, ICE failed).

Acceptance (on real devices, TV on the phone's hotspot):
- Channel opens from scan to connected in under 10 seconds.
- Connection works with mobile data **off** after the page has loaded and pairing is done (pairing itself needs data).
- Wrong or expired code shows a clear message.
- **Decision gate:** if the `.local` mDNS address cannot be resolved by the phone, or the hotspot interface is not exposed, stop and choose a workaround before continuing.

### Phase 3: Streaming transfer

Tasks:
- `protocol.ts`, `sender.ts`, `receiver.ts`, `opfs-writer.worker.ts`.
- META / ACCEPT / ACK / DONE / COMPLETE flow.
- Backpressure and the 8 MiB window.
- TV finishes with the download handoff.
- Progress, speed, ETA on both screens. Cancel.
- Free-space check on the TV before ACCEPT (2× file size rule).
- Benchmark chunk sizes 16, 32 and 64 KiB on the real TV and keep the fastest stable one.
- Evaluate direct-to-download streaming through a service worker. Use it if the TV supports it, otherwise OPFS-then-download.
- Wake Lock on both devices and a 5 GHz setup tip on the phone.

Acceptance:
- 10 MB, 500 MB, 2 GB and 5 GB files arrive with identical SHA-256.
- Measured speed is recorded for 2.4 GHz and 5 GHz hotspots. Target on 5 GHz: at least 10 MB/s, so 5 GB takes under 9 minutes.
- A file larger than half the TV's free space is refused before transfer with a clear message.
- Browser memory on both devices stays flat (check in `chrome://inspect` or the task manager). No full-file buffers.
- Cancel stops cleanly and removes the `.part` file.

### Phase 4: Resume

Tasks:
- IndexedDB store for transfer state (`lib/storage/transfers.ts`).
- Persist offsets on each ACK. Handle `ACCEPT.offset`.
- Detect a dropped connection (`iceconnectionstate`, channel close), show a "Reconnect" screen on both devices.
- Re-pair, re-select the file, continue.

Acceptance:
- Turn off Wi-Fi at 50%, turn it back on, re-pair: transfer continues from the last confirmed offset and the final hash matches.
- Selecting a different file does not resume (fresh transfer).

### Phase 5: TV and phone UI

Tasks:
- TV: very large type, D-pad focus states, no mouse-only controls, screens for waiting / connected / confirm / receiving / done / error.
- Phone: file picker (and drag-drop where supported), clear errors, keep screen on with Wake Lock where supported, warning not to leave the tab.
- Show free-space check on the TV before accepting (`navigator.storage.estimate()`).

Acceptance:
- Everything usable with the TV remote only.
- Readable from 3 metres.

### Phase 5b: Saved TV

Tasks:
- `lib/storage/trust.ts`: persist certificates, saved TVs (phone side), trusted phones (TV side).
- `SAVE` control messages and the `tvId` / `phoneId` creation after the first confirmed pairing.
- `/api/tv` routes (publish/refresh offer, fetch offer, post/poll answer), storing only `hash(tvId)`.
- TV "Ready" screen with automatic offer refresh. Phone "Saved TVs" list with tap-to-connect.
- Fingerprint pinning checks on both sides and the fallback to the confirmation code.
- Forget / reset controls on both devices.

Acceptance:
- After the first pairing, next day with the same devices: open `/tv` on the TV, tap the saved TV on the phone, and the file starts with no scan and no code.
- A different phone cannot connect silently (it gets the confirmation code or is rejected).
- After "Forget", the old `tvId` no longer works.
- Clearing browser storage on either device sends the user back to the normal QR pairing without errors.

### Phase 6: Offline shell (optional, only if Phase 0 shows service worker support)

Tasks:
- Service worker caching the app shell (Serwist or hand-written).
- Web App Manifest and icons.

Acceptance:
- After one visit, the pages `/tv` and `/send` load with the network off (pairing still needs internet).

### Phase 7: Hardening and tests

- Test matrix: phone Chrome on Android and Safari on iOS, TV browser(s), 2 GB+ file, slow TV storage, hotspot drop, TV sleeping, tab backgrounded.
- Verify **no internet data** during transfer: watch the hotspot data counter or `chrome://net-export`, confirm only the few KB for pairing.
- Security review: code expiry, single claim, rate limit, no SDP in logs, confirmation code path.
- Write the user guide: "How to send a file to the TV".

## 10. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| TV browser lacks OPFS or WebRTC | Blocks the project | Phase 0 test. Fallback: native TV app with a local server |
| mDNS `.local` candidate unresolvable on the hotspot | Connection fails | Phase 2 gate. Fallback: show the TV's IP in the QR and munge the candidate |
| Hotspot interface not exposed to WebRTC | Connection fails | Test on the real phone in Phase 2 |
| TV browser has no download manager | File stays in OPFS only | Test in Phase 0. Fallback: let the user open it through the page |
| Phone tab backgrounded | Transfer stalls | Wake Lock, on-screen warning, resume |
| Guessable 4-digit code | Wrong device claims | One-time claim, 120 s expiry, rate limit, confirmation code |
| TV storage full | Transfer fails | Free-space check before accepting |
| Saved TV: leaked `tvId` | Someone could try to connect | 256-bit random ID, server stores only its hash, fingerprint pinning, confirmation code for unknown phones, rate limit |
| Saved TV: certificate expiry or cleared storage | Saved trust stops matching | Fall back to confirmation code and re-save; use max certificate lifetime |
| Hotspot on 2.4 GHz | 3 to 5× slower transfers | Show a 5 GHz setup tip. Check TV 5 GHz support in Phase 0 |
| TV storage too small for 2× rule | Large file refused | Free-space check, direct-to-download streaming if supported |
| Phone battery and screen sleep during 10+ min transfers | Transfer stalls | Wake Lock, warning text, resume |
| APK files | Cannot install from browser | User opens the downloaded file in a file manager |

## 11. Definition of done

- Phone sends any file type (tested: video, zip, APK, PDF) to the TV.
- Nothing is typed on the TV remote.
- Transfer uses zero internet data.
- Memory stays flat on both devices for multi-GB files.
- A transfer interrupted by a Wi-Fi drop resumes after re-pairing.
- Confirmation code gates every transfer.
- On later sessions, a trusted phone connects to a saved TV with no scan and no confirmation code.
- A 5 GB video transfers on a 5 GHz hotspot in under 9 minutes and can be resumed after an interruption.
- The TV refuses files that will not fit before any data is sent.
