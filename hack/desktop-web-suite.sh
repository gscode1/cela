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
SPORT=$((PORT + 2))
sed -i "s#__SLOW__#http://127.0.0.1:$SPORT#" "$WORK/loading.html" "$WORK/hidden-frame.html"
sed -i "s#__CROSS__#http://$CROSS_HOST:$CPORT#" "$WORK/hidden-frame.html"
(cd "$WORK" && python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1) &
(cd "$WORK" && python3 -m http.server "$CPORT" --bind "$CROSS_HOST" >/dev/null 2>&1) &
# a server that takes connections and never answers: a frame from it stays loading
python3 -c 'import socket, sys
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(16); held = []
while True: held.append(s.accept())' "$SPORT" >/dev/null 2>&1 &
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
  # inline-blocks on one line join it (eta theta, the values of Distance and Time, an inline-flex number); cards and columns
  # built of inline-blocks span several lines and stay apart
  # a flex row's items close together read as one line, a space between them (a price); a menu's links stay apart
  for line in '145,95 zł' 'alphabeta' 'gamma delta' 'epsilon zeta' 'boldfaceitalic' 'eta theta' 'Distance: 13km\. Time: 0:22\.' \
    'Rating 4\.5 of 5' 'Card lambda' '10 zł' 'Card mu' '20 zł' 'Left column words that wrap' 'Right nu' '699 00 zł' 'Price 145,95' \
    'Home xi' 'Offers xi' 'News omicron' 'Sport omicron'; do
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
  check "snap hints how to pick" "$(grep -q '(pick an option: desktop-web select e[0-9]* "' "$OUT"; echo $?)"
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

# A select that loads a page busy for 4 s: the probe misses, no dialog is open, and the answer is the new page.
case_busy() {
  open busy
  web select 'Sort by' 'Price'
  check "a select that loads a busy page prints the new page" "$(ok 'Sorted by price, lowest first')"
  check "a busy load is no dialog" "$(no 'dialog|not answering')"
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
  check "a picture with an accessible name is marked by its name" "$(grep -q 'Icon with name ‹"Settings"› end' "$OUT"; echo $?)"
  check "a <time> gets its datetime" "$(grep -q 'Posted 5 days ago ‹datetime=2026-11-20T09:30:00Z› by Ann' "$OUT"; echo $?)"
  check "a title that says more than the text is marked" "$(grep -q 'Edited yesterday ‹title:"21 November 2026, 14:05"› by Bob' "$OUT"; echo $?)"
  timeout "$WAIT" desktop-web text . --context 0 --limit 40 >"$OUT" 2>&1
  sed 's/^/    | /' "$OUT"
  check "marks are opt-in" "$(grep -Eq '‹(star-rating|dot|src:|"Settings"|datetime|title:)' "$OUT"; [[ $? == 1 ]]; echo $?)"
  check "struck-through text is marked" "$(grep -Eq '^[0-9]+: Price ~637 zł~ 384 zł$' "$OUT"; echo $?)"
  check "struck through by an ancestor" "$(grep -Eq '^[0-9]+: Was ~99,00~ now 79,00$' "$OUT"; echo $?)"
  check "a bare number gets its element's label" "$(grep -Eq '^[0-9]+: 94 ‹Upvote›$' "$OUT"; echo $?)"
  check "or its title" "$(grep -Eq '^[0-9]+: 20 ‹Comments›$' "$OUT"; echo $?)"
  local at
  at=$(grep -E '^[0-9]+: Offers$' "$OUT" | cut -d: -f1)
  open marks
  check "outline maps a heading to its own line, not one that starts with its words" "$(ok "^$at: ## Offers$")"
  check "outline leaves out a heading no one sees" "$(no 'Unseen heading|^-:')"
  check "outline is in line order" "$(grep -E '^[0-9]+: #' "$OUT" | cut -d: -f1 | sort -n -c; echo $?)"
  web hover 'yesterday'
  check "a hover that changes nothing shows the title as the tooltip" "$(ok '^tooltip: "21 November 2026, 14:05"$')"
}

# The head of an answer: the url only when it changed, the title with entities decoded, and notices about the page.
case_notices() {
  open notices
  check "a new page prints its url" "$(ok '^url: http')"
  check "the title's entities are decoded" "$(ok '^title: Fish & Chips "27"$')"
  check "an ordinary short page has no notice" "$(no 'error page|bot check|still loading|redirected')"
  web text Notices
  check "an unchanged url is left out" "$(no '^url:')"
  web url
  check "desktop-web url prints it all the same" "$(ok '^url: http')"
  web open "$BASE/redirect.html"
  check "a redirect is said" "$(ok '^redirected from http.*/redirect\.html$')"
  open missing
  check "a short page with a status in its heading may be an error page" "$(ok '^may be an error page')"
  web open "http://127.0.0.1:1/"
  check "Chrome's error page is said" "$(ok '^Chrome error page')"
  open loading
  check "a frame that has drawn nothing is still loading" "$(ok 'frame is still loading \(127\.0\.0\.1:')"
  web text Checkout
  check "it is said once per page" "$(no 'still loading')"
  open hidden-frame
  check "frames with no visible box (display:none, visibility:hidden) are not loading" "$(no 'still loading')"
  open nonmodal
  check "a dialog that is not modal says so" "$(ok '^open dialog "View demo" \(not modal\):')"
  clicks '^Go on$' go
}

