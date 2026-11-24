#!/usr/bin/env bash
# Drives `desktop-web` over local test pages inside the desktop sandbox image and checks outcomes from the pages' own text
# (docs/decisions/0065-desktop-sandbox.md, "desktop-web test suite"). Each page logs a click as "clicked: <id> at x,y" in
# its own text, so nothing is injected into a page and a detector would see the same browser a person drives.
#
# Standalone: needs only the cela-desktop image (a running X session with Chrome's tools on PATH) and the pages directory
# (images/sandbox-desktop/test-pages) copied somewhere writable, default /workspace/web-suite. Example:
#   docker cp images/sandbox-desktop/test-pages ws458:/workspace/web-suite
#   docker cp hack/desktop-web-suite.sh ws458:/workspace/desktop-web-suite.sh
#   docker exec ws458 bash /workspace/desktop-web-suite.sh            # all cases; or: ... zoom125 frames-cross
#
# Environment: SUITE_PAGES (pages directory, default /workspace/web-suite), SUITE_PORT (127.0.0.1 server, default random),
# SUITE_CROSS_HOST (default 127.0.0.2: another loopback address is another site, so its frame is an out-of-process iframe;
# a name such as localhost would not resolve in a pod, where Chrome maps every name but 127.0.0.1 to "not found"),
# SUITE_WAIT (seconds one desktop-web call may take, default 240: gVisor is several times slower than runc).
set -u
PAGES=${SUITE_PAGES:-/workspace/web-suite}
WAIT=${SUITE_WAIT:-240}
CROSS_HOST=${SUITE_CROSS_HOST:-127.0.0.2}
PORT=${SUITE_PORT:-$((21000 + RANDOM % 8000))}
CPORT=$((PORT + 1))
WORK=$(mktemp -d)
PASS=0
FAIL=0
FAILED=()
OUT=$WORK/out.txt
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$WORK"' EXIT

[[ -f $PAGES/zoom.html ]] || { echo "no pages in $PAGES (set SUITE_PAGES)" >&2; exit 64; }
cp -r "$PAGES"/. "$WORK/"
sed -i "s#__CROSS__#http://$CROSS_HOST:$CPORT#" "$WORK/frames.html"
(cd "$WORK" && python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1) &
(cd "$WORK" && python3 -m http.server "$CPORT" --bind "$CROSS_HOST" >/dev/null 2>&1) &
BASE=http://127.0.0.1:$PORT

# web <desktop-web args>: runs one command, keeps its output in $OUT and status in $RC, and echoes it for the log.
web() {
  timeout "$WAIT" desktop-web "$@" >"$OUT" 2>&1
  RC=$?
  sed 's/^/    | /' "$OUT"
  return 0
}
open() { web open "$BASE/$1.html?n=$RANDOM$RANDOM"; }
# Waits (a slow sandbox) until the page's text holds a line matching the regex; leaves the text in $OUT.
has_text() {
  local re=$1 i
  for i in 1 2 3 4 5; do
    timeout "$WAIT" desktop-web text "$re" --context 0 --limit 40 >"$OUT" 2>&1
    grep -Eiq -- "$re" "$OUT" && return 0
    sleep 2
  done
  return 1
}
check() { # check <name> <ok:0|1> [detail]
  if [[ $2 == 0 ]]; then
    PASS=$((PASS + 1))
    echo "  PASS $1"
  else
    FAIL=$((FAIL + 1))
    FAILED+=("$CASE: $1")
    echo "  FAIL $1 ${3:-}"
  fi
}
clicks() { # clicks <regex> <id>...: click each by name regex, then expect "clicked: <id> at" in the page text
  local spec=$1 id=$2
  web click "$spec"
  [[ $RC == 0 ]] || { check "click $spec" 1 "(exit $RC)"; return; }
  has_text "clicked: $id at"
  check "click $spec lands on $id" $?
}
excludes() { # excludes <regex> <what>: no line of the page's text or snap matches
  local text snap
  timeout "$WAIT" desktop-web text . --context 0 --limit 40 >"$OUT" 2>&1
  grep -Eiq -- "$1" "$OUT" && text=1 || text=0
  timeout "$WAIT" desktop-web snap >"$OUT" 2>&1
  grep -Eiq -- "$1" "$OUT" && snap=1 || snap=0
  check "$2 absent from text and snap" $((text + snap)) "(text=$text snap=$snap)"
}

