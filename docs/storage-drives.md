# Storage drives

*2026-11-08 · `src/lib/drives/` · admin → Downloads → On disk*

elia: "I want aurora to automatically find drives like that and distribute
content automatically between them, of course only after the admin selects
the drive in admin and presses use that drive too, and aurora will create
everything we need on that drive."

## What the admin sees

Under **Downloads → On disk** there is one card for each drive the server can see:

- **the name and mount point**, and whether it is local or network;
- **a bar**: Aurora's files, everything else, and free space, each in GB and %. Aurora's share is counted in the background (a child process, every 6 hours, and right after the drive is put to use), never while you wait (see *Aurora's share of a drive*);
- **the speed score** (below);
- **its state and buttons**:
  - **In use**: Aurora keeps films or shows there. Buttons: **Stop using for new downloads** (or **Use for new downloads again**) and **Test again**.
  - **Not in use**: **Use this drive too**.
  - **Not answering**: a network drive that stopped answering, how long ago, and how many titles can't play.

The **Disk line** of the summary, and the headline of the Downloads screen, count all the drives that take new downloads together (e.g. "1.1 TB free on 2 drives"). A drive that is not answering is listed under **Needs you**.

**Copy for Claude** on *On disk* starts with a table of the drives: state, use, Aurora's share, free space, score and mount options.

## Which drives are found

- **Linux**: `/proc/self/mountinfo`, falling back to `/proc/mounts`. Real file systems only: ext2/3/4, xfs, btrfs, zfs, f2fs, ntfs, exfat and vfat, plus the network ones (nfs, nfs4, cifs/smb3, sshfs, rclone, glusterfs, ceph, 9p).
  - The system's own mounts are never offered: `/boot`, `/boot/efi`, `/proc`, `/sys`, `/dev`, `/run` (but `/run/media/…` is), snaps, and docker/containers layers. Nor are tmpfs, overlay or squashfs.
  - One device is listed once, under its shortest mount point. For example, a bind mount of the root disk is the root disk.
- **Windows**: the drive letters (fixed, removable, network). A CD drive or an empty card reader is not listed.
- A drive counts as **in use** when one of the configured library folders is on it. The card also says whether it holds Aurora's data folder or the download staging folder.

## "Use this drive too"

After you confirm, Aurora:

1. checks the drive answers;
2. makes `<mount>/Aurora`, `<mount>/Aurora/Movies` and `<mount>/Aurora/Shows`, unless they exist already. This runs in a child process with a deadline;
3. checks it can write there: it creates a test file, writes it, fsyncs it, renames it, reads it back and deletes it. These are the same steps a landing download takes;
4. adds the two folders to `libraries.movies` / `libraries.shows` in **config.json**, safely:
   - it reads the file as it is on disk now, so a hand edit is kept;
   - it keeps a copy as `config.json.before-drive-<time>` (the 5 newest are kept);
   - it writes a temp file, fsyncs it, and renames it over config.json;
5. takes the folders into the running server at once (no restart) and rescans;
6. measures Aurora's share, and runs the speed check.

Nothing already on the drive is moved or deleted, ever. **Stop using for new downloads** only means no new download is sent there. What is on the drive stays, and plays. To stop using a drive completely, take its folders out of config.json by hand and restart.

## Where new downloads go

This is `lib/drives/rules.js` `pick`; the detail is in docs/downloads-v2.md §10.

1. Only drives that take new downloads and are answering are considered.
2. A show's new episode goes to the drive where the show already has its folder, if that drive has room. That keeps seasons together.
3. Otherwise Aurora picks among the drives **with room**. "Room" means: the free space, minus what is already on its way there, minus this file, is still at least the **reserve**. The reserve is 10% of the drive or 50 GB, whichever is smaller.
   - Drives with at least 75% of the roomiest drive's free space count as equals, and **the fastest of them wins**.
   - So a big new drive fills up first, instead of the nearly full one, and speed decides between drives that are about as roomy.
4. If no drive has room, the roomiest one is chosen, and the download waits for the admin, the same way it always did with one drive.

Staging (aria2's folder) stays on the local disk. A finished file is copied onto a network drive under a hidden temp name and then put in place, so nothing half-written is ever seen.

Existing files are never moved automatically. A "Move" button may come later.

## The speed check and the score

The check runs when a drive is first put to use (or first seen in use), and again on **Test again**. It never runs while somebody is watching: it waits and tries again every 5 minutes. It runs in a child process. Its test file is written in Aurora's folder on that drive and deleted afterwards.

**It is bounded by its time, for real.** A local disk gets up to 256 MB and 18 s; a network drive up to 128 MB and about a minute (the server waits 90 s for it). Every step has its share of the time and stops when that is used, keeping what it measured. The card then says **partly measured** and which step was cut short. Writes are synced every 8 MB (network) or 16 MB (local), so the time counted is what reached the drive. (Before 2026-11-09 the whole file went into memory at once and one long sync at the end waited on all of it: on the NFS volume that ran past the deadline, the child was killed, and its 256 MB test file stayed behind as "Aurora 256 MB".)

The steps:

- **Sequential write**: random data (a compressing or deduplicating server can't cheat — `dd if=/dev/zero` on the NFS volume showed 585 MB/s, more than its 2.5 Gbit link can carry).
- **One direct reader** (Linux, `dd iflag=direct`): the drive with no page cache and no read-ahead. Kept as a detail: on a network drive one synchronous reader is bound by round trips (22 MB/s on the NFS volume with rsize 64 KiB).
- **One buffered reader**, the file's cache dropped first (`dd iflag=nocache`, fadvise DONTNEED): what one viewer's stream gets, with the system's read-ahead.
- **Four readers at once**, each on its own quarter of the file with its own handle, cache dropped first: what a house watching together gets. **This is the network drive's figure.**
- **Small random reads**: 4 KB at random places, which is what seeking does, up to 400 of them or 4 s. This gives the rate per second and the median time per read, the **latency**.

On Windows there is no dd: the reads come right after the write and may come partly from memory, and the tooltip says so.

If the check is still stopped at its deadline (the child is killed), what it measured up to then still counts: the child writes a progress line after each step, and the server keeps the last one. The killed check's test file is deleted by the server right after (the files carry the child's pid), and once at every start of the server. A speed check that runs out of time never marks the drive **Not answering**: the drive is asked with the normal health check instead.

### The score of a local disk

**0–100**. Each figure is put on a log scale between "too slow to stream from" and "as fast as anything in a house":

| part | 0 at | 100 at | weight |
|---|---|---|---|
| sequential read (direct) | 5 MB/s | 1000 MB/s | 45% |
| sequential write | 5 MB/s | 500 MB/s | 25% |
| random 4K reads | 50 /s | 20 000 /s | 15% |
| latency (median) | 50 ms | 0.1 ms | 15% |

The word is **Fast** at 70 or more, **Good** from 40 to 69, and **Slow** below 40. The card also shows "about N 4K streams at once": the read speed divided by 12.5 MB/s.

### The score of a network drive

A network drive is never as fast as an NVMe and does not need to be. Its score says **whether the house can watch from it**:

- The figure is the **four readers together** (else one buffered reader, else the direct one, else the write speed when the reads were cut short).
- **30% is kept back** for seeking, a download landing and the library scanner.
- A 1080p web copy is about **1.5 MB/s**; a 4K remux up to about **10 MB/s**.
- The card says: **"about N 1080p and M 4K streams at once"**.

| word | when |
|---|---|
| **Fast** | 10 or more 4K streams at once |
| **Good** | 3 or more 4K streams at once — good enough to watch from |
| **Fine for 1080p** | 3 or more 1080p streams, fewer than 3 4K |
| **Too slow** | fewer than 3 1080p streams |

The number is the usable MB/s on a log scale, 1.5 MB/s → 0 and 150 MB/s → 100, so Good starts near 65 and Fast near 91.

## Aurora's share of a drive

Counted in a child process every 6 hours: the bytes Aurora's files take **on the disk** (allocated blocks, as `df` counts them — a torrent left half-done in staging is mostly holes). Each file is counted **once**, however it is reached: a hard link between staging and the library, a folder inside another of Aurora's folders, the same folder twice. The walk never crosses into another file system mounted inside a folder, and Aurora's own test files (`.aurora-speedtest-*`, `.aurora-check-*`) are not counted.

If the count still comes to as much as everything used on the drive (impossible: the system itself takes some), the card does not show it as fact. It says **"Aurora's share could not be measured exactly"**, and Copy for Claude gives both the count and the files' total length.

## Tuning the NFS mount (elia decides; each needs an unmount and mount)

One reader with `rsize=65536` asks the server for 64 KiB at a time and waits for each answer, so it is bound by the round trip. These usually help a lot; try them one at a time and measure with the test below.

- **`rsize=1048576,wsize=1048576`**: 1 MiB per request instead of 64 KiB. The server may allow less: `findmnt` / `nfsstat -m` show what it agreed to.
- **`nconnect=4`**: four TCP connections to the server instead of one (kernel 5.3+; nufurora runs 6.8). Helps several viewers at once.
- **`vers=4.1`** if netcup offers it (then `nolock` is not needed: locking is built into v4).

**A remount is not enough**: `mount -o remount` does not change these. Edit the line in `/etc/fstab`, then, with nobody watching from the drive:

```
sudo systemctl daemon-reload
sudo umount /mnt/storagespace && sudo mount /mnt/storagespace
findmnt -no OPTIONS /mnt/storagespace     # what is really in force
```

For example (with the safety options from *The fstab line* below):

```
46.38.248.210:/voln1117606a1  /mnt/storagespace  nfs  rw,vers=3,proto=tcp,nolock,rsize=1048576,wsize=1048576,nconnect=4,_netdev,nofail,x-systemd.mount-timeout=30s,soft,timeo=100,retrans=2  0  0
```

Then press **Test again** on the drive's card.

### A before/after test to paste on nufurora

Run it before the change and after; compare the three figures. It uses random data (zeros get compressed by the server), drops the caches before each read, and cleans up after itself.

```
D=/mnt/storagespace/Aurora; F=$D/.nfs-speedtest; R=/tmp/.nfs-random
head -c 1G /dev/urandom > $R
echo "write:"; dd if=$R of=$F bs=1M conv=fdatasync 2>&1 | tail -1
drop() { sync; echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null; }
drop; echo "1 reader:"; dd if=$F of=/dev/null bs=1M 2>&1 | tail -1
drop; echo "4 readers together:"; s=$(date +%s.%N)
for i in 0 1 2 3; do dd if=$F of=/dev/null bs=1M skip=$((i*256)) count=256 status=none & done; wait
e=$(date +%s.%N); awk -v s=$s -v e=$e 'BEGIN { printf "%.0f MB/s\n", 1024 / (e - s) }'
rm -f $F $R
```

The last figure (four readers together) is the one Aurora scores a network drive by.

## Network drives that stop answering (NFS safety)

A network drive mounted **hard** (NFS's default, and how /mnt/storagespace is mounted today) that stops answering makes every file call on it wait **for ever**. In Node, those calls sit in libuv's thread pool, a few threads shared by all file I/O, DNS and compression. A handful of them and nobody in the house can watch anything. A synchronous call on the event loop freezes the whole server at once. What Aurora does about it:

- **Every look at a network drive happens in a child process with a deadline** (`lib/drives/run.js`, `probe-child.js`). This covers the statfs, the check that the folders are readable, counting Aurora's share, the speed check and the setup. Each drive in use is checked every 15 s, with a 6 s deadline.
  - Past the deadline the child is killed, and the drive is marked **Not answering**.
  - No second child goes to that drive until the first one is gone, so stuck processes don't pile up.
- **The rest of the server asks the drives module, not the drive:**
  - free space for the download gate, the health alerts and the admin page comes from the last check;
  - "is the library folder there?" (`lib/libroots`) also comes from the last check;
  - the library walk skips the drive's folders while it is down and keeps what it saw there last time. Its titles stay listed, and nothing is pruned as "deleted";
  - a walk that does not come back in 10 minutes is given up, and it is never retried on the main thread.
- **Playback fails fast:**
  - Every library file request on a network drive (video, HLS, transcode, download, subtitles, cover) first passes a guard.
  - On a drive known to be down, the guard answers **503 at once** with no file call.
  - Otherwise it looks at the file asynchronously with a 3 s deadline. If that hangs, the drive is marked down and every later request fails fast. At most 4 looks per drive are ever in flight.
  - Title records (`/api/item/:id`) carry `unavailable: { code: "drive-down", message }`. The website, the TV and the phone show that sentence when the title is opened or played, instead of a spinner: *"This title is on a storage drive that isn't answering right now. The admin has been told — try again a little later."*
  - Other titles keep working.
- **New downloads** stop going to that drive. A download about to land there is checked once more and sent to another drive.
- **The admin is told, once:**
  - after a minute of not answering, one alert goes through the same channel as the health alerts (ntfy / Telegram): *"Storage drive /mnt/storagespace isn't answering since 15:42 — 37 titles can't play. 3 people tried to watch."*;
  - one more message goes out when it answers again: *"… answering again after 12 min"*;
  - nothing repeats while it stays down, and a drive that flaps is announced at most once every 30 minutes;
  - the summary goes to **Needs you** for as long as it lasts.
- **Recovery is automatic.** The first check that gets an answer resumes everything: playback, new downloads, rescans.
- **The thread pool** is raised from 6 to **16** threads (in the keeper's default, deploy/linux/aurora.service and ecosystem.config.js). A call that was already on its way when the drive hung still holds one thread until the drive answers, and 16 leaves the rest of the house plenty.

What this can't fully remove: in the few seconds between the drive hanging and the next check, a background job (intro detection, subtitle timing, a scan that someone is waiting for) can start a blocking call on it. With a **hard** mount that call waits until the drive is back. With **soft** it gives up after the timeout. That is why the mount options below matter.

## The fstab line — a recommendation (elia decides)

Today the line is something like:

```
46.38.248.210:/voln1117606a1  /mnt/storagespace  nfs  rw,vers=3,proto=tcp,hard,nolock,rsize=65536,wsize=65536  0  0
```

Recommended:

```
46.38.248.210:/voln1117606a1  /mnt/storagespace  nfs  rw,vers=3,proto=tcp,nolock,rsize=65536,wsize=65536,_netdev,nofail,x-systemd.mount-timeout=30s,soft,timeo=100,retrans=2  0  0
```

What each addition does:

- **`_netdev`**: the mount waits for the network at boot.
- **`nofail`**: if the storage is down at boot, the server **boots anyway** instead of hanging in emergency mode. Aurora starts, the drive shows as not answering, and its titles say so.
- **`x-systemd.mount-timeout=30s`**: the boot waits at most 30 s for it.
- **`soft,timeo=100,retrans=2`**: a call that gets no answer gives up after about **30 s** (10 s, then 20 s) with an I/O error, instead of waiting for ever. `timeo` is in tenths of a second.

The trade-off between the two:

| | `hard` (today) | `soft,timeo=100,retrans=2` |
|---|---|---|
| storage stops answering | calls wait **for ever**; anything that touched it is stuck until it is back | calls fail after ~30 s; nothing stays stuck |
| a short blip (a few seconds) | invisible: calls just wait | invisible too (well under the timeout) |
| writes | never lost: they are retried until they get through | a write that times out returns an error, and that file can be left incomplete |
| for Aurora | protected by everything above, apart from the small window | the safe choice: a download that is landing during an outage fails its copy, the temp file is deleted, and the download shows as failed with the reason (Retry in admin). Aurora never puts a half-written file in place |

Aurora writes to the storage only through temp-file-then-rename. A failed copy is never mistaken for a film, so **`soft` is the better fit here.** If you prefer `hard`, keep it, but add `_netdev,nofail` at least, so a boot never hangs.

A variant with clearer errors on newer kernels: `softerr` instead of `soft`. It gives ETIMEDOUT instead of EIO.

To apply a changed line: stop Aurora (or make sure nobody is watching), then run `sudo umount /mnt/storagespace && sudo mount /mnt/storagespace`, or reboot. Check it with `findmnt /mnt/storagespace`.

## Files

| file | what |
|---|---|
| `src/lib/drives/index.js` | the service: rounds, state, use, pick, guard, alerts |
| `src/lib/drives/mounts.js` | parsing the mount list and Windows drives (pure) |
| `src/lib/drives/rules.js` | reserve, pick, score, when to alert (pure) |
| `src/lib/drives/run.js` | a child process with a deadline, one per drive at a time |
| `src/lib/drives/probe-child.js` | the only code that touches a network drive |
| `data/drives.json` | scores, Aurora's share, "no new downloads", alert state |
| routes | `GET /api/admin/drives`, `POST /api/admin/drives/use`, `…/new-downloads`, `…/test` |
| tests | `test/drives-mounts.test.js`, `test/drives-rules.test.js`, `test/drives-hang.test.js`, `test/drives-speed.test.js`, `test/ui/admin-drives.test.js` |

Test seam: `AURORA_DRIVES_EXTRA='[{"path":"…","network":true}]'` makes folders count as drives of their own, and `AURORA_DRIVES_FAKE_HANG=<path>` makes the probe child never answer for paths under it. `AURORA_DRIVES_FAKE_SLOW_MS_PER_MB=<ms>` makes every MB the speed check writes or reads take that much longer. All are for private test servers only.