# Error pages: a status in a title's part, a heading or a line of its own; a price that is a status number is not one.
case_errors() {
  open timeout522
  check "a 522 in the middle of the title" "$(ok '^may be an error page')"
  open body404
  check "an \"Error 404\" line in the body" "$(ok '^may be an error page')"
  open listing
  check "a listing with a 404 zł price stays clean" "$(no 'error page')"
}

# A bot check: named on sight with one ordinary revisit allowed, then a stop; its widget is never clicked or typed into.
case_challenge() {
  open challenge
  check "a challenge provider's frame on a short page looks like a bot check" "$(ok '^looks like a bot check \(Cloudflare challenge\): never click or solve it\. It can be a one-off: open one ordinary page')"
  web snap
  check "snap lists the widget" "$(grep -q 'Verify you are human' "$OUT"; echo $?)"
  web click 'Verify you are human'
  check "a click on the widget is refused" "$(ok "bot check's own widget \(Cloudflare challenge\).*nothing clicked" 1)"
  web type 'Answer' 'abc'
  check "typing into it is refused" "$(ok "bot check's own widget.*nothing typed" 1)"
  web drag 'Verify you are human' --by 40,0
  check "dragging it is refused" "$(ok "bot check's own widget.*nothing dragged" 1)"
  open notices
  open challenge
  check "the second time on the host: stop" "$(ok '^bot check again \(Cloudflare challenge, 2nd time on 127\.0\.0\.1:[0-9]+\): stop and report it')"
}

# Text a box with overflow hidden cuts away: said to exist, never printed, with the control that opens it.
case_collapsed() {
  open collapsed
  web text 'USB-C'
  check "a match in a cut-off section is counted" "$(ok '^1 match is in a cut-off section \(text not shown\): open it first with \[e[0-9]+\] button "Show the full specification"')"
  check "its text is not printed" "$(no 'HDMI|DisplayPort')"
  check "the menu above is not offered" "$(no '"Menu"')"
  local ref
  ref=$(grep -o 'desktop-web click e[0-9]*' "$OUT" | awk '{print $3}')
  web click "${ref:-none}"
  has_text 'USB-C, HDMI'
  check "once opened it is text" $?
  open honeypot
  web text 'Screen reader trap'
  check "screen-reader-only text is no cut-off section" "$(no 'cut-off')"
}

case_shot() {
  open marks
  web shot 'Alpha book' --pad 50
  local f
  f=$(grep -o '/workspace[^ ]*\.jpg' "$OUT" | head -1)
  check "shot saves an image of the element's area" "$([[ -n $f && -s $f ]]; echo $?)"
  open shot
  web shot '^Area$'
  check "a narrow label is shot with its row" "$(ok 'shot of .*"Area".* with its row \([0-9]+x[0-9]+ px\)')"
  local w
  w=$(grep -oE 'with its row \([0-9]+x' "$OUT" | grep -oE '[0-9]+')
  check "the crop is at least the row's width" "$([[ ${w:-0} -ge 720 ]]; echo $?)"
  check "an uncovered target has no note" "$(no 'covered by')"
  web shot '^Elevation$'
  check "a target under a fixed banner says so" "$(ok '^note: covered by .*: a fixed layer is in front')"
  check "and lists the banner's buttons" "$(ok 'button "Reject all"')"
}

# A dialog with more controls than the listing holds: the buttons come first, so a decision is never behind "... N more".
case_dialog_cap() {
  open dialog-cap
  check "open lists the first button past twelve links" "$(ok 'button "Allow"')"
  check "open lists the second button too" "$(ok 'button "Refuse"')"
  check "the links that did not fit are counted" "$(ok '\.\.\. [0-9]+ more')"
}

# A modal's field wins over a same-named one behind it, also when the page's is named exactly so and the modal's only contains it.
case_modal_field() {
  open modal-field
  web click 'Open filters'
  web type 'Search' 'foo'
  check "type fills the modal's field" "$(ok 'used the one in the open dialog')"
  has_text 'typed in modal-search: foo'
  check "the page saw the modal's field" $?
  web type 'Find' 'bar'
  has_text 'typed in modal-find: bar'
  check "the modal's field wins over the page's exact name" $?
  has_text 'typed in'
  check "nothing was typed behind the modal" "$(no 'typed in page-')"
}

