#!/bin/sh
# One line of context, zero interference.
cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"fabel harness active. Commands: /fabel:solve <task>, /fabel:review [ref], /fabel:research <question>, /fabel:verify. Read the fabel:doctrine skill before nontrivial engineering tasks."}}
EOF
exit 0
