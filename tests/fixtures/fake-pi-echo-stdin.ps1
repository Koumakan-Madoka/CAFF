$stdinText = [Console]::In.ReadToEnd()

$message = @{
  type = 'message_end'
  message = @{
    role = 'assistant'
    content = @(
      @{
        type = 'text'
        text = $stdinText
      }
    )
    stopReason = 'stop'
    timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
}

$message | ConvertTo-Json -Depth 8 -Compress
