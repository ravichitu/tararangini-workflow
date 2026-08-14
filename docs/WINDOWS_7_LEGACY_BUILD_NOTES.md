# Windows 7 Legacy Build Notes

This build uses Electron 22.3.27 because newer Electron versions do not support Windows 7.

Use this build only for local shop/intranet operation. Do not expose a Windows 7 host directly to the public internet.

Artifacts:
- `dist/Tarangini Workflow Suite Setup 1.1.0.exe` is a combined legacy installer for x64 and ia32 Windows.
- `dist/Tarangini Workflow Suite-1.1.0-win.zip` is the x64 portable ZIP.
- `dist/Tarangini Workflow Suite-1.1.0-ia32-win.zip` is the 32-bit portable ZIP.

Windows 7 requirements:
- Prefer Windows 7 SP1.
- Install the latest possible Windows 7 updates, especially SHA-2 code-signing support.
- If the PC is 32-bit, use the ia32 ZIP or the combined setup installer.
- Keep this machine behind the router/firewall and use local network access only.

Security note:
- Electron 22 is old and carries higher security risk than the modern Electron 42 build.
- For internet-facing use, run Tarangini on Windows 10/11 or a secured server with HTTPS/VPN.
