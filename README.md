# Nova Clip

A lightweight game clipper for Windows 10 and 11. It keeps the last few seconds
or minutes of your game in a rolling buffer and saves a clip when you press a
shortcut (F8 by default) or say "Nova, clip that".

## Download

Get **NovaClip.exe** from the newest release on the
[Releases page](https://github.com/novawga/nova-clip/releases/latest) and open
it. Windows may show "Windows protected your PC" because the app isn't
code-signed: click **More info → Run anyway**.

Nova Clip checks this page for new versions when it opens and asks before
installing one, so you only have to download it once.

## What it does

- Records just your game (found automatically), and nothing when no game is running
- Clip length from 5 seconds to 30 minutes
- Clip quality: Light, Balanced or Sharpest, plus full control over resolution,
  frame rate, encoder and bitrate
- Uses your graphics card's encoder (NVIDIA, AMD or Intel) so games keep their
  frame rate
- "Nova, clip that" voice command that learns your voice, runs offline, and
  ignores your speakers
- Themes, including anime character themes with your own background picture

## Checking a download

Each release has `NovaClip.exe.sha256`, the SHA-256 checksum of `NovaClip.exe`.
Nova Clip checks it automatically when it updates itself.

## FFmpeg

Nova Clip includes FFmpeg 8.1.2 (the "essentials" build from
[gyan.dev](https://www.gyan.dev/ffmpeg/builds/)), which is licensed under the
GNU GPL v3. Its source code is available from
[ffmpeg.org](https://ffmpeg.org/download.html) and
[gyan.dev](https://www.gyan.dev/ffmpeg/builds/).
