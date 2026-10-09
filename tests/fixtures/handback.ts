// The opening of the reminder the engine writes after a subagent's task when it delivers the report through
// SubagentHandback: the words handbackState (hooks/transcript.ts) matches on, and no more of the engine's text.
export const HANDBACK_REMINDER = {
  type: 'text',
  text: '<system-reminder>\nYour final report is delivered through SubagentHandback.\n</system-reminder>',
}
