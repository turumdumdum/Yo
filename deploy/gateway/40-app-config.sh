#!/bin/sh
# Writes the public addresses into the built frontend. Runs once at container start.
set -eu
case "$PUBLIC_URL" in http://*|https://*) ;; *) echo "PUBLIC_URL must start with http:// or https://" >&2; exit 1 ;; esac
url=${PUBLIC_URL%/}
if ! printf '%s' "$url" | grep -Eq '^https?://[A-Za-z0-9.:-]+$'; then
  echo "PUBLIC_URL must be a bare origin such as https://vendors.example.com" >&2; exit 1
fi
if ! printf '%s' "$ANON_KEY" | grep -Eq '^[A-Za-z0-9._-]+$'; then
  echo "ANON_KEY has unexpected characters" >&2; exit 1
fi
# The anon key is public by design: it only identifies the project; RLS protects the data.
find /usr/share/nginx/html -name '*.js' -exec sed -i \
  -e "s|__APP_SUPABASE_URL__|$url|g" \
  -e "s|__APP_SUPABASE_ANON_KEY__|$ANON_KEY|g" \
  -e "s|__APP_API_URL__|$url/api|g" {} +
