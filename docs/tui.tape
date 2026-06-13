# docs/tui.tape — the interactive TUI demo GIF, as code.
#
# Regenerate:  vhs docs/tui.tape   (from the repo root)
#
# The scripted model (ALFRED_MOCK_SCRIPTS) keeps it keyless + deterministic;
# the TUI itself — input box, slash menu, streaming, status line — is real.
# Sandbox/mock prep lives in docs/tape-helpers/tui-setup.sh (vhs Type is
# single-line only).

Output docs/public/tui.gif

Set Shell "bash"
Set FontSize 13
Set Width 1280
Set Height 720
Set Padding 24
Set Framerate 24
Set TypingSpeed 45ms
Set Theme {"name":"alfred","background":"#16161a","foreground":"#c7c7d1","cursor":"#a8b1ff","black":"#1c1c21","red":"#f87171","green":"#4ade80","yellow":"#fbbf24","blue":"#7c88f8","magenta":"#a8b1ff","cyan":"#67e8f9","white":"#e8e8ef","brightBlack":"#71717c","brightRed":"#f87171","brightGreen":"#4ade80","brightYellow":"#fbbf24","brightBlue":"#a8b1ff","brightMagenta":"#c4b5fd","brightCyan":"#a5f3fc","brightWhite":"#ffffff"}

Hide
Type `export PATH="$HOME/.bun/bin:$PATH" && SRC="$PWD/src/index.ts" && DIR="$(bash docs/tape-helpers/tui-setup.sh)" && cd "$DIR" && export ALFRED_MOCK_SCRIPTS=./mock.ts && clear && bun "$SRC"`
Enter
Sleep 3s
Show

Sleep 1.2s
Type "who are you and what do you guarantee?"
Sleep 700ms
Enter
Sleep 4s

Type "/"
Sleep 1.2s
Type "he"
Sleep 1s
Enter
Sleep 2.5s

Type "/exit"
Sleep 800ms
Enter
Sleep 1.5s
