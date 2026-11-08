#!/usr/bin/env bash
#
# A backup of the Gloss running on this machine (docker-compose.yml), in a folder of its own:
#
#   scripts/backup.sh /Volumes/NAS/backups/gloss
#
# makes /Volumes/NAS/backups/gloss/gloss-2026-11-08-213000/ with
#
#   gloss.dump        the database: every text, link, highlight, note, question, brief,
#                     reading place and painted cover. Restored with pg_restore.
#   originals.tar.gz  the saved copies of the original pages, PDFs and videos.
#   library.zip       the library to read without Gloss: every text as Markdown with your
#                     notes, by topic, and your links (what the library's Export button makes).
#   RESTORE.txt       how to put it back.
#
# and brings /Volumes/NAS/backups/gloss/repos/ up to date: the saved code of the repos kept as
# link cards, one git bundle each, named for the repo (repos/github.com/owner/repo.bundle). They
# are kept in one folder for every backup, not in each, and only a changed one is copied again.
# A repo whose card is gone keeps its bundle there.
#
# Gloss keeps running while it works. A backup is written to a hidden folder first and only
# gets its name when everything in it has been checked, so a folder named gloss-... is whole.
#
# GLOSS_URL: where Gloss answers, for library.zip. Default http://127.0.0.1:3100.

set -euo pipefail

if [ $# -ne 1 ] || [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  echo "usage: scripts/backup.sh <directory>" >&2
  exit 2
fi

repo=$(cd "$(dirname "$0")/.." && pwd)
url=${GLOSS_URL:-http://127.0.0.1:3100}
compose() { docker compose -f "$repo/docker-compose.yml" "$@"; }
running() { compose ps --status running --services 2>/dev/null | grep -qx "$1"; }

for s in db app; do
  if ! running "$s"; then
    echo "Gloss isn't running ($s is down). Start it first: cd $repo && docker compose up -d" >&2
    exit 1
  fi
done

mkdir -p "$1"
root=$(cd "$1" && pwd)
name="gloss-$(date +%Y-%m-%d-%H%M%S)"
work="$root/.$name.partial"
mkdir "$work"
part=""
trap 'rm -rf "$work"; [ -z "$part" ] || rm -f "$part"' EXIT

echo "Backing up Gloss to $root/$name"

printf '  database...         '
compose exec -T db pg_dump -U gloss -d gloss --format=custom > "$work/gloss.dump"
# A dump pg_restore can't read is no backup.
compose exec -T db pg_restore --list < "$work/gloss.dump" > /dev/null
echo "$(du -h "$work/gloss.dump" | cut -f1)"

printf '  saved originals...  '
# The app's image has tar but not gzip: the archive is compressed here. Repos go to repos/, below.
compose exec -T app tar -cf - -C /data/originals --exclude='*.bundle' --exclude='*.bundle.prev' --exclude='*.part*' . | gzip > "$work/originals.tar.gz"
gzip -t "$work/originals.tar.gz"
echo "$(du -h "$work/originals.tar.gz" | cut -f1)"

printf '  saved repos...      '
# Every repo bundle in the volume, with the name it is kept under here, its size and its time.
list_repos='
const fs = require("fs"), p = require("path"), R = "/data/originals";
for (const u of fs.readdirSync(R, { withFileTypes: true })) {
  if (!u.isDirectory()) continue;
  const d = p.join(R, u.name);
  for (const f of fs.readdirSync(d)) {
    if (!f.endsWith(".repo.json")) continue;
    const id = f.slice(0, -10);
    let info;
    try { info = JSON.parse(fs.readFileSync(p.join(d, f), "utf8")); } catch { continue; }
    const name = (u.name === "local" ? "" : u.name + "/") + String(info.name || id).replace(/[^\w.~\/-]/g, "_").replace(/\.\.+/g, "_");
    for (const [suffix, tag] of [[".bundle", ""], [".bundle.prev", ".previous"]]) {
      let st;
      try { st = fs.statSync(p.join(d, id + suffix)); } catch { continue; }
      console.log([p.join(d, id + suffix), name + tag + ".bundle", st.size, Math.floor(st.mtimeMs / 1000)].join("\t"));
    }
  }
}'
sizetime() { stat -f '%z %m' "$1" 2>/dev/null || stat -c '%s %Y' "$1"; }
stamp() { date -r "$1" +%Y%m%d%H%M.%S 2>/dev/null || date -d "@$1" +%Y%m%d%H%M.%S; }
kept=0
copied=0
while IFS=$'\t' read -r src dest size mtime; do
  [ -n "$src" ] || continue
  kept=$((kept + 1))
  out="$root/repos/$dest"
  [ -f "$out" ] && [ "$(sizetime "$out")" = "$size $mtime" ] && continue
  mkdir -p "$(dirname "$out")"
  part="$out.part"
  # Not the loop's stdin: compose exec would pass the rest of the list into the container.
  compose exec -T app cat "$src" < /dev/null > "$part"
  if [ "$(sizetime "$part" | cut -d' ' -f1)" != "$size" ]; then
    echo "the copy of $dest came out the wrong size" >&2
    exit 1
  fi
  touch -t "$(stamp "$mtime")" "$part"
  mv "$part" "$out"
  part=""
  copied=$((copied + 1))
done < <(compose exec -T app node -e "$list_repos")
echo "$kept in $root/repos, $copied copied now"

printf '  readable library... '
curl -fsS --max-time 600 "$url/api/export" -o "$work/library.zip"
unzip -tq "$work/library.zip" > /dev/null
echo "$(du -h "$work/library.zip" | cut -f1)"

cat > "$work/RESTORE.txt" <<EOF
A backup of Gloss, made $(date "+%-d %B %Y at %H:%M").

To put it back into a Gloss running with Docker (on this Mac or another one). This replaces the
library there with the one in this backup.

  1. In Gloss's folder, start it:   docker compose up -d
  2. From this backup's folder:

     docker compose -f /path/to/gloss/docker-compose.yml exec -T db \\
       pg_restore -U gloss -d gloss --clean --if-exists < gloss.dump

     gunzip -c originals.tar.gz | docker compose -f /path/to/gloss/docker-compose.yml exec -T app \\
       tar -xf - -C /data/originals

  3. In your browser, clear the site data for Gloss (in Chrome: the icon left of the address,
     then Site settings, then Delete data), and open it again. The browser keeps its own copy
     of the library and only asks for what changed since it last looked, so without this it
     would not see the restored one. This also forgets what Gloss keeps only in the browser,
     like its settings or an OpenRouter key you pasted in.

Repos come back by themselves: Gloss saves the code of every repo card again. One that is gone
from its site has its last copy in ../repos, as a git bundle:

     git clone ../repos/github.com/owner/repo.bundle

library.zip needs none of this: unzip it and open README.md.
EOF

mv "$work" "$root/$name"
trap - EXIT
echo "Done: $(du -sh "$root/$name" | cut -f1) in $root/$name"
