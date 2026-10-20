#!/bin/sh
# Aurral Settings controller. Install root-owned at /usr/local/sbin/aurral-service-control.
set -eu
[ "$#" -eq 2 ] || exit 64
feature="$1"
action="$2"
case "$feature:$action" in
  scheduler:enable|scheduler:disable|apple-poc:enable|apple-poc:disable) ;;
  *) echo "Unsupported control action" >&2; exit 64 ;;
esac

if [ "$feature" = "apple-poc" ]; then
  if [ "$action" = "enable" ]; then
    /usr/bin/systemctl enable --now aurral-apple-poc.service
    /usr/bin/systemctl is-active --quiet aurral-apple-poc.service
  else
    /usr/bin/systemctl disable --now aurral-apple-poc.service
    if /usr/bin/systemctl is-active --quiet aurral-apple-poc.service; then exit 1; fi
  fi
  exit 0
fi

envfile=/opt/aurral/aurral.env
[ -f "$envfile" ] && [ ! -L "$envfile" ] || exit 66
value=0
[ "$action" = "enable" ] && value=1
cp -p "$envfile" "$envfile.bak-gui-$(date +%Y%m%d-%H%M%S)"
tmp=$(mktemp "${envfile}.gui.XXXXXXXX")
trap 'rm -f "$tmp"' EXIT HUP INT TERM
awk -v value="$value" '
  /^AURRAL_PROVIDER_SCHEDULER=/ { if (!seen++) print "AURRAL_PROVIDER_SCHEDULER=" value; next }
  { print }
  END { if (!seen) print "AURRAL_PROVIDER_SCHEDULER=" value }
' "$envfile" > "$tmp"
chmod --reference="$envfile" "$tmp"
chown --reference="$envfile" "$tmp"
mv -f "$tmp" "$envfile"
# Restart after the HTTP request can return; state must be verified after reconnect.
/usr/bin/systemd-run --unit="aurral-config-apply-$(date +%s)-$$" --on-active=3s /usr/bin/systemctl restart aurral.service
