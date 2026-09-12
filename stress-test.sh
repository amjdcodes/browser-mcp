#!/usr/bin/env bash
# 6.14 Stress test: 50 server start/stop cycles, no Chromium leaks, no RSS growth.
#
# The server is launched with a FIFO-held stdin (like a real MCP client that
# keeps stdin open). This bash environment closes stdin for background jobs,
# which would make the server shut down immediately on the stdin-close hook.
set -u
cd /root/browser-mcp

CYCLES=${1:-50}
SLEEP=0.7
STDIN_FIFO=/tmp/browser-mcp-stdin
rm -f "$STDIN_FIFO"
mkfifo "$STDIN_FIFO"

declare -a RSS_ARR
LEAKS=0

echo "=== Cleaning pre-existing Chromium orphans ==="
pkill -9 -f "chromium.*browser-mcp" 2>/dev/null
pkill -9 -f "chromium.*remote-debugging" 2>/dev/null
sleep 1
echo "Chromium before: $(ps aux | grep -c '[c]hromium')"

echo ""
echo "=== Stress test: ${CYCLES} start/stop cycles ==="
for i in $(seq 1 $CYCLES); do
  # FIFO writer holder keeps the server's stdin open; PID tracking is exact.
  (exec 3>"$STDIN_FIFO"; sleep 100) &
  HOLDER=$!
  node index.js < "$STDIN_FIFO" &
  SERVER_PID=$!
  sleep $SLEEP
  RSS=$(awk '/VmRSS/ {print $2}' /proc/$SERVER_PID/status 2>/dev/null || echo 0)
  RSS_ARR[$i]=$RSS
  kill -TERM $SERVER_PID 2>/dev/null
  wait $SERVER_PID 2>/dev/null
  kill $HOLDER 2>/dev/null
  if [ $((i % 10)) -eq 0 ]; then
    echo "  cycle $i: server RSS=${RSS}kB"
  fi
done
rm -f "$STDIN_FIFO"

echo ""
echo "=== Chromium leak check ==="
CHROMIUM_COUNT=$(ps aux | grep -c "[c]hromium")
echo "Chromium processes after $CYCLES cycles: $CHROMIUM_COUNT"
if [ "$CHROMIUM_COUNT" -gt 0 ]; then
  echo "LEAK DETECTED — killing orphans"
  pkill -9 -f "chromium.*browser-mcp" 2>/dev/null
  LEAKS=1
else
  echo "No leaked Chromium processes."
fi

echo ""
echo "=== RSS growth check ==="
FIRST=${RSS_ARR[1]:-0}
LAST=${RSS_ARR[$CYCLES]:-0}
MIN=999999999
MAX=0
ZEROES=0
for v in "${RSS_ARR[@]}"; do
  if [ "$v" -lt "$MIN" ]; then MIN=$v; fi
  if [ "$v" -gt "$MAX" ]; then MAX=$v; fi
  if [ "$v" -eq 0 ]; then ZEROES=$((ZEROES+1)); fi
done
echo "RSS (kB): first=$FIRST last=$LAST min=$MIN max=$MAX (unread: $ZEROES/$CYCLES)"
GROWTH=$((LAST - FIRST))
if [ "$GROWTH" -gt 5120 ]; then
  echo "POSSIBLE MEMORY GROWTH: $((GROWTH/1024)) MB over $CYCLES cycles"
else
  echo "No significant RSS growth (${GROWTH} kB over $CYCLES cycles)."
fi

echo ""
if [ "$LEAKS" -eq 0 ] && [ "$ZEROES" -eq 0 ]; then
  echo "STRESS TEST: PASS (no leaks, no growth, all cycles stayed alive)"
else
  echo "STRESS TEST: see details above"
fi