run_case() { CASE=$1; echo "== $1"; "case_$1"; }

zoom_case() { # zoom_case <percent> <keys...>
  local pct=$1
  shift
  open zoom
  web key "$@"
  has_text "zoom: $pct%"
  check "page is at $pct%" $?
  clicks '^Zoom A$' zoom-a
  clicks '^Zoom B$' zoom-b
  clicks '^Zoom C$' zoom-c
  web key ctrl+0
}
case_zoom125() { zoom_case 125 ctrl+equal ctrl+equal; }
case_zoom80() { zoom_case 80 ctrl+minus ctrl+minus; }

case_hscroll() {
  open hscroll
  clicks '^Bottom edge$' hs-bottom
  clicks '^Middle$' hs-mid
  clicks '^Far right$' hs-right
  clicks '^Low$' hs-low
  clicks '^Bottom edge$' hs-bottom
}

case_sticky() {
  open sticky
  clicks '^Row button 1$' row-1
  clicks '^Row button 30$' row-30
  clicks '^Row button 60$' row-60
  clicks '^Header button$' sticky-head
  clicks '^Row button 12$' row-12
}

case_far() {
  open far
  clicks '^Far button$' far-btn
  has_text 'far-text-marker'
  check "text of the far part" $?
}

case_small() {
  open small
  clicks '^Tiny$' tiny
  clicks '^Tiny link$' tiny-link
}

case_modal() {
  open modal
  check "open lists the dialog" "$(grep -q 'open dialog "Notice"' "$OUT"; echo $?)"
  web click '^Behind$'
  check "click behind a dialog is refused" "$([[ $RC != 0 ]] && grep -q 'covers' "$OUT"; echo $?)"
  check "refusal lists the dialog's buttons" "$(grep -q 'Agree' "$OUT"; echo $?)"
  web snap
  check "snap lists the dialog" "$(grep -q 'open dialog "Notice"' "$OUT"; echo $?)"
  clicks '^Agree$' dlg-ok
  clicks '^Behind$' behind
}

case_shadow() {
  open shadow
  clicks '^Shadow one$' host-btn
  clicks '^Shadow two$' host2-btn
  has_text 'text inside Shadow one'
  check "shadow text is read" $?
}

case_frames_same() {
  open frames
  clicks '^Top button$' top-btn
  has_text 'frame-text-marker same'
  check "same-origin frame text is read" $?
  clicks '^Button same$' btn-same
  clicks '^Button samelow$' btn-samelow
}

case_frames_cross() {
  open frames
  has_text 'frame-text-marker cross'
  check "cross-origin frame text is read" $?
  web snap
  check "snap lists the cross-origin frame's button" "$(grep -q 'Button cross' "$OUT"; echo $?)"
  clicks '^Button cross$' btn-cross
  clicks '^Button crosslow$' btn-crosslow
  clicks '^Top button$' top-btn
  excludes 'tinyframe' "the 1 px cross-origin frame"
}

case_honeypot() {
  open honeypot
  has_text 'Visible link'
  check "visible text is read" $?
  excludes 'trap|hidden-prompt-marker' "hidden links and text"
  web snap
  check "snap lists the visible link" "$(grep -q 'Visible link' "$OUT"; echo $?)"
  web click 'Offscreen trap'
  check "a hidden link cannot be clicked" "$([[ $RC != 0 ]]; echo $?)"
}

case_spacing() {
  open spacing
  has_text 'zeta'
  timeout "$WAIT" desktop-web text '.' --context 0 --limit 40 >"$OUT" 2>&1
  sed 's/^/    | /' "$OUT"
  for line in '145,95 zł' 'alphabeta' 'gamma delta' 'epsilon zeta' 'boldfaceitalic' 'eta' 'theta'; do
    check "line \"$line\"" "$(grep -qE "^[0-9]+: $line\$" "$OUT"; echo $?)"
  done
  check "block elements stay separate lines" "$([[ $(grep -cE '^[0-9]+: (iota|kappa)$' "$OUT") == 2 ]]; echo $?)"
}

