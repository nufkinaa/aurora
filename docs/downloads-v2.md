# Downloads v2

What changed in the download queue in November 2026, and why. elia's report, in his words:

> 1: a lot of them get stuck at 0 data per second and stay there for a long time making other downloads not arrive because they are in queue….
> 2: I think that the next episode for someone is more important then someone's just downloading something else … we can pause other downloads which is lower priority and start the next episode for someone so it will be smooth for all.
> 3: we need to detect when a version just won't download and try and download the second best stream we can….

The code:

| File | What it does |
|---|---|
| `src/media/dlhealth.js` | Is a download alive? Sorts each one into starting, ok, slow, stalled or dead. Pure. |
| `src/media/dlprio.js` | Who goes first: priority classes, ageing, the start plan, "quick", and pre-empting. Pure. |
| `src/media/dlfallback.js` | Which copy to try next, whether the file is the right one, what an aria2 error means. Pure. |
| `src/media/downloads.js` | The queue. It does the I/O and acts on the three modules above. |
| `src/media/aria2.js` | The engine and its options. |

Tests:
- `test/dlhealth.test.js`, `test/dlprio.test.js`, `test/dlfallback.test.js` and `test/aria2-args.test.js` test the rules.
- `test/dlv2-queue.test.js` plays out the whole queue against a fake engine on a fake clock.
- `tools/dl-rig/` runs the real flows against the real aria2 and a BitTorrent swarm that lives on this PC.

---

## 1. Research: what good projects do, and what we took

| Project | What it does | What Aurora takes |
|---|---|---|
| **qBittorrent / libtorrent** | An option, "Do not count slow torrents in these limits" (off by default in qBittorrent). A torrent under **2 KiB/s** down and up, after a **60 s** start-up grace (`inactive_down_rate`, `auto_manage_startup`), stops taking a download slot. It keeps running, so it picks up again by itself. A separate hard cap (`active_limit`) still counts it. `stalledDL` is a single 0 B/s reading with no time window, so it is noisy. `metaDL` means no metadata yet. | **Taken.** A stalled or slow download keeps running in the engine but no longer counts against "Downloads at once". There is a separate ceiling on how many stalled downloads the engine carries (`PARKED_LIVE` = 4). We judge over minutes, never on one reading. |
| **Transmission** | `queue-stalled-enabled` (on) and `queue-stalled-minutes` (**30**). A torrent that has shared no data for that long stops counting against `download-queue-size`. It is not paused. | Same idea, with a shorter clock. 30 min is far too long for a person waiting for an episode. |
| **Sonarr / Radarr** | Failed Download Handling: a failed download is **blocklisted** (title, indexer, info hash), and with **Redownload** on, the next best release is searched for. That release is ranked by quality, then custom-format score, then **`round(log10(seeders))`**, then size, skipping blocklisted ones. Torrent clients almost never report "failed": `stalledDL` and `metaDL` only become *warnings*, so Sonarr never replaces a dead torrent by itself. | **Taken:** the blocklist (`media/badreleases.js` now holds the server's own "dead" and "fake" marks), and moving to the next release in the existing ranking. The seeder count is compared by order of magnitude, as Sonarr does it. |
| **Decluttarr / Swaparr** (they fill the gap above) | They check every **10 min** and need **3 strikes in a row** (`PERMITTED_ATTEMPTS`), so a dead torrent goes after about **30 min**. Decluttarr's jobs: `REMOVE_STALLED`, `REMOVE_METADATA_MISSING`, `REMOVE_SLOW` (under `MIN_DOWNLOAD_SPEED` 100 KB/s between two checks, skipped near the client's speed cap), `REMOVE_FAILED`. Everything removed is blocklisted, then a new search runs. Swaparr strikes a download whose ETA is over `MAX_DOWNLOAD_TIME` (2 h). | Strikes over time, not one reading. Slow is never judged at the speed cap. But our clock is minutes, not half an hour (see §3), and Aurora decides itself instead of an outside tool removing things. |
| **qbit_manage** | Tags stalled torrents (`tag_stalled_torrents`). It does not remove them. | — |
| **aria2** | `bt-stop-timeout` stops a BitTorrent download after N s at 0 B/s, but it ends as a generic error. `lowest-speed-limit` does **not** apply to BitTorrent. `numSeeders` counts *connected* seeders; there is no tracker scrape. `aria2.getPeers` gives each peer's bitfield. On a running download only six options change without a restart; `max-download-limit` is one of them. `pause` drops the peers, and they have to be found again. `bt-detach-seed-only` stops seeding-only torrents from taking download places. `disk-cache` defaults to 16M. `falloc` is instant on ext4. | We left `bt-stop-timeout` off and decide ourselves. Availability is worked out from the `getPeers` bitfields. Pre-empting **throttles** (`max-download-limit`) instead of pausing. Added `bt-detach-seed-only`, `disk-cache=64M`, `auto-save-interval=30` and a fixed listen port. `falloc` is left to the admin (§7). |
| **libtorrent `distributed_copies` / qBittorrent "availability"** | The share of pieces at least one connected peer has. Under 1 means the swarm cannot finish the file at any speed. | **Taken.** It is the strongest "dead" signal. It only counts the pieces of the *wanted* file that we still lack. |
| **Scheduling in general** | Ageing, so low priorities are not starved. Hysteresis, so things don't flap. A minimum run before pre-empting. | All three (§4). |

