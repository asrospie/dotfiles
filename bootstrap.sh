#!/usr/bin/env bash
set -euo pipefail

bashrc="$HOME/.bashrc"
source_line='[ -f "$HOME/.aliases" ] && . "$HOME/.aliases"'

if [[ ! -f "$bashrc" ]]; then
    touch "$bashrc"
fi

if ! grep -Fqx "$source_line" "$bashrc" && ! grep -Eq '^[[:space:]]*(source|\.)[[:space:]]+.*(\$HOME/\.aliases|~/\.aliases|/\.aliases)' "$bashrc"; then
    if [[ -s "$bashrc" && "$(tail -c 1 "$bashrc")" != $'\n' ]]; then
        printf '\n' >> "$bashrc"
    fi
    printf '\n# Load personal aliases\n%s\n' "$source_line" >> "$bashrc"
fi