# Seconds since the epoch with a fraction, for the round-trip timings the dialog cases print.
now() { date +%s.%N; }

case_dialogs() {
  open dialogs
  local t0 t1
  t0=$(now)
  web click '^Show confirm$'
  check "click that opens a confirm says the page is not answering" "$(grep -q 'not answering' "$OUT"; echo $?)"
  check "the dialog's message and buttons are shown" "$(grep -Eq 'Delete the item\?|dialog area' "$OUT"; echo $?)"
  check "the answer tells how to confirm and cancel" "$(grep -q 'desktop-web key Return' "$OUT" && grep -q 'desktop-web key Escape' "$OUT"; echo $?)"
  web text 'result'
  check "a read while blocked is refused with the notice" "$([[ $RC == 3 ]] && grep -q 'not answering' "$OUT"; echo $?)"
  web key a # a key a dialog ignores (Tab would move its default button)
  check "a key that does not close it says still blocked" "$(grep -q 'Still blocked' "$OUT"; echo $?)"
  web key Return
  t1=$(now)
  check "Return closes it and the result is read" "$(grep -q 'dialog closed' "$OUT" && grep -q 'result: confirm true' "$OUT"; echo $?)"
  echo "  (confirm round trip: click, notice, key Return, result: $(awk "BEGIN{printf \"%.1f\", $t1 - $t0}") s)"
  web click '^Show confirm$'
  web key Escape
  check "Escape cancels a confirm" "$(grep -q 'result: confirm false' "$OUT"; echo $?)"
  web click '^Show prompt$'
  check "a prompt shows its message" "$(grep -q 'Your name' "$OUT"; echo $?)"
  web key --text 'Zofia' Return
  check "key --text answers a prompt" "$(grep -q 'result: prompt "Zofia"' "$OUT"; echo $?)"
  web click '^Show alert$'
  web key Return
  check "an alert is closed" "$(grep -q 'result: alert closed' "$OUT"; echo $?)"
  web click '^Confirm later$'
  # the dialog opens 1.2 s after the click: the command may return before, so ask again
  web key a
  grep -q 'not answering' "$OUT" || { sleep 3; web key a; }
  check "a dialog that opens after the click is found" "$(grep -q 'Really, later' "$OUT"; echo $?)"
  web key Return
  check "and answered" "$(grep -q 'result: later true' "$OUT"; echo $?)"
}

case_select() {
  open selects
  web snap
  check "snap shows a select's options" "$(grep -q 'combobox "Dropdown".*options: Please select an option | Option 1 | Option 2 (off) (disabled) | Option 3' "$OUT"; echo $?)"
  check "snap hints how to pick" "$(grep -q 'desktop-web select e[0-9]* ' "$OUT"; echo $?)"
  web select Dropdown 'Option 3'
  check "select picks an option and reads it back" "$(grep -q 'value now: "Option 3"' "$OUT"; echo $?)"
  has_text 'changed: Option 3'
  check "the page saw the change" $?
  timeout "$WAIT" desktop-web text 'changed:' --context 0 >"$OUT" 2>&1
  check "one change event, none from the arrow steps" "$([[ $(grep -o 'changed:' "$OUT" | wc -l) == 1 ]]; echo $?)"
  web select Dropdown 'option 3'
  check "an option already selected is not touched" "$(grep -q 'already selected' "$OUT"; echo $?)"
  web select Dropdown 'Option 2'
  check "a disabled option is refused" "$([[ $RC != 0 ]] && grep -q 'disabled' "$OUT"; echo $?)"
  web select Dropdown 'Option'
  check "an ambiguous option is listed, not chosen" "$([[ $RC == 2 ]] && grep -q 'options match' "$OUT"; echo $?)"
  web select Dropdown 'fifth'
  check "case-insensitive match" "$(grep -q 'value now: "Fifth Choice"' "$OUT"; echo $?)"
  web select Dropdown '^Please'
  check "regex match, upwards" "$(grep -q 'value now: "Please select an option"' "$OUT"; echo $?)"
  web select Colours 'Blue'
  check "a list select takes a click on the option" "$(grep -q 'selected now: "Blue"' "$OUT"; echo $?)"
  web select Size 'medium'
  check "an in-page combobox is opened and its option clicked" "$(grep -q 'clicked option "Medium"' "$OUT"; echo $?)"
  has_text 'size: Medium'
  check "the page saw the pick" $?
}

