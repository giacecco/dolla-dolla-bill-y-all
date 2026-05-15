# Bash completion for ddbya-report
#
# Install by sourcing in ~/.bashrc or ~/.bash_profile:
#   source /path/to/dolla-dolla-bill-y-all/completions/ddbya-report.bash
#
# Or copy into bash_completion.d:
#   cp completions/ddbya-report.bash /usr/local/etc/bash_completion.d/ddbya-report

_ddbya_report() {
    local cur prev words cword
    _init_completion || return

    case $prev in
        -t|--tag)
            local tags
            tags=$(ddbya --list-tags 2>/dev/null)
            if [[ -n "$cur" ]]; then
                tags=$(echo "$tags" | grep -i "^$cur" 2>/dev/null || true)
            fi
            COMPREPLY=($(compgen -W "$tags" -- "$cur"))
            return
            ;;
    esac
}

complete -F _ddbya_report ddbya-report