# What an action answers: a typed field's suggestions (a plain div list folded into one line, buttons with refs), a click that
# moved to another page (no "drew it again"), and a --near that names nothing (the matches, with their rows).
case_answers() {
  open autocomplete
  web type 'Day' '1'
  check "30 short new lines are folded into one line" "$(ok '^changed \(30 new lines\): 01 \| 02 \| 03')"
  check "clipped to 160 characters" "$([[ $(grep '^changed' "$OUT" | wc -c) -le 200 ]]; echo $?)"
  web type 'City' 'G'
  check "buttons that appeared are printed with refs" "$(ok 'appeared: \[e[0-9]+\] button "Gdansk"')"
  web click '^Gdynia$'
  has_text 'clicked: Gdynia at'
  check "a suggestion is clicked by name" $?
  open wizard
  web click 'Yes'
  web click '^Continue$'
  check "the next page is printed" "$(ok 'Step two')"
  check "a click that moved to another page does not say the page drew it again" "$(no 'drew it again')"
  open grids
  web click '^20$' --near 'Mars'
  check "a --near that matches nothing lists the name matches" "$(ok '^(desktop-web: )?2 elements match "\^20\$", none near "Mars" \(--near reads the row, its group and the heading above\):' 1)"
  check "with their rows and refs" "$([[ $(ok '\[e[0-9]+\] button "20" .*\| Left 20 411$' 1) == 0 && $(ok '\[e[0-9]+\] button "20" .*\| Right 20 704$' 1) == 0 ]]; echo $?)"
  web click '^20$' --near 'February'
  has_text 'clicked: 20 at'
  check "--near with the heading above still picks one" $?
}

# A consent layer drawn as a fixed div without a dialog role: open lists it, a click behind it is refused with its buttons.
case_overlay() {
  open overlay
  check "open lists a fixed layer at the centre as an overlay" "$(ok '^open overlay \(a fixed layer without a dialog role')"
  check "with its buttons" "$([[ $(ok 'button "Reject all"') == 0 && $(ok 'button "Settings"') == 0 ]]; echo $?)"
  web click 'Behind the layer'
  check "a click behind it is refused, naming the layer" "$(ok 'a fixed layer is in front' 1)"
  check "and its buttons" "$(ok 'button "Reject all"' 1)"
  web click 'Reject all'
  has_text 'consent: rejected'
  check "its button answers it" $?
}

# Exit status of the last web call and whether its output matches: ok <regex> [rc].
ok() { [[ $RC == "${2:-0}" ]] && grep -Eq -- "$1" "$OUT"; echo $?; }
no() { grep -Eq -- "$1" "$OUT"; [[ $? == 1 ]]; echo $?; }

case_custom() {
  open custom-controls
  web snap 'good|superb|honeypot'
  check "snap lists a checkbox drawn by its label" "$(ok 'checkbox "Very good: 8\+" checked=false')"
  check "snap lists a checkbox tied to its label by for=" "$(ok 'checkbox "Superb: 9\+"')"
  check "a transparent checkbox without a visible label stays out" "$(no 'Honeypot')"
  web click 'Very good'
  check "a click through the label prints the new state" "$(ok 'checkbox "Very good: 8\+": checked false -> true')"
  has_text 'checked: good true'
  check "the page saw the label-backed checkbox change" $?
  web click 'Superb'
  has_text 'checked: superb true'
  check "a for= label checkbox is clicked" $?
  web snap 'Ultra HD|Quad HD'
  check "snap with a regex lists clickable text" "$(ok 'clickable "Ultra HD 3840 x 2160"')"
  web click 'Ultra HD'
  check "click falls back to a line of clickable text" "$(ok 'clicked the text')"
  has_text 'picked: 4K'
  check "the role-less option took the click" $?
  web click 'Quad HD'
  has_text 'picked: QHD'
  check "clickable text inside a clickable row" $?
  web click 'Honeypot'
  check "the honeypot cannot be clicked" "$([[ $RC != 0 ]]; echo $?)"
  has_text 'checked: trap'
  check "the honeypot was never touched" "$([[ $? != 0 ]]; echo $?)"
}

case_state() {
  open state
  check "open lists the cookie dialog" "$(ok 'open dialog "Cookies"')"
  web click '^Male$'
  check "a click prints the radio's state after it" "$(ok 'radio "Male": checked false -> true')"
  check "no later hint when the state changed" "$(no 'result may come later')"
  web click '^Female$'
  check "the other radio of the group is reported" "$(ok '\] radio "Male": checked true -> false')"
  web click '^Decline$'
  check "a closed dialog is reported" "$(ok 'closed dialog "Cookies"')"
  check "and no later hint" "$(no 'result may come later|page text unchanged')"
  web type 'Slider value' 75
  check "a read-only field that kept its value exits 1" "$(ok 'kept its value' 1)"
  web type 'Filter fruit' an
  check "type says value now" "$(ok 'value now: "an"')"
  check "type shows a debounced filter's result" "$(ok 'Showing 3 of 8')"
}

