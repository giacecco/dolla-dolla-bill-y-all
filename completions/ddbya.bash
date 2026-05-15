# Bash completion for ddbya
#
# Install by sourcing in ~/.bashrc or ~/.bash_profile:
#   source /path/to/dolla-dolla-bill-y-all/completions/ddbya.bash
#
# Or copy into bash_completion.d:
#   cp completions/ddbya.bash /usr/local/etc/bash_completion.d/ddbya

_ddbya() {
    local cur prev words cword cmd
    _init_completion || return

    cmd="${words[0]}"

    case $prev in
        -t|--tag)
            local tags
            tags=$("$cmd" --list-tags 2>/dev/null)
            if [[ -n "$cur" ]]; then
                tags=$(echo "$tags" | grep -i "^$cur" 2>/dev/null || true)
            fi
            COMPREPLY=($(compgen -W "$tags" -- "$cur"))
            return
            ;;
    esac
}

complete -F _ddbya ddbya