case_wait() {
  open later
  web click '^Start$'
  check "a click that only starts something says the result may come later" "$(grep -q 'result may come later' "$OUT"; echo $?)"
  web wait 'Done: report ready' --timeout 20
  check "wait sees text that appears later" "$([[ $RC == 0 ]] && grep -q 'Done: report ready' "$OUT"; echo $?)"
  web click '^Start$'
  web wait 'Done: report ready' --gone --timeout 20
  check "wait --gone sees text disappear" "$([[ $RC == 0 ]] && grep -q 'gone after' "$OUT"; echo $?)"
  web wait 'never on this page' --timeout 2
  check "wait times out with exit 3" "$([[ $RC == 3 ]] && grep -q 'not seen' "$OUT"; echo $?)"
}

case_hover() {
  open hover
  web hover 'Portrait two'
  check "hover reveals a caption" "$(grep -q 'user-two' "$OUT"; echo $?)"
  web hover '^Menu$'
  check "hover opens a menu" "$(grep -q 'Sub item alpha' "$OUT"; echo $?)"
  # Three pictures with one name and one source: snap lists each, and --nth or a ref reaches any of them.
  web snap 'Same face'
  check "snap lists each same-named picture" "$([ "$(grep -c 'image "Same face"' "$OUT")" = 3 ]; echo $?)"
  local second; second=$(grep 'image "Same face"' "$OUT" | sed -n '2s/.*\[\(e[0-9]*\)\].*/\1/p')
  web hover 'Same face' --nth 3
  check "hover --nth 3 reaches the third same-named picture" "$(grep -q 'same-3' "$OUT"; echo $?)"
  web hover "$second"
  check "hover by ref reaches the second" "$(grep -q 'same-2' "$OUT"; echo $?)"
}

case_marks() {
  open marks
  timeout "$WAIT" desktop-web text . --marks --context 0 --limit 40 >"$OUT" 2>&1
  sed 's/^/    | /' "$OUT"
  check "a rating shown by its class is marked" "$(grep -q '‹star-rating Three›' "$OUT" && grep -q '‹star-rating One›' "$OUT"; echo $?)"
  check "an icon is marked in its line" "$(grep -q 'Server status ‹dot status-online state=up› nominal' "$OUT"; echo $?)"
  check "an image without alt is marked by its file" "$(grep -q 'Logo ‹src:brand-mark.png› end' "$OUT"; echo $?)"
  check "a picture with an accessible name is not marked" "$(grep -q 'Icon with name end' "$OUT"; echo $?)"
  timeout "$WAIT" desktop-web text . --context 0 --limit 40 >"$OUT" 2>&1
  check "marks are opt-in" "$(grep -q '‹' "$OUT"; [[ $? == 1 ]]; echo $?)"
}

case_shot() {
  open marks
  web shot 'Alpha book' --pad 50
  local f
  f=$(grep -o '/workspace[^ ]*\.jpg' "$OUT" | head -1)
  check "shot saves an image of the element's area" "$([[ -n $f && -s $f ]]; echo $?)"
}

ALL=(zoom125 zoom80 hscroll sticky far small modal shadow frames_same frames_cross honeypot spacing dialogs select wait hover marks shot)
CASES=("$@")
[[ ${#CASES[@]} -gt 0 ]] || CASES=("${ALL[@]}")
for _ in $(seq 1 50); do curl -fs "$BASE/zoom.html" >/dev/null 2>&1 && break; sleep 0.2; done
for c in "${CASES[@]}"; do run_case "${c//-/_}"; done

echo
echo "passed $PASS, failed $FAIL"
for f in ${FAILED[@]+"${FAILED[@]}"}; do echo "  FAILED $f"; done
[[ $FAIL == 0 ]]
