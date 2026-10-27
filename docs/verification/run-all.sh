#!/usr/bin/env bash
# Reproduces every automated check in docs/verification.md.
# Usage: bash docs/verification/run-all.sh
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
IDE="/Applications/IntelliJ IDEA.app/Contents"
OUT="$REPO/docs/verification/output"
KOTLIN_STDLIB="$(find ~/.gradle/caches/modules-2 -name 'kotlin-stdlib-2.4.10.jar' | head -1)"
CP="$REPO/idea-plugin/build/classes/kotlin/main:$KOTLIN_STDLIB"
mkdir -p "$OUT" /tmp/verify-tools

echo "### 1. clean build + tests"
(cd "$REPO/idea-plugin" && ./gradlew clean test buildPlugin --console=plain --no-daemon \
  -PlocalIdePath="$IDE" > "$OUT/build.txt" 2>&1; echo "exit=$?" >> "$OUT/build.txt")
tail -2 "$OUT/build.txt"

echo "### 2. plugin artifact"
ZIP="$(ls "$REPO"/idea-plugin/build/distributions/dsh-idea-plugin-*.zip 2>/dev/null | head -1)"
unzip -l "$ZIP" > "$OUT/distribution-zip.txt" 2>&1
rm -rf /tmp/verify-jar && mkdir -p /tmp/verify-jar
(cd /tmp/verify-jar && unzip -q "$ZIP" && unzip -l dsh-idea-plugin/lib/dsh-idea-plugin-*.jar) > "$OUT/plugin-jar.txt" 2>&1

echo "### 3. real IDEA-side payloads (compiled Kotlin, no IDE needed)"
javac -nowarn -cp "$CP" -d /tmp/verify-tools "$REPO/docs/verification/tools/IdeaPayloadEmitter.java"
NOW="$(python3 -c 'import time;print(int(time.time()*1000))')"
java -cp "/tmp/verify-tools:$CP" IdeaPayloadEmitter "11111111-2222-3333-4444-555555555555" "$NOW" \
  /Users/liyang/IdeaProjects/foo /Users/liyang/IdeaProjects/foo/src/Bar.kt kotlin 10 20 true > "$OUT/payload-selection.json"
java -cp "/tmp/verify-tools:$CP" IdeaPayloadEmitter "22222222-2222-3333-4444-555555555555" "$NOW" \
  /Users/liyang/IdeaProjects/foo /Users/liyang/IdeaProjects/foo/src/Bar.kt kotlin 0 0 true > "$OUT/payload-wholefile.json"
java -cp "/tmp/verify-tools:$CP" IdeaPayloadEmitter "33333333-2222-3333-4444-555555555555" "$NOW" - \
  "/Users/liyang/项目/文件.kt" - 7 7 false > "$OUT/payload-nonascii-noproject.json"
cat "$OUT"/payload-*.json

echo "### 4. host half end to end (stub cordis context)"
for f in payload-selection payload-wholefile payload-nonascii-noproject; do
  node "$REPO/docs/verification/host-half.test.mjs" "$OUT/$f.json" > "$OUT/host-half-$f.txt" 2>&1
  echo "$f: $(tail -1 "$OUT/host-half-$f.txt")"
done

echo "### 5. client half end to end (stub React, virtual clock, real host routes)"
node "$REPO/docs/verification/client-half.test.mjs" "$OUT/payload-selection.json" > "$OUT/client-half.txt" 2>&1
tail -3 "$OUT/client-half.txt"

echo "### 5b. adversarial claim single-flight (v1.1)"
node "$REPO/docs/verification/claim-adversarial.test.mjs" "$OUT/payload-selection.json" > "$OUT/claim-adversarial.txt" 2>&1
tail -2 "$OUT/claim-adversarial.txt"

echo "### 6. atomic handshake write / re-apply stress (was defect D1)"
node "$REPO/docs/verification/tools/repro-reapply.mjs" > "$OUT/repro-reapply.txt" 2>&1
tail -3 "$OUT/repro-reapply.txt"

echo "### 6b. v1.1 client against a v1.0 host (claim route missing)"
node "$REPO/docs/verification/tools/repro-claim-missing.mjs" "$OUT/payload-selection.json" > "$OUT/repro-claim-missing.txt" 2>&1
tail -1 "$OUT/repro-claim-missing.txt"

