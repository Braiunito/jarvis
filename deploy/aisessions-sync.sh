#!/bin/sh
# Mantiene fresco el índice de sesiones de cada máquina que Jarvis puede alcanzar.
#
# Cada escaneo es incremental. Un host muerto se acota por separado para que no se coma el turno
# de los demás: es la diferencia entre «goro3 no responde» y «no hay sesiones».

set -u

interval=${JARVIS_SYNC_INTERVAL:-300}
host_timeout=${JARVIS_SYNC_HOST_TIMEOUT:-240}
aisessions_bin=${AISESSIONS_BIN:-aisessions}

case "$interval:$host_timeout" in
  *[!0-9:]*|0:*|*:0)
    printf '%s\n' "aisessions-sync: intervals must be positive seconds" >&2
    exit 2
    ;;
esac

sync_fleet() {
  old_ifs=$IFS
  IFS=,
  for configured_host in ${JARVIS_HOSTS:-bastion}; do
    IFS=$old_ifs
    host=$(printf '%s' "$configured_host" | tr -d '[:space:]')
    if [ -n "$host" ]; then
      printf '%s\n' "aisessions-sync: refreshing $host"
      if ! timeout "$host_timeout" "$aisessions_bin" scan --host "$host"; then
        printf '%s\n' "aisessions-sync: $host failed or exceeded ${host_timeout}s; continuing" >&2
      fi
    fi
    IFS=,
  done
  IFS=$old_ifs
}

while :; do
  sync_fleet
  [ "${JARVIS_SYNC_ONCE:-0}" = 1 ] && exit 0
  sleep "$interval"
done
