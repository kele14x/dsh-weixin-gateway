# Third-party notices

`dsh-weixin-gateway` is MIT-licensed (see `LICENSE`). It adapts protocol
behaviour from Tencent's WeChat channel and bundles one runtime dependency.

## Tencent `openclaw-weixin` — protocol reference (MIT)

- Upstream: <https://github.com/Tencent/openclaw-weixin>
- Protocol notes: <https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md>
- Reference package: `@tencent-weixin/openclaw-weixin` `2.4.10`
- License: MIT

The iLink request format, the eight QR-login states, the header sets, the
`base_info` layout, the message field names, and the `-14` semantics in this
repository are derived from the upstream protocol documentation and client
behaviour. No upstream code is copied wholesale, and OpenClaw is **not** a runtime
dependency: no OpenClaw process is started or required.

Upstream license:

```
Tencent is pleased to support the open source community by making
openclaw-weixin available.

Copyright (C) 2026 Tencent.  All rights reserved.

openclaw-weixin is licensed under the MIT.

Terms of the MIT:

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## `qrcode-terminal` — QR rendering (Apache-2.0)

- Upstream: <https://github.com/gtanner/qrcode-terminal>
- Version: `0.12.0`
- License: Apache License 2.0
- Copyright: Gord Tanner and contributors

Used only by the `login` CLI to render a scannable terminal QR code. It is
loaded lazily; if it cannot be imported, login falls back to printing the QR
payload URL.

The full license text is reproduced in
[`third_party/qrcode-terminal-LICENSE.txt`](third_party/qrcode-terminal-LICENSE.txt).

## Runtime dependency of DSH itself

`@deepseek-ai/schemastery` (`~3.18.5`, MIT) is the configuration schema library
used by DSH and by this plugin. It is a normal dependency; its license ships with
the package.
