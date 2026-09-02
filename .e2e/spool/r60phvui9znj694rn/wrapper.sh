#!/bin/sh
# jarvis runner v1 — generated, do not edit
set -u
DIR=/home/dev/projects/jarvis/.e2e/spool/r60phvui9znj694rn
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
PID=0

publish() {
  printf '{"version":1,"state":"%s","pid":%s,"startedAt":"%s","finishedAt":%s,"exitCode":%s}\n' \
    "$1" "$PID" "$STARTED" "$2" "$3" > "$DIR/status.json.tmp"
  mv "$DIR/status.json.tmp" "$DIR/status.json"
}

publish running null null

# El agente escribe su stream a events.ndjson; stderr va aparte para no contaminarlo.
( export PATH=$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.bun/bin:$HOME/bin:/usr/local/bin:$PATH; cd /tmp/jarvis-demo/app && claude -p 'averigua por que el pool se queda sin conexiones

[jarvis] Paso 1: mira el estado actual y resume lo que encuentres.' --output-format stream-json --verbose --resume sid-pool --permission-mode plan < /dev/null ) >> "$DIR/events.ndjson" 2>> "$DIR/stderr.log" &
PID=$!
printf '%s\n' "$PID" > "$DIR/pid"
publish running null null

wait "$PID"
CODE=$?
FINISHED=$(date -u +%Y-%m-%dT%H:%M:%SZ)

if [ -f "$DIR/cancel" ]; then
  STATE=cancelled
elif [ "$CODE" -eq 0 ]; then
  STATE=completed
else
  STATE=failed
fi
publish "$STATE" "\"$FINISHED\"" "$CODE"
