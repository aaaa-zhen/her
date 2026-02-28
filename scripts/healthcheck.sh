#!/bin/bash
LOG_FILE="/var/log/her-health.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
MAX_WAIT=30
INTERVAL=2

echo "[$TIMESTAMP] Health check started" >> "$LOG_FILE"

for ((i=0; i<MAX_WAIT; i+=INTERVAL)); do
    if curl -sf -o /dev/null http://localhost:3000/ 2>/dev/null; then
        echo "[$TIMESTAMP] Service healthy after ${i}s" >> "$LOG_FILE"
        exit 0
    fi
    sleep "$INTERVAL"
done

echo "[$TIMESTAMP] WARNING: Service not responding after ${MAX_WAIT}s (systemd will handle restart)" >> "$LOG_FILE"
exit 0