case_names() {
  open names
  web snap 'button|combobox|textbox'
  check "an icon button is named by its class" "$(ok 'button ‹tool mode-car›')"
  check "an icon inside a button names it" "$(ok 'button ‹tool icon icon-bike›')"
  check "an image file names a button" "$(ok 'button ‹tool src:walk-icon.png›')"
  check "a placeholder is printed" "$(ok 'textbox "Enter destination" placeholder="Where are you going\?"')"
  check "unnamed comboboxes are told apart by their row" "$(grep -q 'combobox "" near "Subjects Pick subjects"' "$OUT" && grep -q 'near "State Select state"' "$OUT" && grep -q 'near "City Select city"' "$OUT"; echo $?)"
  check "a disabled button is listed as such" "$(ok 'button "Next step" disabled')"
  web click 'Next step'
  check "click refuses a disabled button" "$(ok 'disabled' 1)"
  clicks 'icon-bike' by-bike
  web click 'City'
  has_text 'focused: city'
  check "an unnamed combobox is clicked by its row text" $?
  web type 'where are you' 'Lisbon'
  check "type finds a field by its placeholder" "$(ok 'value now: "Lisbon"')"
  web text 'going'
  check "text with no matching line lists matching elements" "$(grep -q 'elements that match' "$OUT" && grep -q 'placeholder="Where are you going' "$OUT"; echo $?)"
  web snap '^Enter destination$'
  check "snap anchors match the name, not the printed line" "$(ok 'textbox "Enter destination"')"
  web click 'Select town'
  has_text 'focused: town'
  check "a regex matches a control's description" $?
  web type 'slider' 7
  check "a regex matches the role word of an unnamed control" "$(ok 'value 2 -> 7')"
  web click '^3$'
  check "same-named options under different questions are listed" "$(ok 'elements match' 2)"
  web click '^3$' --near 'experienced'
  check "--near matches the heading above a control" "$(ok 'radio "3": checked false -> true')"
  has_text 'radio exp: 3'
  check "the option of that question was picked" $?
}

# Sortable column headers: listed with their group and sort state, clicked beside the link inside, never confused with a link.
case_table() {
  open table
  web snap 'Population|Town|Remarks'
  check "a sortable header is listed with its group and sort state" "$(ok 'columnheader "Population" in "Metro area" sort=none desc="Sort ascending"')"
  check "its twin under the other group too" "$(ok 'columnheader "Population" in "Town proper" sort=none')"
  check "a header that only labels its column is not listed" "$(no 'columnheader "Remarks"|columnheader "Metro area"')"
  web click '^Population$'
  check "a header and a link of the same name are listed, nothing clicked" "$([[ $RC == 2 ]] && grep -q 'columnheader "Population" in "Metro area"' "$OUT" && grep -q 'link "Population"' "$OUT"; echo $?)"
  web click 'Town proper Population'
  check "a click by group and name sorts and prints the new state" "$(ok 'columnheader "Population".*sort none -> ascending')"
  has_text 'sorted: column 3 ascending, first Aš'
  check "the page sorted that column" $?
  web click '^Town\['
  check "a header holding a link is clicked beside the link" "$(ok 'columnheader "Town\[1\]".*sort none -> ascending')"
  check "and does not follow the link" "$(no '^url:')"
  has_text 'sorted: column 0 ascending, first Aš'
  check "the page sorted by town" $?
  web text 'Brno|Zlín' --table
  check "text --table prints the header rows once as cols" "$(grep -c '^cols: ' "$OUT" | grep -qx 2 && grep -q '^cols: Population | Area | Population | Area$' "$OUT"; echo $?)"
  check "a row's cells are joined by |" "$(ok '^[0-9]+: Brno \| 700 \| 800 \| 390 \| 230 \| fairs$')"
  check "an empty cell is kept" "$(ok '^[0-9]+: Zlín \| 300 \| 400 \| 75 \| 103 \| ?$')"
  web text 'Brno'
  check "plain text stays one line per row without |" "$(ok '^[0-9]+: Brno 700 800 390 230 fairs$')"
  web text 'Thursday|Friday' --table
  check "an ARIA grid's header row prints as cols" "$(ok '^cols: Day \| Rain \| Wind$')"
  check "its rows by role, an empty cell kept" "$(ok '^[0-9]+: Thursday \|  ?\| 3 m/s$')"
  check "and a full row" "$(ok '^[0-9]+: Friday \| 1.2 mm \| 5 m/s$')"
}

# Duplicate matches: an off-canvas twin, a modal's field against the header's, rows that still list, an exact text line.
case_twins() {
  open twins
  web click 'Show all filters'
  check "of identical twins the one in view is clicked, with a note" "$(ok 'used the one in view')"
  has_text 'clicked: filters-main at'
  check "not the off-canvas copy" $?
  web click '^Add$'
  check "same-named buttons in different rows still list" "$(ok 'elements match' 2)"
  web drag 'A' 'B'
  check "an exact text line beats elements that only contain it" "$(ok 'used the text')"
  has_text 'swapped: B A'
  check "the columns were swapped" $?
  web click 'Open the filter dialog'
  web type 'Search filters' 'usb'
  check "the field in the open dialog wins" "$(ok 'used the one in the open dialog')"
  has_text 'typed in modal-search: usb'
  check "the page saw the dialog's field" $?
  web click '^Close$'
}

