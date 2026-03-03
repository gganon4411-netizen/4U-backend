#!/bin/bash
# 4U API Load Test Script
# Simulates concurrent users hitting the API using curl in parallel

BASE_URL="https://4u-backend-production.up.railway.app"
RESULTS_DIR="/tmp/4u-load-test-$$"
mkdir -p "$RESULTS_DIR"

echo "=========================================="
echo "4U API Load Test"
echo "Target: $BASE_URL"
echo "Started: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "=========================================="

START_TIME=$(date +%s)

# Phase 1: 20 concurrent GET /api/requests
echo ""
echo "Phase 1: 20 concurrent GET /api/requests"
for i in $(seq 1 20); do
  (code=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 30 "$BASE_URL/api/requests"); echo "$code" > "$RESULTS_DIR/requests_$i.txt") &
done
wait

# Phase 2: 20 concurrent GET /api/agents
echo "Phase 2: 20 concurrent GET /api/agents"
for i in $(seq 1 20); do
  (code=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 30 "$BASE_URL/api/agents"); echo "$code" > "$RESULTS_DIR/agents_$i.txt") &
done
wait

# Phase 3: 10 concurrent GET /api/sdk/directory
echo "Phase 3: 10 concurrent GET /api/sdk/directory"
for i in $(seq 1 10); do
  (code=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 30 "$BASE_URL/api/sdk/directory"); echo "$code" > "$RESULTS_DIR/sdk_$i.txt") &
done
wait

END_TIME=$(date +%s)
TOTAL_TIME=$((END_TIME - START_TIME))

# Aggregate results
SUCCESS=0
FAIL=0
RATE_LIMITED=0

for f in "$RESULTS_DIR"/*.txt; do
  code=$(cat "$f" 2>/dev/null)
  case "$code" in
    200) ((SUCCESS++)) ;;
    429) ((RATE_LIMITED++)) ;;
    *)   ((FAIL++)) ;;
  esac
done

TOTAL=50

echo ""
echo "=========================================="
echo "LOAD TEST RESULTS"
echo "=========================================="
echo "Total requests:     $TOTAL"
echo "Successful (200):  $SUCCESS"
echo "Rate limited (429): $RATE_LIMITED"
echo "Other failures:    $FAIL"
echo "Total time:        ${TOTAL_TIME}s"
echo "=========================================="
echo "Completed: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"

# Cleanup
rm -rf "$RESULTS_DIR"

# Exit with error if any failures
if [ "$FAIL" -gt 0 ] || [ "$RATE_LIMITED" -gt 0 ]; then
  exit 1
fi
exit 0
