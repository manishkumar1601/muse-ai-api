# Accessibility

muse-ai-api is a command-line tool and local API proxy: it has no graphical
interface of its own. This statement covers the parts of the project people
actually interact with — the terminal experience, the login flow, and the
documentation.

## Our commitment

We want the project to be usable by as many people as possible, including
people who rely on screen readers, keyboard-only navigation, or other
assistive technology. Where a barrier is caused by something in this
repository (docs, scripts, CLI output), we treat fixing it as a bug.

## Supported environments

- **Terminal / shell:** the proxy and all helper scripts run in Windows
  PowerShell, bash, and zsh. Output is plain text: no color-only meaning
  (status is always conveyed in words, e.g. `WARNING:`, not just by color),
  no ASCII-art banners, and no interactive prompts that require a mouse.
- **Screen readers:** CLI output is linear text that screen readers can
  follow. Errors are printed as complete sentences on stderr.
- **Documentation:** Markdown throughout, readable in any text editor,
  with descriptive link text and headings in a logical order.

## Known limitations

- **Login requires a graphical browser (for now).** `npm run login` opens a
  Chromium window to authenticate with muse.ai, because the session cookies
  are bound to that browser. This step is not currently completable in a
  text-only or screen-reader-driven terminal. If this blocks you, please
  open an issue — a cookie-import path is a reasonable feature request.
- **Upstream web app:** muse.ai itself is a third-party product; its
  accessibility is outside this project's control.
- **Color in PowerShell helpers:** the helper scripts use `Write-Host`
  colors as decoration only; all information is present in the text.

## Reporting a barrier

If you hit an accessibility barrier in this repository, please open an
issue using the bug report template and mention "accessibility" in the
title, or contact the maintainer (@manishkumar1601) on GitHub. Reports are
welcome even when you're not sure whether the barrier is ours or a tool's —
we'd rather know.
