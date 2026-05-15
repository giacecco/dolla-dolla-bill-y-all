# Known issues

## Broken pipe during flush_headers (to investigate)

Traceback (truncated — full stack in session "autocompletion", 2026-05-15):

```
Exception occurred during processing of request from ('127.0.0.1', 51402)
Traceback (most recent call last):
  File ".../socketserver.py", line 697, in process_request_thread
    self.finish_request(request, client_address)
  File ".../socketserver.py", line 362, in finish_request
    self.RequestHandlerClass(request, client_address, self)
  File ".../socketserver.py", line 766, in __init__
    self.handle()
  File ".../http/server.py", line 496, in handle
    self.handle_one_request()
  File ".../http/server.py", line 484, in handle_one_request
    method()
  File ".../ddbya", line 699, in do_POST        ← _forward()
  File ".../ddbya", line 520, in _forward        ← _do_forward()
  File ".../ddbya", line 578, in _do_forward     ← end_headers()
  File ".../http/server.py", line 598, in end_headers
    self.flush_headers()
  File ".../http/server.py", line 602, in flush_headers
    self.wfile.write(b"".join(self._headers_buffer))
  File ".../socketserver.py", line 845, in write   ← likely BrokenPipeError
```

Appears to be a client disconnect while the proxy is writing response headers back
to claude. Happens intermittently — need to reproduce and decide whether to catch
`BrokenPipeError` / `ConnectionResetError` in `_do_forward` or suppress it at the
handler level.