# Changes that keep the page's text: a drag that swaps two columns, a sort, an option marked selected (in place, and in a list
# drawn again), and the focus a key moves. None may say "nothing happened".
case_reorder() {
  open reorder
  web drag '^Alpha$' '^Beta$'
  check "a drag that swaps two columns is a change" "$(ok 'order changed \(lines [0-9]+-[0-9]+\), now:')"
  check "the range shows Beta first now" "$(grep -A2 'order changed' "$OUT" | sed -n 2p | grep -q 'Beta'; echo $?)"
  check "not nothing happened" "$(no 'nothing happened')"
  web click 'Sort the fruit'
  check "a sort is a change" "$(ok 'order changed \(lines [0-9]+-[0-9]+\), now:')"
  check "the range reads in its new order" "$(grep -A4 'order changed' "$OUT" | tr '\n' ' ' | grep -Eq 'Apple.*Cherry.*Mango.*Plum'; echo $?)"
  check "not nothing happened" "$(no 'nothing happened')"
  web click '^bug$'
  check "an option marked selected in place prints its state" "$(ok 'option "bug": selected false -> true')"
  check "not nothing happened" "$(no 'nothing happened')"
  web click '^docs$'
  check "an option in a list drawn again is found by role and name" "$(ok 'option "docs": selected false -> true')"
  check "and the answer says the page drew it again" "$(ok 'the page drew it again: now \[e[0-9]+\] option "docs" selected')"
  check "not nothing happened" "$(no 'nothing happened')"
  web click 'First name'
  web key Tab
  check "key prints the element that took the focus" "$(ok '^focus: \[e[0-9]+\] textbox "Last name"')"
  check "not nothing happened" "$(no 'nothing happened')"
}

# A page of a line or two and no field may be an error or block page; a short page with a search box is a page to use.
case_empty() {
  open empty
  check "a nearly empty page is flagged" "$(ok '^page shows almost no text \(1 line, no form field\): an error or block page, or a picture-only one; look with desktop-shot$')"
  open onebox
  check "a one-line page with a search box stays clean" "$(no 'almost no text')"
  open heading-button
  check "a page of a heading and a button stays clean" "$(no 'almost no text')"
}

# open hands the URL to the address bar by paste: an encoded space must come back as %20, not %2B or a space.
case_urlencode() {
  web open "$BASE/query.html?q=a%20b"
  check "open loads the page" "$(ok 'search=\?q=a%20b')"
  web url
  check "url keeps %20" "$(ok 'q=a%20b')"
  check "url has no %2B or +" "$(no 'q=a(%2B|\+)b')"
}

# A first open that outlasts the caller's timeout (the harness kills the CLI) must not strand the launch: the next call waits for
# it, and an open that cannot finish in time says so and exits non-zero (75) with the launch still going.
case_coldstart() {
  local st=${PI_DESKTOP_STATE:-/tmp/pi-desktop}
  cold() { pkill -f chrome-profile 2>/dev/null; sleep 2; rm -f "$st"/cdp-port "$st"/launch.pid "$st"/launch.exit; }
  cold
  PI_DESKTOP_OPEN_WAIT_MS=1500 web open "$BASE/onebox.html?n=$RANDOM"
  check "a slow launch exits 75" "$(ok 'still starting' 75)"
  check "and says to run the same command again" "$(ok 'run the same desktop-web command again' 75)"
  web open "$BASE/onebox.html?n=$RANDOM"
  check "run again: waits for the launch in progress and loads the page" "$(ok '^url: .*onebox')"
  cold
  timeout 4 desktop-web open "$BASE/onebox.html?n=$RANDOM" >"$OUT" 2>&1
  check "the caller's timeout killed the CLI" "$([[ $? == 124 ]]; echo $?)"
  web open "$BASE/onebox.html?n=$RANDOM"
  check "after a killed open the next open resumes" "$(ok '^url: .*onebox')"
  check "one Chrome, not two" "$([[ $(pgrep -af 'chrome.*chrome-profile' | grep -o 'remote-debugging-port=[0-9]*' | sort -u | wc -l) == 1 ]]; echo $?)"
}

# A dialog that slides in after it shows: its Close button is clicked where it ends up, in a chain right after the opening.
case_slide() {
  open slide
  timeout "$WAIT" bash -c "desktop-web click 'Open the panel' && desktop-web click '^Close\$'" >"$OUT" 2>&1
  RC=$?
  sed 's/^/    | /' "$OUT"
  check "the chain ran" "$([[ $RC == 0 ]]; echo $?)"
  has_text 'clicked: close at'
  check "the Close button took the click while the dialog slid" $?
}

# A search that finds nothing points to closed menus that may hold it, icon-only menus first; nothing is opened.
case_menu() {
  open menu
  web snap 'Sort'
  check "snap with no match points to closed menus" "$(ok 'closed menus that may hold it:')"
  check "the icon-only menu comes first" "$(grep -A1 'closed menus' "$OUT" | grep -q 'button "More list controls" expanded=false'; echo $?)"
  check "nothing was opened" "$(no 'Sort by newest')"
  web click 'Sort'
  check "a click with no match points there too" "$(ok 'closed menus that may hold it:' 1)"
  web text 'Sort'
  check "and text" "$(ok 'closed menus that may hold it:')"
  web click 'More list controls'
  web click 'newest'
  has_text 'sorted: newest'
  check "the item in the opened menu is clicked" $?
}

