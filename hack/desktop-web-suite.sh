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
sed -i "s#__SLOW__#http://127.0.0.1:$SPORT#" "$WORK/loading.html"
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
  for line in '145,95 zł' 'alphabeta' 'gamma delta' 'epsilon zeta' 'boldfaceitalic' 'eta theta' 'Distance: 13km\. Time: 0:22\.' \
    'Rating 4\.5 of 5' 'Card lambda' '10 zł' 'Card mu' '20 zł' 'Left column words that wrap' 'Right nu'; do
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
  sed 's/^/    | /' "$OUT"
  check "marks are opt-in" "$(grep -Eq '‹(star-rating|dot|src:)' "$OUT"; [[ $? == 1 ]]; echo $?)"
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
  open challenge
  check "a challenge provider's frame on a short page looks like a bot check" "$(ok '^looks like a bot check \(Cloudflare challenge\)')"
  open loading
  check "a frame that has drawn nothing is still loading" "$(ok 'frame is still loading \(127\.0\.0\.1:')"
}

case_shot() {
  open marks
  web shot 'Alpha book' --pad 50
  local f
  f=$(grep -o '/workspace[^ ]*\.jpg' "$OUT" | head -1)
  check "shot saves an image of the element's area" "$([[ -n $f && -s $f ]]; echo $?)"
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

ALL=(infobar zoom125 zoom80 hscroll sticky far small modal shadow frames_same frames_cross honeypot spacing dialogs select wait hover marks notices shot custom state names form stale slider upload drag)
CASES=("$@")
[[ ${#CASES[@]} -gt 0 ]] || CASES=("${ALL[@]}")
for _ in $(seq 1 50); do curl -fs "$BASE/zoom.html" >/dev/null 2>&1 && break; sleep 0.2; done
for c in "${CASES[@]}"; do run_case "${c//-/_}"; done

echo
echo "passed $PASS, failed $FAIL"
for f in ${FAILED[@]+"${FAILED[@]}"}; do echo "  FAILED $f"; done
[[ $FAIL == 0 ]]
