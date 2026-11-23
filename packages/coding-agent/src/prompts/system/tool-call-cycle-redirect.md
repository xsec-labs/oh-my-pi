<system-interrupt reason="tool_call_cycle_detected">
You are cycling through the same {{period}} tool calls without progress ({{count}} full cycles): {{tool_name}}

Arguments (truncated): `{{arguments_summary}}`
Last results (truncated): `{{result_summary}}`

STOP repeating this sequence. The inputs have not changed, so the outcome will not either. Try a different approach, ask the user for what is missing, or summarize findings and yield if complete.
</system-interrupt>