case_form() {
  open form
  web snap 'Email|Phone|Zip'
  check "a required field is marked" "$(ok 'textbox "Email".* required')"
  check "an invalid field shows its error text" "$(ok 'textbox "Phone".* invalid.* desc="Enter a valid phone number"')"
  web click 'Send form'
  check "a new alert's text is named" "$(ok 'alert "Email is required"')"
  web click 'Check zip'
  check "when nothing else changed the invalid fields are listed" "$(ok 'invalid fields:.*Zip code')"
}

case_stale() {
  open stale
  web snap 'Item B'
  local ref
  ref=$(grep -o '\[e[0-9]*\] button "Item B"' "$OUT" | grep -o 'e[0-9]*' | head -1)
  web click '^Rebuild list$'
  has_text 'round 2'
  check "the list was drawn again" $?
  web click "$ref"
  check "a replaced element is found again by its role and name" "$(ok 'is gone .*using e[0-9]*')"
  has_text 'clicked: item-b at'
  check "and clicked" $?
}

case_slider() {
  open slider
  web snap slider
  check "snap lists a native range with its value and range" "$(ok 'slider "Volume" value=25 min=0 max=100')"
  check "and an ARIA slider" "$(ok 'slider "Rating" value=2 min=0 max=10')"
  check "an unnamed range is named by its row" "$(ok 'slider "" near "Opacity of the overlay" value=3 min=0 max=10')"
  web type Volume 75
  check "type sets a native range (step 1) and reads it back" "$(ok 'slider "Volume": value 25 -> 75')"
  has_text 'volume: 75'
  check "the page saw the value" $?
  web type Brightness 73
  check "a range with step 5 ends on the nearest step" "$(ok 'slider "Brightness": value 50 -> 75')"
  check "and says so" "$(ok '73 is between its steps of 5: 75 is the nearest')"
  has_text 'bright: 75$'
  check "the page saw the step value" $?
  web type Rating 7
  check "type sets an ARIA slider by dragging its thumb" "$(ok 'slider "Rating": value 2 -> 7')"
  has_text 'rating: 7 \(pointer\)$'
  check "the page saw the pointer move it" $?
  web type Opacity 9
  check "an unnamed range is set by its row text" "$(ok 'value 3 -> 9')"
  web type Volume 150
  check "a value out of range is refused" "$(ok 'takes 0 to 100' 64)"
}

case_upload() {
  local file=$WORK/upload-me.txt
  printf 'hello' >"$file"
  open upload
  web snap 'Resume|photo'
  check "snap marks a file input" "$(ok 'button "Resume".*file input: desktop-web upload')"
  web type Resume x
  check "type on a file input is refused" "$(ok 'takes a file, not text' 64)"
  web url
  check "and opened no chooser" "$(no 'file chooser')"
  web upload Resume "$file"
  check "upload picks the file and reads the input back" "$(ok 'file input now holds: "upload-me.txt"')"
  has_text 'uploaded resume: upload-me.txt 5 bytes'
  check "the page got the file" $?
  web click '^Choose photo$'
  check "a click that opens the chooser says so" "$(ok 'A file chooser is open')"
  web click '^Resume$'
  check "actions are refused while it is open" "$(ok 'file chooser is open' 3)"
  web snap photo
  check "reads go on with the notice" "$(ok 'A file chooser is open')"
  check "and the listing" "$(ok 'button "Choose photo"')"
  web key Escape
  check "Escape cancels it" "$(ok 'file chooser closed')"
  web upload '^Choose photo$' "$file"
  check "upload through a button that opens a hidden input" "$(ok 'file input now holds: "upload-me.txt"')"
  has_text 'uploaded photo: upload-me.txt 5 bytes'
  check "the page got the photo" $?
  web upload Resume /nonexistent/file.txt
  check "a missing file is refused before any click" "$(ok 'no file' 64)"
}

case_drag() {
  open drag
  web drag 'Move me' --by 120,0
  check "a pointer drag by px" "$(ok 'moved: handle by 120,0$')"
  web drag 'Move me' '^Bin$'
  check "a pointer drag onto a target" "$(ok 'into bin')"
  web drag 'Card one' 'Drop here'
  check "an HTML5 drag starts" "$(ok 'dragstart: card')"
  check "and drops on the target" "$(ok 'dropped: card on target')"
  web drag 'no such thing' '^Bin$'
  check "a source that is not there is refused" "$([[ $RC != 0 ]]; echo $?)"
}

# The managed policy hides the "unsupported command-line flag" infobar that --no-sandbox brings: Chrome's own window, read
# through its accessibility tree, must not hold it.
case_infobar() {
  open spacing
  local tree
  tree=$(timeout "$WAIT" agent-desktop-run snapshot --app chrome --timeout-ms 5000 2>/dev/null)
  check "the browser's accessibility tree was read" "$(grep -q '"ok":true' <<<"$tree"; echo $?)"
  check "no command-line flag infobar" "$(grep -qi 'unsupported command-line flag' <<<"$tree"; [[ $? == 1 ]]; echo $?)"
}

