$message = @{
  type = 'message_end'
  message = @{
    role = 'assistant'
    content = @(
      @{
        type = 'text'
        text = 'terminal reply'
      }
    )
    stopReason = 'stop'
    timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
}

$message | ConvertTo-Json -Depth 8 -Compress

while ($true) {
  Start-Sleep -Milliseconds 200
}
