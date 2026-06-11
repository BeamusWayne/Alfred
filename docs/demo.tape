# docs/demo.tape — the README demo GIF, as code.
#
# Regenerate:  vhs docs/demo.tape   (from the repo root)
# Requires:    brew install vhs  (`alfred` resolves to THIS repo's src via a
#               shell function, so the GIF always records the checked-out code)
#
# Everything shown is real: the scripted model (ALFRED_MOCK_SCRIPTS) makes the
# run keyless + deterministic, but the engine, file_write tool, `bun test`
# verify gate and HMAC ledger all execute for real. Same palette as the site.

Output docs/public/demo.gif

Set Shell "bash"
Set FontSize 13
Set Width 1280
Set Height 720
Set Padding 24
Set Framerate 24
Set TypingSpeed 30ms
Set Theme {"name":"alfred","background":"#16161a","foreground":"#c7c7d1","cursor":"#a8b1ff","black":"#1c1c21","red":"#f87171","green":"#4ade80","yellow":"#fbbf24","blue":"#7c88f8","magenta":"#a8b1ff","cyan":"#67e8f9","white":"#e8e8ef","brightBlack":"#71717c","brightRed":"#f87171","brightGreen":"#4ade80","brightYellow":"#fbbf24","brightBlue":"#a8b1ff","brightMagenta":"#c4b5fd","brightCyan":"#a5f3fc","brightWhite":"#ffffff"}

Hide
Type `export PATH="$HOME/.bun/bin:$PATH" && ALFRED_SRC="$PWD/src/index.ts" && alfred() { bun "$ALFRED_SRC" "$@"; } && cd examples/demo && ./reset.sh && export ALFRED_MOCK_SCRIPTS=./scripts.ts && export PS1='❯ ' && clear`
Enter
Sleep 1.5s
Show

Type "# autonomous run — scripted model, REAL verify gate + signed ledger (no API key)"
Enter
Sleep 800ms
Type `alfred run --verify "bun test add.test.ts" --max-features 1`
Sleep 600ms
Enter
Sleep 7s

Type "alfred ledger verify"
Sleep 500ms
Enter
Sleep 3.5s

Type "# try to cheat: flip ONE byte in the receipt"
Enter
Sleep 800ms
Type `sed -i '' 's/"passing"/"PASSING"/' .alfred/workflows/*/ledger.jsonl`
Sleep 500ms
Enter
Sleep 1.5s

Type "alfred ledger verify"
Sleep 500ms
Enter
Sleep 5s