echo "### 6c. live routes of the user's running DSH (read-only, no cookie)"
{
  # 端口不写死：优先 DSH_PORT=<port> 覆盖，否则从握手文件的 pid 反查它监听的 TCP 端口
  DSH_PID="$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.dsh/idea-bridge/location.json')))['pid'])" 2>/dev/null || true)"
  if [ -z "${DSH_PORT:-}" ] && [ -n "${DSH_PID:-}" ]; then
    DSH_PORT="$(lsof -Pan -p "$DSH_PID" -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {n=$9; sub(/.*:/, "", n); print n; exit}')"
  fi
  DSH_PORT="${DSH_PORT:-61058}"
  echo "port=$DSH_PORT pid=${DSH_PID:-unknown}"
  for p in pending claim ack nope; do
    printf '%-28s %s\n' "/idea-bridge/$p" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$DSH_PORT/idea-bridge/$p" 2>/dev/null || echo '(unreachable)')"
  done
  echo
  cat "$HOME/.dsh/idea-bridge/location.json" 2>/dev/null || echo "(no handshake)"
} > "$OUT/live-dsh.txt" 2>&1
cat "$OUT/live-dsh.txt"

echo "### 7. IDEA-side writability / handshake (real IdeaBridge.send, proxied Application)"
javac -nowarn -cp "$REPO/idea-plugin/build/classes/kotlin/main:$IDE/lib/*:$KOTLIN_STDLIB" -d /tmp/verify-tools \
  "$REPO/docs/verification/tools/IdeaBridgeProbe.java"
export PROBE_PROJECT=/Users/liyang/IdeaProjects/foo PROBE_FILE=/Users/liyang/IdeaProjects/foo/src/Bar.kt
{
  rm -rf /tmp/probe-inbox && mkdir -p /tmp/probe-inbox
  echo "--- writable inbox ---"
  java -cp "/tmp/verify-tools:$REPO/idea-plugin/build/classes/kotlin/main:$IDE/lib/*:$KOTLIN_STDLIB" IdeaBridgeProbe writable /tmp/probe-inbox
  rm -rf /tmp/probe-parent && mkdir -p /tmp/probe-parent && chmod 500 /tmp/probe-parent
  echo "--- unwritable parent ---"
  java -cp "/tmp/verify-tools:$REPO/idea-plugin/build/classes/kotlin/main:$IDE/lib/*:$KOTLIN_STDLIB" IdeaBridgeProbe unwritable /tmp/probe-parent/sub/inbox 2>&1 | grep -v '^	at '
  chmod 700 /tmp/probe-parent
  rm -rf /tmp/probe-home /tmp/probe-real-inbox && mkdir -p /tmp/probe-home/idea-bridge
  python3 -c "import json;json.dump({'version':1,'inboxDir':'/tmp/probe-real-inbox','endpoint':'/idea-bridge/pending','ackEndpoint':'/idea-bridge/ack','pid':1,'updatedAt':1793000000000},open('/tmp/probe-home/idea-bridge/location.json','w'))"
  echo "--- settings override that is not a valid path (resolve only: writes nothing) ---"
  java -cp "/tmp/verify-tools:$REPO/idea-plugin/build/classes/kotlin/main:$IDE/lib/*:$KOTLIN_STDLIB" IdeaBridgeProbe badoverride
  echo "--- unwritable inbox: send() must return ok=false, never throw ---"
  rm -rf /tmp/probe-parent2 && mkdir -p /tmp/probe-parent2 && chmod 500 /tmp/probe-parent2
  java -cp "/tmp/verify-tools:$REPO/idea-plugin/build/classes/kotlin/main:$IDE/lib/*:$KOTLIN_STDLIB" IdeaBridgeProbe unwritable /tmp/probe-parent2/sub/inbox 2>&1 | grep -aE "ok=|error=|THREW"
  chmod 700 /tmp/probe-parent2
  echo "--- caller fallback is structural (javap) ---"
  javap -p -c -cp "$REPO/idea-plugin/build/classes/kotlin/main" com.yg.dsh.idea.ui.actions.SendSelectionAction | grep -c "copyToClipboard" | sed 's/^/copyToClipboard call sites: /'
  javap -p -cp "$REPO/idea-plugin/build/classes/kotlin/main" com.yg.dsh.idea.ui.actions.SendSelectionAction | grep "lambda" | sed 's/^/catch-all lambda: /'
  echo "--- follows location.json inboxDir (DSH_HOME=/tmp/probe-home, resolve only, writes nothing) ---"
  DSH_HOME=/tmp/probe-home java -cp "/tmp/verify-tools:$REPO/idea-plugin/build/classes/kotlin/main:$IDE/lib/*:$KOTLIN_STDLIB" IdeaBridgeProbe resolve
  echo "--- DSH_HOME with a literal ~ : both sides must agree (resolve only, writes nothing) ---"
  DSH_HOME='~/probe-tilde-home' java -cp "/tmp/verify-tools:$REPO/idea-plugin/build/classes/kotlin/main:$IDE/lib/*:$KOTLIN_STDLIB" IdeaBridgeProbe home
  DSH_HOME='~/probe-tilde-home' node "$REPO/docs/verification/tools/host-home-probe.mjs" | sed 's/^/# host: /'
  DSH_HOME='~/probe-tilde-home' java -cp "/tmp/verify-tools:$REPO/idea-plugin/build/classes/kotlin/main:$IDE/lib/*:$KOTLIN_STDLIB" IdeaBridgeProbe resolve
  echo "--- host half, same two DSH_HOME values (node) ---"
  mkdir -p /tmp/probe-home
  DSH_HOME=/tmp/probe-home node "$REPO/docs/verification/tools/host-home-probe.mjs"
  DSH_HOME='~/probe-tilde-home' node "$REPO/docs/verification/tools/host-home-probe.mjs"
  rm -rf "$HOME/probe-tilde-home"
  echo "--- the user's live inbox is untouched by this run ---"
  ls "$HOME/.dsh/idea-bridge/inbox" 2>/dev/null | wc -l | sed 's/^/live inbox files: /'
} > "$OUT/idea-side.txt" 2>&1
cat "$OUT/idea-side.txt"