**Which signals tell "slow but alive" from "dead"?** Never one speed reading.
- **Alive:** bytes of the file keep arriving within a few minutes, even slowly.
- **Dead:**
  - no metadata;
  - nobody to connect to;
  - nothing new for many minutes with no seeder connected;
  - the connected peers don't have the missing pieces (availability under 1).
- **Zombie:** a "seeder" is connected but sends nothing. It gets the longest grace, because it can come back.

---

## 2. Aurora's design before this change (the map)

1. **Create** (`downloads.create`). Checks: torrents on, a hash, a library folder, aria2 installed, "already in the library" (films), dedupe on the exact hash and file, and the disk gate. The job is then `approved`, or `pending` for an admin when the disk is tight.
2. **Queue** (`pump`). Uses `dlslots.plan`: a person's request first, then automatic ones, newest first within a tier. It runs up to "Downloads at once" (1–6, default 4), 2 while anyone is watching, and 3 per account. **Every running job counted**, stalled or not.
3. **Run** (`startJob`, then `aria2.add`). Waits up to **5 min** for a magnet's details, then fails. A poll every second (`aria2.tellStatus`) does the progress, and the file being complete is the win (`claimWin`). Then it is copied into the library (`completeJob`), with no-clobber landing, subtitles, cover, scan and notifications.
4. **Slow** (`dlrace.js`). A second source of the same resolution is raced against a slow one. Blocked whenever anyone watches, a stream plays, the line is busy, the speed cap is reached or another race runs. At most 2 challengers per job.
5. **Stuck** (healer, every 60 s). No details or first byte after **12 min**, or no progress for **15 min**, leads to `restartJob`: the job goes back into the queue **with the same source**.
6. **Failure.** Any aria2 error, or no details in 5 min, led to `fail()`: status `error`, an ntfy alert, done.

## 3. Bugs and edge cases found (before → now)

Line numbers are on `origin/master` at 72602eab.

