// Named Slack channels the UI's channel picker offers. Confirmed IDs (2026-09-24):
// production is jira-agent's existing CHU_SLACK_CHANNEL_ID default; test is the
// automation zip's confirmed test channel.
export const SLACK_CHANNELS = [
  { id: 'C0B86EU1Y03', label: '#jira-automation-test-channel (test)' },
  { id: 'C055ZJ1JTV1', label: '#complaint-handling-us (production)' },
] as const

// Default to the test channel -- jira-agent's schedule feature is running in
// parallel with the existing external automation for now, not replacing it,
// so posts should land somewhere safe to spam by default.
export const DEFAULT_SLACK_CHANNEL = SLACK_CHANNELS[0].id
