# LLM calls spawn the `claude` and `codex` CLIs

The tool needs a language model but has no budget line of its own, so it shells
out to the `claude` and `codex` CLIs already installed on the user's machine and
runs on their existing subscriptions. There is no SDK, no API key to store and
no cost beyond what the user already pays. The price is that a spawned CLI
offers no streaming and no tool use, and every structured reply has to be parsed
out of prose.