| # | Where | What was wrong | Now |
|---|---|---|---|
| 1 | `lib/healer.js:59-60,397`, `media/downloads.js:1894` | A dead copy was "restarted" by the healer every 12–15 min **with the same copy**, back into the same slot, for ever. | The healer only reports. The queue parks the download after 3–4 min and moves to the next copy when it is dead. |
| 2 | `media/downloads.js:672-676` | Every running job held a "Downloads at once" slot, including one at 0 B/s. With someone watching (a cap of 2), two dead downloads held the whole queue. This is elia's report #1. | Only downloads that are alive count (§4). |
| 3 | `media/dlslots.js:97`, `downloads.js:676` | Three episodes of one season pack (one torrent) took three slots, and three of the account's three. | A torrent counts once, for the slots and for the per-account limit. |
| 4 | `media/dlslots.js:69` | Newest request first within a tier: a steady flow of new requests could keep an old one waiting indefinitely. | The one that has waited longest goes first, plus ageing across classes. |
| 5 | `media/aria2.js:236`, `downloads.js:1118,1147` | No magnet details in 5 min failed the job outright, with no other copy tried. | The stall rules decide, and a dead copy moves to the next one. |
| 6 | `media/dlrace.js:231` | The second-source race never runs while anyone watches, which in a household is most evenings. So a dead copy at prime time was never helped. | The fallback does not depend on anyone watching. The race is unchanged and still runs first when it may. |
| 7 | `media/downloads.js:1281` | **Disk full** mid-download (aria2 error 9) failed the job and sent an alert. Retrying would fail again, and nothing came back by itself. | The job is held as "waiting" with its bytes and carries on by itself when there is room. No other copy is tried. |
| 8 | `media/aria2.js:283` | `select()` read the file selection, added one file and wrote it back. Two episodes of one pack joining in the same moment could drop the first, which then sat at 0% for good. | Changes are queued one at a time per download. |
| 9 | none (there was no check) | A torrent's listed file could be a **sample**, an extra or another episode. A **fake** (a `.exe`, a `.rar`, random bytes named `.mkv`) was downloaded and put in the library. | The file list is checked at first sight: the right file is taken, or the copy is marked fake and the next one tried. Before anything lands, ffprobe checks that the finished file is a video. |
| 10 | `media/downloads.js:81` (and the healer's `Date.now`) | Every stall timer ran on the wall clock. A clock jump (NTP after boot, a restored VM) made every running download look stuck for that long in one tick. | Stall and race timers run on a monotonic clock (`performance.now`). |
| 11 | `media/downloads.js:1232` | The speed shown was the *whole torrent's* instant speed. Each episode of a pack showed the pack's speed, and "N min left" (worked out by the clients from it) was wrong and jumpy. `sizeBytes` stayed the listing's guess, sometimes the whole pack's size. | The speed is this file's share, smoothed over about a minute. `sizeBytes` becomes the real file size once known. There is a new `etaSec`, which the website and TV use. |
| 12 | `media/downloads.js:448-449` | "Already in the library" for films compared titles only. A remake or another film with the same name was refused. | The IMDb ids must match when both are known. |
| 13 | none | The same episode asked for twice from two *different* copies (two people, or a person plus smart downloads) downloaded it twice and kept both. | The same title at the same resolution joins the download already on its way. The second person is told when it lands, and a person's request makes a smart download theirs, so it is not tidied up. |
| 14 | `media/downloads.js:826` | The finished file was **copied** from staging into the library: a second full write of a 15 GB film at the very end, needing twice its size free. | On Linux, same volume: a hard link (instant, no second copy). Windows keeps the copy. |
| 15 | `media/downloads.js:1966` | After a restart every job's progress was reset to 0, so the disk gate counted the full size of half-finished downloads again. | Progress is kept (aria2 continues from the bytes anyway). |
| 16 | `media/aria2.js:271,344` | Looking up a torrent read only the first 50 waiting downloads. | 1000. |
| 17 | `media/aria2.js` args | Seeding-only torrents could hold engine places (no `bt-detach-seed-only`). The write cache was the 16M default, the resume file was saved every 60 s (a kill lost up to a minute of every download), the listen port was random, and aria2's console readout put a line per download per second into the server's log. | Fixed (§7). |
| 18 | `media/downloads.js:1281-1290` (found on the rig) | With `--seed-time=0` aria2 reports a **complete** download with `completedLength` **0** for its files. A download that finished between two one-second polls read as 0%, never "won", and sat there; the healer restarted it every 12 min. On a fast line this is common — and it looks exactly like "stuck at 0 B/s". | `status: "complete"` counts as the file being in. |
| 19 | (found on the rig, in the new code before release) | "S01E02.1080p" read as a double episode E02–E108. | Fixed and tested. |

Edge cases checked, with where they are covered:

- **Restart or crash:** the copies tried, the bytes set aside, the wait before retrying and the urgency all survive. A restarted job gets a fresh grace and starts once. Covered in dlv2-queue ("a restart after a switch") and the rig (a restart mid-download).
- **aria2 dying:** the poll sees the download gone, the job is queued again and re-joins from its bytes. This is existing behaviour, and the rig kills the engine.
- **The same title asked twice:** #13.
- **Disk full / low disk:** #7. The disk gate also checks the next copy before switching to it.
- **Very large season packs:** one slot (#3); the wanted episode found by its SxxEyy; a pack listed with the whole pack's size is not called "too small".
- **Multi-file torrents, samples, fakes:** #9.
- **Cancel during prepare:** unchanged and still covered. A switch in progress checks after every wait that the job is still wanted.
- **Replacement while watched:** unchanged (`replace.land`). A replacement's fallback never takes the copy it is replacing.
- **Time jumps:** #10.
- **Clean-up of failed partials:** a copy given up on loses its staging bytes unless they are worth resuming. Bytes set aside go when the job ends any way. The healer's staging sweep knows about bytes set aside.
- **Progress and ETA:** #11.
- **Seeding etiquette vs disk and bandwidth:** Aurora uploads while it downloads (that is how a swarm trades) and stops the moment the file is complete (`seed-time=0`). Seeding-only torrents never take a download place.

---

## 4. The new design

### 4.1 Stall rules (`media/dlhealth.js`, all in `DEFAULTS`, overridable via `config.json` `"downloadHealth"`)

| Signal | Stalled (stops holding a slot) | Dead (moves to the next copy) |
|---|---|---|
| No torrent details (metadata) | 3 min | 10 min |
| Details in, nobody to connect to | 3 min after the details | 8 min |
| Connected, no new bytes, **no seeder** connected | 4 min | 12 min |
| Connected, no new bytes, a "seeder" connected (zombie) | 4 min | 20 min |
| The connected peers don't have the missing pieces (availability < 1, checked every 30 s while stalled) | — | 6 min |
| **Slow:** under 48 KiB/s (smoothed) for 3 min, after a 2 min grace | Stops holding its slot **only if the line and the admin's cap have room**. Never dead. | — |

- **Hysteresis:** a stalled download only counts as healthy again after 2 MiB of new bytes, or 96 KiB/s.
- **Clock:** every timer is monotonic.

### 4.2 What "running at once" means now

"Downloads at once" (admin, 1–6, default 4; 2 while someone watches) counts the downloads that **hold a slot**:
- every running download except one that is **stalled** or **dead**, or **slow while the line has room**;
- **one torrent counts once**: a season pack fetching three episodes is one slot, for the per-account limit of 3 too;
- a download held back for a "watching now" episode still counts (it is only paused for a moment).

Not counted:
- A stalled download stays in the engine, still looking for peers, so if a seeder comes back it simply carries on.
- At most 4 *slow* downloads stop counting at once; any more slow ones count again, so a day when every copy is slow does not start the whole queue at once.
- The engine carries at most **4 stalled downloads** (`PARKED_LIVE`) beyond that. Past that, the one stalled longest comes out and tries again in 10 min, or moves to its next copy if it is already halfway to dead.
- aria2's own limit (`max-concurrent-downloads`) is the setting + 2 for magnet details + 4 parked + 2 "watching now" + the race.

No cap on what a person may ask for. This only schedules how many download at once.

### 4.3 Priority classes (`media/dlprio.js`, `"downloadPriority"`)

| Class | Label | What it is |
|---|---|---|
| 0 | **Watching now** | The next episode of a show someone is watching right now, or a download being streamed while it lands |
| 1 | **Asked for** | A person's Download / Save & watch / Get another version / Try again |
| 2 | **Next episode** | Smart downloads' next episode, for later |
| 3 | **Background** | A followed show's new episode; what My List left |

- **Ageing:** a waiting job moves up one class per **30 min** waited, never past "Asked for". Within a class, whoever has waited longest goes first.
- **Watching now starts at once:** past the cap, past the 2-while-watching hold and past the per-account limit, up to **2** past the setting.

**Where "next episode" comes from:**
- **Progress reports.** While an episode plays, every progress report makes its next episode urgent if it is in the queue: the next number, else S+1 E1. It stays urgent until 20 min after the episode would end (`smartdl.onProgress`).
- **Smart downloads.** When smart downloads queue the next episode at 65%, it is urgent right away.
- **The player's Up next.** `GET /api/next-episode` answering a not-on-disk episode marks it urgent for 45 min.

### 4.4 Pre-empting: "pause the others for the next episode"

A "watching now" download that is **quick** holds every lower-class running download back to a 24 KiB/s trickle. This uses aria2's `max-download-limit`, which changes on a running download without a restart, so the download keeps its peers and its place. A pause would drop the peers.

The download is held until the quick one is in, then let go. "Quick" means all three of:
- the remaining size is **≤ 1.5 GB**;
- the source list has **≥ 10 seeders**;
- the estimate is **≤ 6 min** at min(this line's recent best speed, seeders × 300 KiB/s), with 8 MB/s assumed before the line is measured.

It never lasts for ever:
- It ends when the quick download finishes, fails, is cancelled or stalls, or when nobody is waiting for it any more.
- After **90 s** its *live* speed is checked. An ETA over **15 min** means it was not quick: the hold ends and that download does not hold anyone again (hysteresis).
- **12 min** at most per hold, then a **2 min** cool-down before another.
- A person's own download is held for at most **20 min in any 2 hours**, then left alone. Automatic ones can always be held.
- A download on the *same torrent* (a sibling episode) is never held.
- Only one download holds the others at a time.

### 4.5 Falling back to the next-best copy (`media/dlfallback.js`)

**When:**
- a copy is **dead** (§4.1);
- the engine **failed** it (any error that is not "disk full" or "already in the engine");
- its file list shows it is a **fake** (a program, an archive, no video, only a sample, not this episode);
- ffprobe says the finished file is not a video (damaged, no picture, a short small sample).

**What happens:**
1. **It is remembered.**
   - On the blocklist (`media/badreleases.js`) with reason `dead` (expires after 3 days, because swarms come back) or `fake` (for good), marked `auto` (by the server).
   - The source memory (`sourcememory.js`) gets "stalled" or "failed", which nudges the ranking.
   - A person's own report is never overwritten by a server mark.
2. **Its bytes are kept** if worth resuming (≥ 200 MB or ≥ 5% of the file) and the copy was dead rather than fake. Otherwise the staging folder is purged unless a sibling still uses it.
3. **The next copy** comes from the existing source search and ranking (`torrent.getSources`, the ★ BEST order, which already has the blocklist and learned history applied):
   - **Never:** a copy already tried, one blocked here, a cinema or other pre-release copy, a dub (unless the original was one), burned-in subtitles (unless nothing clean is left), the copy a replacement replaces, the wrong size (under ¼ or over 3× the original), no listed seeders, or a file another download is fetching.
   - **Quality:** the **same resolution** first, then one step down, then one step up only if at most 1.5× the size.
   - **Within a step:** seeders by order of magnitude, then the list's own ranking. A season pack already downloading for a sibling episode goes before everything.
   - **Language:** the person's language and quality come from the original request. A "Wrong language" replacement keeps its rule.
4. **It switches in place.** Same job, same slot, same place in the queue. The disk gate is checked for the new copy first.
5. **It says so on every client:** "No one was sharing that copy — now trying another (1080p · 1.4 GB)".

**Limits:**
- At most **4 copies per job** (`MAX_SOURCES`).
- With no copy left, the job leaves the engine and **waits**: 15, 30, 60, 120 and then 240 min (5 rounds, about 7¾ h for a person's download; 3 rounds, 1¾ h, for an automatic one). Each round tries the copy it has the most bytes of, else the next of those it tried, with a fresh source lookup on the way.
- Then it **fails, in words**: "No one is sharing this right now — tried 3 copies over 7.8 h. Try again later." The ntfy alert is only sent then, once.

### 4.6 What the person sees (the same sentence on the website, TV and phone)

| Situation | Status line (`note`) |
|---|---|
| Stalled, no peers or details | No one is sharing this copy right now — still looking |
| Stalled, connected but nothing arriving | Nothing is arriving from this copy right now — still trying |
| Slow, not counted | Slow copy (about 30 KB/s) — other downloads go ahead meanwhile |
| Moved to another copy | No one was sharing that copy — now trying another (720p · 1.1 GB) / That copy was fake or broken — now trying another … / That copy failed — now trying another … |
| Waiting between rounds | **Waiting for a copy** · No one is sharing any copy of this right now (2 copies tried) — trying again in about 30 min |
| Held back | Paused for a moment — an episode someone is watching goes first |
| The quick one | Going first — someone is watching the episode before it |
| Disk full | Waiting for approval — The disk is full — this download carries on by itself when there is room again on /library. |
| Gave up | Failed — No one is sharing this right now — tried 3 copies over 7.8 h. Try again later. |

---

## 5. For the admin screen

Everything is in the **existing** API:
- `GET /api/downloads`: every job, the same shape the admin page already reads.
- The `download_update` and `download_new` websocket messages.
- `slots` in `GET /api/admin/aria2-limits`, from `downloads.slots()`.

These fields are **new on every job** (`publicJob`):

| Field | Type | Meaning | Suggested label |
|---|---|---|---|
| `note` | string \| null | The plain sentence about what is going on (§4.6). Only on live jobs. | Show it as the job's second line, as written. |
| `priority` | `{ cls: 0–3, base: 0–3, label, urgent }` \| null | The class it is in now, after ageing (`cls`), and the class it was asked in (`base`). `label` is one of "Watching now", "Asked for", "Next episode", "Background". `urgent` is `cls === 0`. Live jobs only. | A small tag: **Watching now** (accent colour), **Asked for**, **Next episode**, **Background**. |
| `health` | `{ state, code, why, countsAsRunning, since }` \| null | Only while `status === "downloading"`.<br>`state`: `starting` \| `ok` \| `slow` \| `stalled` \| `dead`.<br>`code`: `finding`, `ok`, `slow`, `no-meta`, `no-peers`, `no-bytes`, `zombie`, `unavailable`, `recovering`.<br>`why`: in words ("no one is sharing it right now").<br>`countsAsRunning`: false when it does not count against "Downloads at once".<br>`since`: ISO time of the last change. | `starting` → **Starting**, `ok` → (nothing), `slow` → **Slow**, `stalled` → **Stalled — not counted**, `dead` → **No one sharing it — switching**. `why` as the tooltip or second line. |
| `sources` | `{ tried, max, retries, given: [{ infoHash, release, quality, why }] }` \| null | Present once a copy was given up on.<br>`tried`: the copy it is on now (1-based).<br>`max`: 4.<br>`retries`: waiting rounds so far (out of 5 for a person's download, 3 for an automatic one).<br>`given`: the copies given up on and why. | **Copy 2 of 4**, with a list "Gave up on: Film.2020.1080p.WEB (no one was sharing it)". |
| `heldBack` | `{ since, for }` \| null | Held to a trickle while `for` (the label of a "watching now" download) goes first. | **Paused for "Show · S2 E3"** |
| `retryAt` | ISO string \| null | `status === "approved"` and waiting until then before trying again (no copy could be found). | **Waiting for a copy — tries again at 21:40** |
| `etaSec` | number \| null | Time left, in seconds, at its recent smoothed speed, for this file only. | **12 min left** |

`downloadSpeed` is now **this file's** share of the torrent's speed, smoothed over about a minute. It used to be the whole torrent's instant number.

`sizeBytes` becomes the real file size once the torrent's details are in.

`slots` (in `GET /api/admin/aria2-limits`) gains these fields:

| Field | Meaning | Suggested label |
|---|---|---|
| `counted` | Downloads counting against the setting right now (a pack counts once) | **3 of 4 running** |
| `notCounted` | Running but not counted (stalled, or slow with room on the line) | **+ 2 stalled, still looking** |
| `parkedLive` | How many stalled ones the engine keeps looking (4) | (info) |
| `nowExtra` | How many "watching now" may run past the setting (2) | (info) |

The healer's "Download queue" check also reports these:

| Field | Meaning |
|---|---|
| `stalled` | Number of downloads stalled or dead |
| `slow` | Number of slow downloads |
| `notCounted` | Running downloads that are not counted |
| `heldBack` | Downloads currently held back |
| `preempting` | The job id going first, or null |
| `retrying` | Downloads waiting between rounds |
| `healthManaged` | Always true: the queue handles stalls itself |

This check's detail says, for example, "“Film” no torrent details after 14 min — the queue is handling it (stalled, not holding a slot)" instead of restarting it.

A blocklist entry the server filed (`data/badreleases.json`) carries:
- `auto: true` and `byName: "Aurora"`;
- `why`: `"dead"` (label "No one was sharing it", plus `exp`, the time it expires, 3 days on) or `"fake"` (label "Fake or broken file").

The admin's lists can show these like a person's report, with the label from `reasonLabel`.

---

## 6. Tests

| Suite | What it covers |
|---|---|
| `test/dlhealth.test.js` (8) | Every stall rule, hysteresis, availability from bitfields |
| `test/dlprio.test.js` (11) | Classes, ageing, the start plan (packs once, NOW past the cap, per account), quick, live check, victims, the held-time window |
| `test/dlfallback.test.js` (14) | The next copy, the right file, samples, fakes, ffprobe, engine errors |
| `test/aria2-args.test.js` (4) | The engine's options from `downloadEngine` |
| `test/dlv2-queue.test.js` (15) | The whole queue on a fake engine and a fake clock: stalled stops counting, dead → next copy, wait and retry then a plain failure, bytes kept and resumed, disk full, a fake, a sample, an ffprobe fake, pre-empting and its fairness, the same title twice, a restart after a switch, the monotonic clock, "complete with 0 bytes" |
| existing queue tests | `dlrace-queue`, `dl-landing`, `mylistdl-queue` and `replace-version` stub the ffprobe check and the source lookup; a failed replacement plays out its waiting rounds |
| `test/ui/downloads.test.js` | The sentence on the card, "Waiting for a copy", the server's time left, no trickle speed while held back — desktop and phone width |

## 7. Faster: the engine on nufurora (2.5 Gbit, NVMe, 8 cores)

These options are always on now, with no config needed:

| Option | Effect |
|---|---|
| `--bt-detach-seed-only=true` | A seeding-only torrent never holds a download place |
| `--disk-cache=64M` | Fewer, larger writes |
| `--auto-save-interval=10` | A kill or crash loses at most ~10 s of a download (the default 60 s lost a third of a 300 MB download on the rig) |
| `--show-console-readout=false` | No progress line per download per second in the server's log |
| a clean stop asks aria2 to stop itself (`aria2.forceShutdown`) | Its resume files are written on the way out (best effort; the 10 s save covers the rest) |
| no copy at the end on Linux (§3 #14) | A finished film appears in the library instantly, with no second write of its whole size |

Recommended `config.json` for nufurora:

```json
"downloadEngine": {
  "listenPort": 51413,
  "peerSpeedTarget": "50M",
  "fileAllocation": "falloc"
}
```

- **`listenPort` 51413:** open **TCP and UDP 51413** in the server's firewall (netcup has none by default; ufw or nftables if set up). Peers that cannot be called themselves can then call us, which is often half of a public swarm. aria2 does no UPnP. The DHT listens on the same port (UDP).
- **`peerSpeedTarget` "50M":** aria2 keeps looking for more peers while a torrent is under 50 MB/s, instead of stopping at 10 MB/s. On a 2.5 Gbit line, 10M stopped the peer hunt early.
- **`fileAllocation` "falloc":** instant on ext4/xfs. The space is reserved up front, so a full disk shows at the start instead of in the middle, and files are not fragmented. **Measure once before turning it on:** with a season pack where only one episode is selected, check with `du -sh` on the staging folder that only that episode's space is reserved.
- Optional: `"trackers": [ … ]` adds announce URLs to every torrent (for example ngosang/trackerslist `trackers_best`). The built-in list in `torrent.js` already covers this; refresh it there when discovery degrades.

**aria2 must be restarted** for engine options to take effect. A server restart does it, because the daemon is the server's child and is started with these arguments.

## 8. Rig results

The rig is `tools/dl-rig/`:
- `swarm.js`: a tracker and seeders on 127.0.0.1. Seeders can be fast, slow, stop at a fraction (a zombie that stays connected), leave, serve corrupt pieces, or appear later.
- `aria2-smoke.js`: the real aria2 against that swarm.
- `run.js`: a private instance of this tree under its keeper, with its own aria2 (no DHT, no PEX, only the rig's tracker).

The content is random bytes after a real one-frame-per-second MKV header, so ffprobe sees a long video. Nothing left the PC. The production rules applied; the second-source race was off, so what is measured is the fallback.

**A copy that will not download.** Seven titles at once, each with a bad first copy and a good second one. Times are from the moment the download started.

| First copy | Stopped counting as running | Switched to the next copy | Next copy landed |
|---|---|---|---|
| A program (.exe) where the film should be | — | 3 s | +5 s |
| Random bytes named .mkv (caught by ffprobe) | — | 5 s after its bytes were in | +5 s |
| Nobody sharing it (no details) | 3:00 | 10:00 | +6 s |
| Details in (cached .torrent), nobody to connect to | 4:03 | 8:03 | +8 s |
| Only a liar serving corrupt pieces | 4:03 | 8:05 | +6 s |
| The seeder leaves at 25% | 4:11 | 11:08 ("the people left don't have the file"); its 15 MB kept, cleaned when the job ended | +5 s |
| A zombie seeder that stops at 10% | 4:06 | 12:28 | +5 s |

- Every title ended with the **right bytes** in the library (checksums), and **none** of the bad copies' bytes.
- All seven were one person's, so the 3-per-account limit applied. Titles 4–7 started the moment earlier ones stalled (at 3:01, 4:04, 4:12, 4:20). Before, they would have waited for good.

**Slow but alive.** "Downloads at once" = 1: a copy at 30 KiB/s, with a fast one queued behind it.
- With the first rule (slow after 3 + 5 min) the fast one started **8:00** later. With the rule now in the code (2 + 3 min) it started **5:00** later and landed 4 s after that.
- The slow one kept downloading ("Slow copy (about 30 KB/s) — other downloads go ahead meanwhile"), was never called dead, and kept its bytes.

**The next episode while others download.** A 4 MB/s cap, two 1 GB films, and a 100 MB episode, three at once.

| The episode as… | Arrived in |
|---|---|
| a person's ordinary download (the control) | **134 s** |
| the next episode of a show being watched (one progress report for S01E01) | **31.3 s** |

- The films were held to a trickle ("Paused for a moment — an episode someone is watching goes first") and let go the moment the episode was in.
- Both films were still running at the end.

**Restarts.** A 300 MB film at 3 MB/s, interrupted at 30%.

| How | Back after | Carried on from | Jobs for the title | Right bytes, staging cleaned |
|---|---|---|---|---|
| Clean restart (keeper) | 6.6 s | 27% | 1 | yes |
| aria2 killed | at once | 21% (≤ 10 s lost: the resume-file interval) | 1 | yes |
| Server crash (killed; the keeper restarts it) | 6.2 s | 31% | 1 | yes |

Before `--auto-save-interval=10` the same runs came back at **7%** (clean restart) and 10–18% (aria2 killed).

**A season pack.** Three episodes, a sample and an .nfo. All three were asked for in the same instant, with episode 2 listed with the **sample's** file index. All three landed with the right bytes, and the sample never reached the library. This run is what found the "1080p read as an episode range" bug (§3 #19); it was fixed and re-run.

**What aria2 itself does** (`aria2-smoke.js`):
- Metadata from a live seeder in 2.1 s; the first byte 1.2 s later.
- **No dead scenario ever errors.** No seeder, a zombie, a seeder that left, a liar: all stay "active" for ever. The queue has to decide.
- `downloadSpeed` is smoothed over about 10 s; `completedLength` is the signal to watch.
- A zombie looks exactly like a healthy idle seeder (`seeder: true`, speed 0). aria2 drops it after about 60 s and accepts it straight back.
- `max-download-limit` takes hold in 0.2 s and lets go at once, with the connection kept. `pause` drops every peer.

---

## 9. downloads-next (2026-11-06): the language check and "Tell me when it's ready"

### 9.1 The language check (`media/langcheck.js`, called from `completeJob` before anything lands)

Niso reported a copy in the wrong language; the replacement Aurora picked named no language in its title, so it could land in the wrong language again. Now the finished file's audio tracks are read with ffprobe (`seams.probe` also returns each audio track's `language` tag and `title`) before it is swapped in or copied to the library.

What a track says: its **title** when it names a language ("Russian Dub" beats a tag "eng"), else its **tag** ("und" says nothing). The release name counts too.

| Verdict | When |
|---|---|
| right | a track is in a wanted language; or a track says nothing and the release name names a wanted language |
| wrong | every track says its language and none is wanted (and the name does not claim one); with nothing to look for, every track is in the replaced copy's language |
| unknown | no audio read, untagged tracks, or tags and name disagree |

**"Wrong language" replacement** (`replaces.lang` = `{ want, wrong }`, stored at request time from `copylang.fitFor`):
- right → swapped in.
- wrong → not swapped in. The copy is filed in `badreleases` (reason `language`, `auto: true`, no expiry) and the 1.15.9 fallback moves to the next copy, inside the same slot. Copies whose **name** says a wanted language go first; ones naming another language are skipped. Note: "That copy was in English, not Hebrew — now trying another (1080p · 2.1 GB)".
- unknown → swapped in; the person is told "This copy doesn't say its language — report it again if it's wrong." (`publicJob.langLine`, in the in-app notice and the push).
- every copy that could be found was wrong → it fails in words ("No copy in Hebrew could be found — the 2 copies tried were in another language. Try again later."); the old copy stays. A copy found wrong is never fetched again by the waiting rounds.

**Any other download** — only when the person's profile has `prefs.audioLang`, the title's original language is known (TMDB, cached or 2.5 s) and the file's tracks say their language. Wanted = the person's language **or** the title's own (a Hebrew speaker's English film in English is right).
- wrong with another copy available → the next copy, as above.
- wrong with no other copy → it lands as it is (a whole download thrown away for nothing is worse) and says "This copy is in Russian — no copy in English was found."

### 9.2 "Tell me when it's ready"

- When a download a person **asked for** lands (not a smart download nobody asked for), the website, the TV and the phone show a notice with the server's sentence: `publicJob.readyLine` ("“Film” is ready to watch" / "The new version of “Film” is in — ready to watch") plus `langLine` when there is one. `public/js/readyNotice.js` and `tv-native/src/readyNotice.ts` compose it word for word (`test/ready-notice.test.js`).
- Web Push (`lib/push.js`, only to devices that switched it on) follows the same rule. Never ntfy (that is the admin's channel).
- Opt-out per person: Settings → "Tell me when it's ready" (`prefs.readyNotice`, a person switch in `profiles.js` `PREF_SWITCHES`, synced by personPrefs / personSync). Off silences the notice, the push, and the TV's / phone's own notification; what the language check found is still said. The website's browser-notification row is now called "Notifications on this device".
