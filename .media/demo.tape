# VHS tape for the @oh-my-pi/animations README demo GIF.
# Regenerate with: vhs .media/demo.tape
# Requires a prepared sandbox: ./scripts/sandbox-omp.sh prepare (see AGENTS.md).
# FontFamily is a locally installed Nerd Font (Agave Nerd Font Mono) so the
# Audit Box's private-use glyphs (spinner, status dots, chrome icons) render
# as icons instead of tofu boxes — VHS's default font has no glyph coverage
# for them.

Output .media/demo.gif

Set Shell bash
Set FontFamily "Agave Nerd Font Mono"
Set FontSize 14
Set Width 1600
Set Height 1000
Set Padding 24
Set TypingSpeed 35ms
Set Theme "Catppuccin Mocha"
Set CursorBlink false
Set Framerate 60

Hide
Type "env HOME=/tmp/omp-anim-sandbox/home OMP_ANIMATIONS=full omp --cwd /tmp/omp-anim-sandbox/project --model anthropic/claude-haiku-4-5"
Enter
Sleep 4s
Show

Sleep 1s
Type@8ms "Use bash to run `pwd`. Then read README.md and AGENTS.md. Then use the task tool to spawn three parallel scout subagents: East lists every file under /tmp/omp-anim-sandbox/home/.omp/plugins/node_modules/@oh-my-pi/animations/src/animations-box, West reads /tmp/omp-anim-sandbox/home/.omp/plugins/node_modules/@oh-my-pi/animations/CHANGELOG.md and summarizes the latest entry in one sentence, North runs `bun --version` and reports the output. While those run, write a one-line note.md summarizing the plan. Finally reply with one sentence combining all the results."
Sleep 600ms
Enter

Sleep 42s

Type@8ms "Now read package.json and reply with one sentence naming the package."
Sleep 400ms
Enter

Sleep 12s