# A control's own decoration (a sibling's or a label's ::before over the input) takes its click; a dialog in front does not.
case_decor() {
  open custom
  web click 'DisplayPort'
  check "a sibling's ::before over the input is the control's own" "$(ok 'checkbox "DisplayPort": checked false -> true')"
  has_text 'checked: dp true'
  check "the page saw it" $?
  web click 'USB-C'
  check "a for= label's ::before over the input is the control's own" "$(ok 'checked false -> true')"
  has_text 'checked: usbc true'
  check "the page saw the label's click" $?
  web click '^Open notice$'
  web click 'DisplayPort'
  check "a click under a modal is still refused" "$(ok 'covers' 1)"
  check "the refusal names the dialog" "$(ok 'the dialog "Notice" is in front' 1)"
  check "and says to run the rest of the chain again" "$(ok 'run the rest of the chain again' 1)"
  has_text 'checked: dp false'
  check "the covered checkbox was not touched" "$([[ $? != 0 ]]; echo $?)"
  web click '^Close notice$'
  check "the dialog's button closes it" "$(ok 'closed dialog "Notice"')"
}

# An unnamed combobox is named by the text beside it; select takes only its own options, never a menu elsewhere.
case_dropdown() {
  open dropdown
  web snap 'combobox'
  check "an unnamed combobox shows the label beside it" "$(ok 'combobox "" label "Category"')"
  check "a label above a field names it" "$(ok 'combobox "".*Subjects')"
  check "class words are a last resort" "$(no 'gx7q2|subjects-auto-complete')"
  web select 'Sort by' 'lowest'
  check "select scopes to the options that appeared (no roles), not the menu" "$(ok 'clicked option "Price: lowest first"')"
  has_text 'sort: price_asc'
  check "the page saw the pick" $?
  web select 'Sort by' 'No such order'
  check "an option that is not there is refused" "$(ok 'no option matches' 2)"
  check "and lists only this dropdown's options" "$(grep -q 'Newest' "$OUT" && ! grep -q 'Laptops' "$OUT"; echo $?)"
  has_text 'sort list closed'
  check "the popup was closed with Escape" $?
  web select 'Order' 'newest'
  check "a floating label names a combobox, and a role-less list in a listbox is its options" "$(ok 'clicked option "Newest first"')"
  has_text 'order: Newest first'
  check "the page saw that pick" $?
  web click 'Subjects'
  check "a click that opens options lists them with refs" "$(ok '^  \[e[0-9]+\] option "Maths"')"
  web shot 'Sort by' --pad 20
  check "shot aims at any visible text" "$(ok 'shot of .*Sort by')"
}

# What acting on a form says: nothing happened (twice: stop), a date-like field's Enter, two matching fields, a form without
# a button, clearing a field, and an address that changes only its query.
case_acting() {
  open acting
  web click '^Continue$'
  check "a dead button says nothing happened" "$(ok 'nothing happened \(no text, state, dialog or address change\)')"
  check "not that the result may come later" "$(no 'result may come later')"
  check "it lists the required empty field" "$(ok 'required and empty: .*Email')"
  check "and how to look at it" "$(ok 'desktop-web shot e[0-9]+')"
  web click '^Continue$'
  check "the same no-op twice says to stop" "$(ok 'this control does nothing here; stop clicking it')"
  web type 'Date of birth' '03/15/2027' --enter
  check "type --enter sets a date-like field" "$(ok 'value now: "03/15/2027"')"
  check "and counts its own value change" "$(no 'nothing happened|result may come later')"
  web type 'Search' 'London'
  check "of two matching fields the one outside the header is typed into" "$(ok 'used the one outside the page.s header and navigation')"
  has_text 'filter: London'
  check "the page saw it" $?
  web type 'Note' ''
  check 'type "" clears a field' "$(ok 'value now: ""')"
  web type 'From' 'Lisbon'
  check "a form without a button says to use --enter" "$(ok 'no submit button in its form: use --enter')"
  web type 'To' 'Porto' --enter
  check "a query change that keeps the page prints what changed" "$(ok '^route: Lisbon -> Porto$')"
  check "not an outline" "$(no 'outline')"
  web click '^Sort by price$'
  check "a link that changes the query prints the diff" "$(ok '^sorted by price$')"
  check "not an outline either" "$(no 'outline')"
}

# Two multi-selects share "Red": a pick adds a line already on the page and a second "Remove Red" button; End scrolls.
case_chips() {
  open chips
  web select 'Multi Select' 'Red'
  check "a pick in a multi-select prints the chip's remove button" "$(ok 'appeared: \[e[0-9]+\] button "Remove Red"')"
  check "and the line already shown in the other list" "$(ok '^Red$')"
  check "not that nothing happened" "$(no 'nothing happened')"
  has_text 'picked: Red in Multi Select'
  check "the page saw the pick" $?
  open chips
  web key End
  check "End on a long page says how far it scrolled" "$(ok 'scrolled 0 -> [1-9][0-9]* of [0-9]+ px')"
  check "which is a change" "$(no 'nothing happened')"
}

