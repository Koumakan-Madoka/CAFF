$ErrorActionPreference = 'Stop'

# Drain stdin so the runtime can send the full prompt without blocking.
$null = [Console]::In.ReadToEnd()

# NOTE: task name is intentionally hardcoded to match the assertions in
# server-smoke.test.js. If you change the test's expected task name,
# update this value to match.
$taskName = 'pi-tool-smoke'
$prdPath = ".trellis/tasks/$taskName/prd.md"
$prdContent = @"
# PRD: pi tool smoke

## Goal

Verify that a pi-mono agent can call trellis-init and trellis-write through the
chat tool bridge.
"@

node $env:CAFF_CHAT_TOOLS_PATH trellis-init --task $taskName --confirm | Out-Null
$prdContent | node $env:CAFF_CHAT_TOOLS_PATH trellis-write --path $prdPath --content-stdin --confirm --force | Out-Null

$message = @{
  type = 'message_end'
  message = @{
    role = 'assistant'
    content = @(
      @{
        type = 'text'
        text = '{"action":"final"}'
      }
    )
    stopReason = 'stop'
    timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
}

$message | ConvertTo-Json -Depth 8 -Compress