echo "### 8. reverse checks"
(
  cd "$REPO"
  echo "\$ grep -rn 'DshApiClient|ProcessManager|IdeMcpServer|DshSessionLauncher|PortParser|BrowserManager|JCEF' idea-plugin/src dsh-plugin idea-plugin/build.gradle.kts"
  grep -rn "DshApiClient\|ProcessManager\|IdeMcpServer\|DshSessionLauncher\|PortParser\|BrowserManager\|JCEF" idea-plugin/src dsh-plugin idea-plugin/build.gradle.kts || echo "(no hits in shipped sources)"
  echo
  echo "\$ grep -rn 'ProcessBuilder|Runtime.getRuntime|child_process|spawn(' idea-plugin/src dsh-plugin"
  grep -rn "ProcessBuilder\|Runtime.getRuntime()\|child_process\|spawn(" idea-plugin/src dsh-plugin || echo "(no hits)"
  echo
  echo "\$ grep -rn 'credentials.yaml|/api/' idea-plugin/src dsh-plugin"
  grep -rn "credentials.yaml\|/api/" idea-plugin/src dsh-plugin || echo "(no hits)"
) > "$OUT/reverse-checks.txt" 2>&1
cat "$OUT/reverse-checks.txt"

echo "### 9. verdict"
fail_count="$(grep -a -h -c "^FAIL " "$OUT"/host-half-*.txt "$OUT"/client-half.txt "$OUT"/claim-adversarial.txt "$OUT"/repro-reapply.txt 2>/dev/null | paste -sd+ - | bc)"
defect_count="$(grep -a -h "^DEFECT " "$OUT"/client-half.txt "$OUT"/repro-claim-missing.txt 2>/dev/null | wc -l | tr -d ' ')"
echo "harness assertion failures: ${fail_count:-0}"
echo "product defects flagged by harnesses: ${defect_count:-0}"
grep -a -h "^DEFECT " "$OUT"/client-half.txt "$OUT"/repro-claim-missing.txt 2>/dev/null | sed 's/^/  /'
echo "per-suite summaries:"
grep -a -h "# summary" "$OUT"/host-half-*.txt "$OUT"/client-half.txt "$OUT"/claim-adversarial.txt "$OUT"/repro-reapply.txt 2>/dev/null | sed 's/^/  /'
if [ "${fail_count:-0}" != "0" ]; then echo "VERDICT: FAIL"; exit 1; fi
echo "VERDICT: all harness assertions green${defect_count:+ ($defect_count open product defect(s) flagged)}"