# TodoMVC-style rows: an opacity-0 toggle per row without a label, and a label renamed on double click (delegated listeners).
case_todos() {
  open todos
  web snap 'Toggle'
  check "an opacity-0 toggle without a label is listed, by its row" "$(ok 'checkbox "Toggle Todo" near "write report" checked=false')"
  web click 'Toggle' --near 'write report'
  check "it is clicked on its own box" "$(ok 'checkbox "Toggle Todo": checked false -> true')"
  has_text 'toggled: write report true'
  check "the page saw that row's toggle" $?
  web click 'buy milk'
  check "plain click falls back to the one line of plain text, and says so" "$(ok 'clicked the plain text')"
  web click --double 'call mom'
  check "--double edits a label: the field appears focused" "$(ok 'appeared: \[e[0-9]+\] textbox .*value="call mom" focused')"
  local ref
  ref=$(grep -oE 'appeared: \[e[0-9]+\] textbox' "$OUT" | grep -oE 'e[0-9]+' | head -1)
  web type "${ref:-none}" 'call dad' --enter
  check "type --enter renames it" "$(ok 'value now: "call dad"')"
  has_text 'renamed: call mom -> call dad'
  check "the page saw the rename" $?
}

# A jQuery-style range slider: role-less tabindex=0 handles are listed as focusable and move with the arrow keys; tabindex=-1,
# a scroller and a card that holds a link are not listed.
case_handle() {
  open handle
  web snap 'focusable'
  check "a role-less tabindex=0 handle is listed with its class words and row" "$(ok 'focusable ‹ui-slider-handle ui-corner-all› near "[^"]*Price range')"
  check "both handles, nothing else" "$([[ $(grep -c 'focusable' "$OUT") == 2 ]]; echo $?)"
  check "no tabindex=-1 element, scroller or card" "$(no 'script focuses|scrolls inside|A card')"
  local ref
  ref=$(grep -oE '\[e[0-9]+\] focusable' "$OUT" | grep -oE 'e[0-9]+' | head -1)
  web type "${ref:-none}" 80
  check "type refuses a handle and says how to move it" "$(ok 'click it, then desktop-web key' 64)"
  web click "${ref:-none}"
  check "a click focuses it and says the keys move it" "$(ok 'it has the focus: move it with desktop-web key')"
  web key Right
  check "the arrow key moves it" "$(ok 'value "\$75 - \$300" -> "\$80 - \$300"')"
  has_text 'price: \$80 - \$300'
  check "the page saw the key" $?
}

# help [cmd] and <cmd> --help|-h print the detail the skill leaves out; none of them is read as a target (issue #493).
case_help() {
  web help
  check "help lists a line per command" "$(ok '^  open <url>' 0)"
  check "the list names every command" "$([[ $(grep -cE '^  (open|text|snap|click|type|select|upload|drag|hover|wait|key|shot|url|dialogs)\b' "$OUT") == 14 ]]; echo $?)"
  web help hover
  check "help <cmd> prints that command" "$(ok '^desktop-web hover .*--nth N' 0)"
  local first
  first=$(cat "$OUT")
  web hover --help
  check "<cmd> --help prints the same" "$([[ "$(cat "$OUT")" == "$first" && $RC == 0 ]]; echo $?)"
  check "and does not look for a target" "$(no 'nothing clickable|no match')"
  web click -h
  check "-h prints the help too" "$(ok '^desktop-web click ' 0)"
  web help type
  check "type's help holds the slider detail" "$(ok 'value 25 -> 75' 0)"
  web help text
  check "text's help holds --table and --marks" "$(ok '--table +a table row' 0)"
  check "and the marks syntax" "$(ok 'datetime=' 0)"
  web help upload
  check "upload's help says the file chooser rule" "$(ok 'file chooser' 0)"
  web help dialogs
  check "dialogs help says how to answer" "$(ok 'key --text "answer" Return' 0)"
  web help nosuchcmd
  check "an unknown topic exits 64" "$(ok 'no help for' 64)"
}

ALL=(help infobar zoom125 zoom80 hscroll sticky far small modal shadow frames_same frames_cross honeypot spacing dialogs select busy wait hover marks notices errors challenge collapsed shot custom state names form stale slider upload drag decor dropdown acting table twins menu reorder empty slide chips todos handle overlay urlencode coldstart dialog_cap modal_field answers)
CASES=("$@")
[[ ${#CASES[@]} -gt 0 ]] || CASES=("${ALL[@]}")
for _ in $(seq 1 50); do curl -fs "$BASE/zoom.html" >/dev/null 2>&1 && break; sleep 0.2; done
for c in "${CASES[@]}"; do run_case "${c//-/_}"; done

echo
echo "passed $PASS, failed $FAIL"
for f in ${FAILED[@]+"${FAILED[@]}"}; do echo "  FAILED $f"; done
[[ $FAIL == 0 ]]
