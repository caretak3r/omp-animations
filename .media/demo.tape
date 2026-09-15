# VHS tape for the @oh-my-pi/animations README demo GIF.
# Regenerate with: vhs .media/demo.tape
# Requires a prepared sandbox: ./scripts/sandbox-omp.sh prepare (see AGENTS.md).

Output .media/demo.gif

Set Shell bash
Set FontSize 14
Set Width 1500
Set Height 940
Set Padding 24
Set TypingSpeed 35ms
Set Theme "Catppuccin Mocha"
Set CursorBlink false

Hide
Type "env HOME=/tmp/omp-anim-sandbox/home OMP_ANIMATIONS=full omp --cwd /tmp/omp-anim-sandbox/project --model anthropic/claude-haiku-4-5"
Enter
Sleep 4s
Show

Sleep 1s
Type@8ms "Spawn three parallel scout subagents: one lists every file under /tmp/omp-anim-sandbox/home/.omp/plugins/node_modules/@oh-my-pi/animations/src/animations-box, one reads /tmp/omp-anim-sandbox/home/.omp/plugins/node_modules/@oh-my-pi/animations/README.md and summarizes it in exactly one sentence, one runs `bun --version` and reports the output. Then write a one-line note.md summarizing all three results."
Sleep 600ms
Enter

Sleep 45s
